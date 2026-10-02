import { validateForRelease } from '../models/contract';
import type { ApiContract } from '../models/contract';
import {
  planBatch,
  type BatchBlocker,
  type BatchConflict,
  type BatchEntry,
  type ReleaseBatch,
} from '../models/batch';
import {
  buildFrozenContract,
  loadContracts,
  storeContracts,
} from './contract-service';

const BATCH_STORAGE_KEY = 'pair-wise-gsb-70-release-batches';
const LOCK_KEY = 'pair-wise-gsb-70-batch-lock';
const LOCK_TTL_MS = 15_000;
const STEP_DELAY_MS = 120;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function suggestVersion(current: string): string {
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return current;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function loadBatches(): ReleaseBatch[] {
  const stored = localStorage.getItem(BATCH_STORAGE_KEY);
  if (!stored) return [];
  try {
    return JSON.parse(stored) as ReleaseBatch[];
  } catch {
    localStorage.removeItem(BATCH_STORAGE_KEY);
    return [];
  }
}

function saveBatches(batches: ReleaseBatch[]): void {
  localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(batches));
}

export async function listBatches(): Promise<ReleaseBatch[]> {
  await delay(160);
  return clone(loadBatches().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
}

/**
 * 跨标签页互斥锁：同一时间只允许一个标签页推进冻结，
 * 避免两个标签页交叉写入造成“版本只写一半”。
 */
async function acquireLock(batchId: string): Promise<() => void> {
  const token = `${batchId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const raw = localStorage.getItem(LOCK_KEY);
    if (!raw || Date.now() - JSON.parse(raw).at > LOCK_TTL_MS) {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ token, at: Date.now() }));
      // 再读一次，防止两个标签页同时抢到
      const winner = localStorage.getItem(LOCK_KEY);
      if (winner && JSON.parse(winner).token === token) {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          const current = localStorage.getItem(LOCK_KEY);
          if (current && JSON.parse(current).token === token) {
            localStorage.removeItem(LOCK_KEY);
          }
        };
      }
    }
    await delay(60);
  }
  throw new Error('另一个标签页正在确认该批次，请稍后刷新再试。');
}

function buildEntries(
  contracts: ApiContract[],
  order: string[],
  existing?: ReleaseBatch['entries'],
): BatchEntry[] {
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  const previous = new Map((existing ?? []).map((entry) => [entry.contractId, entry]));
  return order.map((contractId, index) => {
    const contract = byId.get(contractId);
    const old = previous.get(contractId);
    const base: BatchEntry = {
      contractId,
      order: index,
      targetVersion: old?.targetVersion ?? suggestVersion(contract?.version ?? '1.0.0'),
      notes: old?.notes ?? '',
      status: old?.status === 'frozen' ? 'frozen' : 'todo',
      fromRevision: contract?.revision ?? 0,
      detail: undefined,
      issues: undefined,
      snapshotId: old?.snapshotId,
      frozenVersion: old?.frozenVersion,
      frozenAt: old?.frozenAt,
      external: old?.external,
    };
    if (base.status !== 'frozen') {
      base.detail = undefined;
      base.issues = undefined;
    }
    return base;
  });
}

export interface CreateBatchInput {
  label: string;
  contractIds: string[];
}

export async function createBatch(input: CreateBatchInput): Promise<ReleaseBatch> {
  await delay(160);
  const contracts = loadContracts();
  const now = new Date().toISOString();
  const plan = planBatch(contracts, input.contractIds);
  const batch: ReleaseBatch = {
    id: `batch-${Date.now()}`,
    label: input.label.trim() || `发布批次 ${new Date().toLocaleString('zh-CN')}`,
    createdAt: now,
    updatedAt: now,
    status: plan.blockers.length ? 'blocked' : 'todo',
    entries: buildEntries(contracts, plan.order),
    blockers: plan.blockers,
  };
  saveBatches([batch, ...loadBatches()]);
  return clone(batch);
}

export interface ReplanResult {
  batch: ReleaseBatch;
  newOrder: string[];
}

/**
 * 按当前调用关系与各契约最新修订号重走规划：
 * - 草稿（目标版本、发布说明）原样保留，已冻结的快照不重复生成；
 * - 另一标签页先冻结的契约对齐为外部冻结；
 * - 重算拓扑次序、环与前置待核阻塞。
 */
export async function replanBatch(batchId: string): Promise<ReplanResult> {
  const result = replanBatchInternal(batchId);
  await delay(120);
  return result;
}

function replanBatchInternal(batchId: string): ReplanResult {
  const contracts = loadContracts();
  const batches = loadBatches();
  const batch = batches.find((item) => item.id === batchId);
  if (!batch) throw new Error('批次不存在，可能已被另一标签页删除。');

  const latestById = new Map(contracts.map((contract) => [contract.id, contract]));
  const existing = batch.entries.map((entry) => {
    const current = latestById.get(entry.contractId);
    const frozenByOther =
      current?.status === 'frozen' &&
      current.revision !== entry.fromRevision &&
      entry.status !== 'frozen';
    if (frozenByOther && current) {
      const snapshot = current.versions[0];
      return {
        ...entry,
        status: 'frozen' as const,
        external: true,
        frozenVersion: snapshot.version,
        snapshotId: snapshot.id,
        frozenAt: snapshot.releasedAt,
        detail: undefined,
        issues: undefined,
      };
    }
    return entry;
  });

  const frozenIds = existing.filter((entry) => entry.status === 'frozen').map((e) => e.contractId);
  const todoIds = existing.filter((entry) => entry.status !== 'frozen').map((e) => e.contractId);
  const plan = planBatch(contracts, todoIds.length ? todoIds : frozenIds);

  // 已冻结项保留原落库位置；待办项在其后按新次序排列（冻结项天然先于待办）
  const frozenEntries = existing
    .filter((entry) => entry.status === 'frozen')
    .sort((a, b) => a.order - b.order);
  const todoEntries = buildEntries(contracts, plan.order, existing);
  const merged = [...frozenEntries, ...todoEntries].map((entry, index) => ({
    ...entry,
    order: index,
  }));

  // 批次外前置阻塞同时考虑已经冻结掉的项（已冻结不再被挡）
  const blockers = plan.blockers.filter((blocker) => {
    if (blocker.type === 'pending_prerequisite' && frozenIds.includes(blocker.toContractId)) {
      return false;
    }
    return true;
  });

  const updated: ReleaseBatch = {
    ...batch,
    status: blockers.length ? 'blocked' : merged.every((e) => e.status === 'frozen') ? 'done' : 'todo',
    entries: merged,
    blockers,
    conflicts: undefined,
    conflictAt: undefined,
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  };
  saveBatches(batches.map((item) => (item.id === batchId ? updated : item)));
  return { batch: clone(updated), newOrder: plan.order };
}

export async function updateDraft(
  batchId: string,
  contractId: string,
  patch: Pick<BatchEntry, 'targetVersion' | 'notes'>,
): Promise<ReleaseBatch> {
  const batches = loadBatches();
  const batch = batches.find((item) => item.id === batchId);
  if (!batch) throw new Error('批次不存在');
  const updated: ReleaseBatch = {
    ...batch,
    updatedAt: new Date().toISOString(),
    entries: batch.entries.map((entry) =>
      entry.contractId === contractId && entry.status !== 'frozen'
        ? { ...entry, ...patch }
        : entry,
    ),
  };
  saveBatches(batches.map((item) => (item.id === batchId ? updated : item)));
  return clone(updated);
}

export async function deleteBatch(batchId: string): Promise<void> {
  saveBatches(loadBatches().filter((batch) => batch.id !== batchId));
  await delay(100);
}

export interface ConfirmResult {
  outcome: 'done' | 'partial' | 'blocked' | 'conflict';
  batch: ReleaseBatch;
}

interface DetectResult {
  conflicts: BatchConflict[];
  aligned: BatchEntry[];
}

/**
 * 把发起标签页手中草稿的待办目标版本/发布说明合入存储基座，
 * 保证冲突对齐后用户草稿仍在。
 */
function mergeDraft(stored: ReleaseBatch, draft?: ReleaseBatch): ReleaseBatch {
  if (!draft) return stored;
  const draftById = new Map(draft.entries.map((entry) => [entry.contractId, entry]));
  return {
    ...stored,
    entries: stored.entries.map((entry) => {
      if (entry.status === 'frozen') return entry;
      const mine = draftById.get(entry.contractId);
      return mine
        ? { ...entry, targetVersion: mine.targetVersion, notes: mine.notes }
        : entry;
    }),
  };
}

/**
 * 乐观并发核对：逐份比对手中草稿基线修订号与最新契约。
 * 后确认者只会看到对方版本与冲突项，草稿不动、不写任何快照。
 *
 * `batch` 是发起方标签页手中的草稿批次（可能停留在冻结前状态），
 * 不是存储里的最新版本——这正是跨标签页能检出冲突的原因。
 */
export function detectBatchConflicts(
  batch: ReleaseBatch,
  contracts: ApiContract[],
): DetectResult {
  const conflicts: BatchConflict[] = [];
  const aligned = batch.entries.map((entry) => {
    const current = contracts.find((contract) => contract.id === entry.contractId);
    if (!current) {
      conflicts.push({
        contractId: entry.contractId,
        reason: 'missing',
        detail: '契约已从仓库中移除。',
      });
      return entry;
    }
    // 对方冻结：本标签页尚未记录冻结结果，或本批记录的快照已不在当前版本历史首位
    const ownSnapshot =
      entry.status === 'frozen' &&
      current.versions.some((version) => version.id === entry.snapshotId);
    const otherFroze = current.status === 'frozen' && !ownSnapshot;
    if (otherFroze) {
      const snapshot = current.versions[0];
      conflicts.push({
        contractId: entry.contractId,
        reason: 'frozen_by_other',
        otherVersion: snapshot?.version ?? current.version,
        detail: `另一标签页已将其冻结为 v${snapshot?.version ?? current.version}（${
          snapshot ? new Date(snapshot.releasedAt).toLocaleString('zh-CN') : '时间未知'
        }）。`,
      });
      return {
        ...entry,
        status: 'frozen' as const,
        external: entry.status === 'frozen' ? entry.external : true,
        frozenVersion: snapshot?.version ?? entry.frozenVersion,
        snapshotId: snapshot?.id ?? entry.snapshotId,
        frozenAt: snapshot?.releasedAt ?? entry.frozenAt,
        detail: undefined,
        issues: undefined,
      };
    }
    if (current.revision === entry.fromRevision || entry.status === 'frozen') return entry;
    conflicts.push({
      contractId: entry.contractId,
      reason: 'changed_by_other',
      otherVersion: current.version,
      detail: `草稿基线为修订 #${entry.fromRevision}，对方已更新至修订 #${current.revision}（当前 v${current.version}）。`,
    });
    return entry;
  });
  return { conflicts, aligned };
}

/** 把进度先落盘：已通过门禁的份照常生成快照，失败份留下原因，其余仍是待办 */
function persistProgress(
  batch: ReleaseBatch,
  entries: BatchEntry[],
  status: ReleaseBatch['status'],
  contracts: ApiContract[] | null,
  extra?: Partial<ReleaseBatch>,
): ReleaseBatch {
  const now = new Date().toISOString();
  const updated: ReleaseBatch = {
    ...batch,
    ...extra,
    status,
    entries: entries.map((entry, index) => ({ ...entry, order: index })),
    updatedAt: now,
  };
  // 契约与批次在同一个 JS 事件循环中连续写入，每份快照本身都是完整对象
  if (contracts) storeContracts(contracts);
  saveBatches(loadBatches().map((item) => (item.id === batch.id ? updated : item)));
  return updated;
}

/**
 * 从留下的待办重试：锁内先按最新数据重走规划（刷新修订基线、对齐外部冻结、
 * 重算拓扑次序），随后立即按序确认。已冻结的快照不会重复生成。
 */
export async function retryBatch(batchId: string): Promise<ConfirmResult> {
  const release = await acquireLock(batchId);
  try {
    const { batch: replanned } = replanBatchInternal(batchId);
    return runConfirm(batchId, replanned);
  } finally {
    release();
  }
}

/**
 * 确认一批：严格按规划次序逐份“校验 → 生成完整快照”。
 * 中途某份校验失败立即停下，已冻结份保留，其余留在待办，等待重试。
 *
 * `draftBatch` 为发起标签页手中的草稿；跨标签页时它可能停留在冻结前，
 * 与存储中的对方结果比对即可检出冲突。不传则以存储最新版本为准。
 */
export async function confirmBatch(
  batchId: string,
  draftBatch?: ReleaseBatch,
): Promise<ConfirmResult> {
  const release = await acquireLock(batchId);
  try {
    return await runConfirm(batchId, draftBatch);
  } finally {
    release();
  }
}

async function runConfirm(
  batchId: string,
  draftBatch?: ReleaseBatch,
): Promise<ConfirmResult> {
  // 拿锁后读取最新数据：等待锁期间另一标签页可能已经完成冻结
  let contracts = loadContracts();
  const stored = loadBatches().find((item) => item.id === batchId);
  if (!stored) throw new Error('批次不存在，可能已被另一标签页处理。');
  // 执行以存储版本为基座，但待办条目保留手中草稿的目标版本与发布说明
  let batch: ReleaseBatch = mergeDraft(stored, draftBatch);
  const draft: ReleaseBatch = draftBatch ?? stored;

  // 1) 冲突检测：对方先确认/改过，后确认者只看到对方版本与冲突项
  const { conflicts, aligned } = detectBatchConflicts(draft, contracts);
  if (conflicts.length) {
    const stoppedAt = new Date().toISOString();
    const allFrozen = aligned.every((entry) => entry.status === 'frozen');
    batch = persistProgress(
      batch,
      aligned,
      allFrozen ? 'done' : 'blocked',
      null,
      {
        // 即使全部被对方冻结，也保留冲突清单，让后确认者看到对方的版本
        conflicts,
        conflictAt: stoppedAt,
        blockers: [],
        lastError: allFrozen
          ? '另一标签页已冻结全部契约，已对齐对方版本，无剩余待办。'
          : '检测到另一标签页的更新，已暂停。查看冲突项后可按新次序重走。',
      },
    );
    return {
      outcome: allFrozen ? 'done' : 'conflict',
      batch: clone(batch),
    };
  }

  // 2) 调用关系阻塞重算（仅针对仍待办的份）
  const todoIds = aligned.filter((entry) => entry.status !== 'frozen').map((e) => e.contractId);
  const plan = planBatch(contracts, todoIds.length ? todoIds : aligned.map((e) => e.contractId));
  const blockers: BatchBlocker[] = plan.blockers;
  if (blockers.length) {
    batch = persistProgress(batch, aligned, 'blocked', null, {
      blockers,
      conflicts: undefined,
      conflictAt: undefined,
      lastError: '调用关系挡住了整批，请按提示处理后重试。',
    });
    return { outcome: 'blocked', batch: clone(batch) };
  }

  // 3) 按上游在前的次序逐份推进
  let working = [...contracts];
  const entries = [...aligned].sort((a, b) => a.order - b.order);
  const findEntry = (id: string): BatchEntry | undefined =>
    entries.find((item) => item.contractId === id);
  for (const entry of entries) {
    if (entry.status === 'frozen') continue;
    const contract = working.find((item) => item.id === entry.contractId);
    if (!contract) {
      const failed: BatchEntry = {
        ...entry,
        status: 'failed',
        detail: '契约已从仓库中移除。',
        issues: [],
      };
      const index = entries.findIndex((item) => item.contractId === entry.contractId);
      entries[index] = failed;
      batch = persistProgress(batch, entries, 'partial', null, {
        blockers: [],
        lastError: `「${entry.contractId}」缺失，批次停在待办。`,
      });
      return { outcome: 'partial', batch: clone(batch) };
    }

    // 次序守卫：批次内上游若还没冻结，说明次序被破坏，整批停下而不是先放过下游。
    // 既看批次条目（本批冻结），也看工作副本状态（另一标签页刚冻结、重走后对齐）。
    const pendingUpstream = contract.dependencies.find((depId) => {
      const upstreamEntry = findEntry(depId);
      const upstreamContract = working.find((item) => item.id === depId);
      const entryReady = upstreamEntry ? upstreamEntry.status === 'frozen' : true;
      const contractReady = upstreamContract ? upstreamContract.status === 'frozen' : true;
      // 批次内的上游必须条目与契约都已冻结；批次外上游已在规划阶段要求 frozen
      return upstreamEntry ? !(entryReady && contractReady) : !contractReady;
    });
    if (pendingUpstream) {
      const upstream = working.find((item) => item.id === pendingUpstream);
      batch = persistProgress(batch, entries, 'blocked', null, {
        blockers: [
          {
            type: 'pending_prerequisite',
            fromContractId: contract.id,
            toContractId: pendingUpstream,
            detail: `「${contract.name}」排在上游「${upstream?.name ?? pendingUpstream}」之前，不能先冻结。`,
          },
        ],
        lastError: '上下游次序错误，整批停在待办。',
      });
      return { outcome: 'blocked', batch: clone(batch) };
    }

    const issues = validateForRelease(contract).filter((issue) => issue.severity === 'blocker');
    if (issues.length) {
      const failed: BatchEntry = {
        ...entry,
        status: 'failed',
        detail: `${issues.length} 个发布门禁阻断项，本批在此停下，后续份保留待办。`,
        issues: issues.map((issue) => ({ id: issue.id, title: issue.title, detail: issue.detail })),
      };
      const index = entries.findIndex((item) => item.contractId === entry.contractId);
      entries[index] = failed;
      batch = persistProgress(batch, entries, 'partial', null, {
        blockers: [],
        lastError: `「${contract.name}」校验失败，已通过的份快照完整，修复后从待办重试。`,
      });
      return { outcome: 'partial', batch: clone(batch) };
    }

    // 门禁通过 → 生成完整版本快照，并随契约一次性替换落库
    const releasedAt = new Date().toISOString();
    const { contract: frozen, release: snapshot } = buildFrozenContract(
      contract,
      entry.targetVersion.trim() || suggestVersion(contract.version),
      entry.notes.trim() || `随批次「${batch.label}」冻结。`,
      releasedAt,
    );
    working = working.map((item) => (item.id === frozen.id ? frozen : item));
    const index = entries.findIndex((item) => item.contractId === entry.contractId);
    entries[index] = {
      ...entry,
      status: 'frozen',
      detail: undefined,
      issues: undefined,
      snapshotId: snapshot.id,
      frozenVersion: snapshot.version,
      frozenAt: releasedAt,
      fromRevision: frozen.revision,
    };
    // 每份冻结后立刻把完整快照与批次进度一起落盘，崩溃/关页也不会留下半份版本
    batch = persistProgress(batch, entries, 'running', working);
    await delay(STEP_DELAY_MS);
  }

  batch = persistProgress(
    batch,
    entries,
    'done',
    working,
    { blockers: [], conflicts: undefined, conflictAt: undefined, lastError: undefined },
  );
  return { outcome: 'done', batch: clone(batch) };
}

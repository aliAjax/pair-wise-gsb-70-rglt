import { seedContracts } from '../data/seed';
import type {
  ApiContract,
  ContractChange,
  ContractVersion,
  ReleaseBatch,
  ReviewState,
} from '../models/contract';
import { planReleaseBatch, type DependencyEdge } from '../models/release-batch';
import { validateForRelease } from '../models/contract';
import { stableChecksum, formatDateTime } from '../lib/utils';

const STORAGE_KEY = 'pair-wise-gsb-70-contracts';
const BATCH_STORAGE_KEY = 'pair-wise-gsb-70-release-batches';
const LATENCY = 180;

interface StoreEnvelope {
  /** 每次写库自增，跨标签页提交时用来判断对方是否先落了版本 */
  revision: number;
  contracts: ApiContract[];
}

/** 后确认者提交时，发现先确认者已经改库：带上对方版本和逐份冲突明细 */
export class BatchConflictError extends Error {
  latestRevision: number;
  /** 先确认的标签页新冻结出来的版本 */
  releases: Array<{ contractId: string; contractName: string; version: string }>;
  /** 与建批时基线不一致的契约：契约 id -> { 基线校验值, 最新校验值 } */
  changedContracts: Array<{ contractId: string; contractName: string; base: string; latest: string }>;

  constructor(input: {
    latestRevision: number;
    releases: BatchConflictError['releases'];
    changedContracts: BatchConflictError['changedContracts'];
  }) {
    super('另一个标签页已经先确认了同一批，工作副本已变化，请按新次序重走。');
    this.name = 'BatchConflictError';
    this.latestRevision = input.latestRevision;
    this.releases = input.releases;
    this.changedContracts = input.changedContracts;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function wait(duration: number = LATENCY): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, duration));
}

function normalize(raw: unknown): StoreEnvelope {
  const withDefaults = (contracts: ApiContract[]): ApiContract[] =>
    contracts.map((contract) => ({
      ...contract,
      dependencies: Array.isArray(contract.dependencies) ? contract.dependencies : [],
    }));
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as StoreEnvelope).contracts) &&
    typeof (raw as StoreEnvelope).revision === 'number'
  ) {
    const envelope = raw as StoreEnvelope;
    return { revision: envelope.revision, contracts: withDefaults(envelope.contracts) };
  }
  if (Array.isArray(raw)) {
    // 旧版本直接存契约数组
    return { revision: 1, contracts: withDefaults(raw as ApiContract[]) };
  }
  const seeded = clone(seedContracts);
  return { revision: 1, contracts: seeded };
}

function readStore(): StoreEnvelope {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    const envelope = normalize(clone(seedContracts));
    writeStore(envelope);
    return envelope;
  }
  try {
    return normalize(JSON.parse(stored));
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    const envelope = normalize(clone(seedContracts));
    writeStore(envelope);
    return envelope;
  }
}

/** 所有变更只允许经这一个出口落库，保证「一次写入」——批次不会只写一半 */
function writeStore(envelope: StoreEnvelope): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ revision: envelope.revision, contracts: envelope.contracts }),
  );
}

function mutate<T>(worker: (envelope: StoreEnvelope) => T): T {
  const envelope = readStore();
  const result = worker(envelope);
  envelope.revision += 1;
  writeStore(envelope);
  return result;
}

function readBatches(): ReleaseBatch[] {
  const stored = localStorage.getItem(BATCH_STORAGE_KEY);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? (parsed as ReleaseBatch[]) : [];
  } catch {
    return [];
  }
}

function writeBatches(batches: ReleaseBatch[]): void {
  localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(batches));
}

function mutateBatches<T>(worker: (batches: ReleaseBatch[]) => T): T {
  const batches = readBatches();
  const result = worker(batches);
  writeBatches(batches);
  return result;
}

export async function listContracts(): Promise<ApiContract[]> {
  await wait();
  return clone(readStore().contracts);
}

export async function getContract(id: string): Promise<ApiContract | undefined> {
  const contracts = await listContracts();
  return contracts.find((contract) => contract.id === id);
}

export async function listBatches(): Promise<ReleaseBatch[]> {
  await wait(60);
  return clone(
    readBatches().sort(
      (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    ),
  );
}

export function getStoreRevision(): number {
  return readStore().revision;
}

export async function saveContract(updated: ApiContract): Promise<ApiContract> {
  const saved = await new Promise<ApiContract>((resolve) => {
    const result = mutate((envelope) => {
      const exists = envelope.contracts.some((contract) => contract.id === updated.id);
      const next = { ...updated, updatedAt: new Date().toISOString() };
      envelope.contracts = exists
        ? envelope.contracts.map((contract) => (contract.id === updated.id ? next : contract))
        : [next, ...envelope.contracts];
      return next;
    });
    resolve(result);
  });
  await wait();
  return clone(saved);
}

export async function reviewChange(
  contractId: string,
  changeId: string,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
): Promise<ApiContract> {
  const updated = mutate((envelope) => {
    const contract = envelope.contracts.find((item) => item.id === contractId);
    if (!contract) {
      throw new Error('契约不存在');
    }
    const next: ApiContract = {
      ...contract,
      status: contract.status === 'draft' ? 'review' : contract.status,
      changes: contract.changes.map((change) =>
        change.id === changeId
          ? {
              ...change,
              reviewState,
              reviewer,
              reviewComment: comment,
              reviewedAt: new Date().toISOString(),
            }
          : change,
      ),
    };
    envelope.contracts = envelope.contracts.map((item) =>
      item.id === contractId ? next : item,
    );
    return next;
  });
  await wait();
  return clone(updated);
}

export async function bulkReviewChanges(
  selections: Array<{ contractId: string; changeId: string }>,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
): Promise<ApiContract[]> {
  const updated = mutate((envelope) => {
    const selected = new Set(selections.map((item) => `${item.contractId}:${item.changeId}`));
    envelope.contracts = envelope.contracts.map((contract) => ({
      ...contract,
      status:
        selected.has(`${contract.id}:${contract.changes[0]?.id}`) && contract.status === 'draft'
          ? ('review' as const)
          : contract.status,
      changes: contract.changes.map((change) =>
        selected.has(`${contract.id}:${change.id}`)
          ? {
              ...change,
              reviewState,
              reviewer,
              reviewComment: comment,
              reviewedAt: new Date().toISOString(),
            }
          : change,
      ),
    }));
    return envelope.contracts;
  });
  await wait();
  return clone(updated);
}

export async function updateContractOpenApi(
  contractId: string,
  openapi: string,
): Promise<ApiContract> {
  const updated = mutate((envelope) => {
    const contract = envelope.contracts.find((item) => item.id === contractId);
    if (!contract) {
      throw new Error('契约不存在');
    }
    const next = { ...contract, openapi, updatedAt: new Date().toISOString() };
    envelope.contracts = envelope.contracts.map((item) =>
      item.id === contractId ? next : item,
    );
    return next;
  });
  await wait();
  return clone(updated);
}

export async function addExemption(
  contractId: string,
  changeId: string,
  reason: string,
): Promise<ApiContract> {
  const updated = mutate((envelope) => {
    const contract = envelope.contracts.find((item) => item.id === contractId);
    if (!contract) {
      throw new Error('契约不存在');
    }
    const exemption = {
      id: `ex-${Date.now()}`,
      changeId,
      scope: contract.changes.find((item) => item.id === changeId)?.path ?? '未指定',
      reason,
      approvedBy: '当前评审人',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    };
    const next: ApiContract = {
      ...contract,
      exemptions: [...contract.exemptions, exemption],
      changes: contract.changes.map((change) =>
        change.id === changeId ? { ...change, reviewState: 'exemption' } : change,
      ),
    };
    envelope.contracts = envelope.contracts.map((item) =>
      item.id === contractId ? next : item,
    );
    return next;
  });
  await wait();
  return clone(updated);
}

function buildRelease(
  contract: ApiContract,
  version: string,
  notes: string,
  batchId?: string,
  releasedAt: string = new Date().toISOString(),
): ContractVersion {
  return {
    id: `ver-${Date.now()}-${contract.id}`,
    contractId: contract.id,
    version,
    releasedAt,
    checksum: stableChecksum(contract.openapi),
    notes,
    changeIds: contract.changes.map((change) => change.id),
    openapi: contract.openapi,
    batchId,
  };
}

export async function freezeVersion(
  contractId: string,
  version: string,
  notes: string,
  expectedRevision?: number,
): Promise<{ contract: ApiContract; revision: number }> {
  let result: { contract: ApiContract; revision: number } | undefined;
  try {
    result = mutate((envelope) => {
      if (expectedRevision !== undefined && envelope.revision !== expectedRevision) {
        throw new BatchConflictError({ latestRevision: envelope.revision, releases: [], changedContracts: [] });
      }
      const contract = envelope.contracts.find((item) => item.id === contractId);
      if (!contract) {
        throw new Error('契约不存在');
      }
      const release = buildRelease(contract, version, notes);
      const updated: ApiContract = {
        ...contract,
        version,
        status: 'frozen',
        versions: [release, ...contract.versions],
      };
      envelope.contracts = envelope.contracts.map((item) =>
        item.id === contractId ? updated : item,
      );
      return { contract: updated, revision: envelope.revision + 1 };
    });
  } catch (error) {
    await wait();
    throw error;
  }
  await wait();
  return clone(result!);
}

export interface CreateBatchInput {
  name: string;
  contractIds: string[];
  notes: string;
  temporaryEdges: DependencyEdge[];
}

/**
 * 建批：当场按调用关系排次序。环或前置项待核时不允许进入核验，
 * 批次以 todo 状态留在待办列表，并携带挡路关系对。
 */
export async function createReleaseBatch(
  input: CreateBatchInput,
): Promise<{ batch?: ReleaseBatch; plan: ReturnType<typeof planReleaseBatch> }> {
  const { contracts } = readStore();
  const plan = planReleaseBatch(input.contractIds, contracts, input.temporaryEdges);
  await wait(120);
  if (plan.blockers.length > 0) {
    // 整批停在待办：不落正式批次，只把计划交回界面指出挡路关系
    return { plan: clone(plan) };
  }

  const now = new Date().toISOString();
  const batch: ReleaseBatch = {
    id: `batch-${Date.now()}`,
    name: input.name.trim() || `发布批次 ${formatDateTime(now)}`,
    contractIds: [...input.contractIds],
    orderedIds: plan.order.map((item) => item.contract.id),
    status: 'todo',
    verifiedIds: [],
    notes: input.notes.trim(),
    createdAt: now,
    revision: readStore().revision,
    bases: Object.fromEntries(
      plan.order.map((item) => [item.contract.id, stableChecksum(item.contract.openapi)]),
    ),
  };
  mutateBatches((batches) => {
    batches.unshift(batch);
  });
  return { batch: clone(batch), plan: clone(plan) };
}

export interface VerifyStep {
  contractId: string;
  state: 'verified' | 'failed';
  issues: ReturnType<typeof validateForRelease>;
}

/**
 * 逐份核验：按拓扑次序，从第一份未核验的待办继续（失败后重试）。
 * 只推进批次进度（verifiedIds / failedAtId），不生成任何版本快照。
 */
export async function verifyNextInBatch(
  batchId: string,
): Promise<{ batch: ReleaseBatch; step: VerifyStep }> {
  const batch = readBatches().find((item) => item.id === batchId);
  if (!batch) throw new Error('批次不存在');

  const nextId = batch.orderedIds.find((id) => !batch.verifiedIds.includes(id));
  if (!nextId) throw new Error('批次已全部核验完成');

  const { contracts } = readStore();
  const contract = contracts.find((item) => item.id === nextId);

  await wait(520); // 模拟逐份核验耗时，让界面能展示推进过程

  if (!contract) {
    return finishStep(batch, {
      contractId: nextId,
      state: 'failed',
      issues: [],
    }, '契约已被其他标签页移除。');
  }

  // 上游必须已经核验通过（重试时也成立，因为按序推进）
  const upstreamIndex = batch.orderedIds.findIndex((id) => id === nextId);
  const pendingUpstream = batch.orderedIds
    .slice(0, upstreamIndex)
    .filter((id) => !batch.verifiedIds.includes(id));
  if (pendingUpstream.length) {
    return finishStep(batch, {
      contractId: nextId,
      state: 'failed',
      issues: [],
    }, `上游 ${pendingUpstream.join('、')} 尚未核验通过，次序不能越过。`);
  }

  const issues = validateForRelease(contract).filter((issue) => issue.severity === 'blocker');
  if (issues.length) {
    return finishStep(
      batch,
      { contractId: nextId, state: 'failed', issues },
      `${contract.name} 存在 ${issues.length} 个发布门禁阻断项，本批停在待办。`,
    );
  }

  const updated: ReleaseBatch = {
    ...batch,
    status: 'verifying',
    verifiedIds: [...batch.verifiedIds, nextId],
    failedAtId: undefined,
    failReason: undefined,
  };
  mutateBatches((batches) => {
    const index = batches.findIndex((item) => item.id === batchId);
    if (index >= 0) batches[index] = updated;
  });
  return { batch: clone(updated), step: { contractId: nextId, state: 'verified', issues: [] } };
}

function finishStep(
  batch: ReleaseBatch,
  step: VerifyStep,
  reason: string,
): { batch: ReleaseBatch; step: VerifyStep } {
  const updated: ReleaseBatch = {
    ...batch,
    // 核验失败整批回到待办，已核验的进度保留以便从待办重试
    status: 'todo',
    failedAtId: step.contractId,
    failReason: reason,
  };
  mutateBatches((batches) => {
    const index = batches.findIndex((item) => item.id === batch.id);
    if (index >= 0) batches[index] = updated;
  });
  return { batch: clone(updated), step: clone(step) };
}

export interface BatchVersionInput {
  contractId: string;
  version: string;
}

export interface BatchFreezeResult {
  batch: ReleaseBatch;
  contracts: ApiContract[];
  revision: number;
}

/**
 * 核完后一次生成整批版本快照：
 * - 所有契约必须已逐份核验通过；
 * - 提交瞬间在同一次写库里重新校验，任一失败则整批不动（不会只写一半）；
 * - expectedRevision 与当前库不一致时抛 {@link BatchConflictError}，
 *   后确认者可拿到先确认者的版本与冲突契约，按新次序重走。
 */
export async function commitBatchFreeze(input: {
  batchId: string;
  versions: BatchVersionInput[];
  expectedRevision: number;
}): Promise<BatchFreezeResult> {
  await wait(640);

  let result: BatchFreezeResult | undefined;
  try {
    result = mutate((envelope) => {
      const batch = readBatches().find((item) => item.id === input.batchId);
      if (!batch) throw new Error('批次不存在');

      const byId = new Map(envelope.contracts.map((contract) => [contract.id, contract]));

      if (batch.status === 'frozen') {
        throw new Error('该批次已经冻结，不能重复生成版本。');
      }

      // 内容层冲突：另一个标签页已经先为本批契约冻结出版本
      const foreignReleases = collectForeignReleases(batch, envelope.contracts);
      // 工作副本相对建批基线的漂移（来自其他标签页的改动）
      const changedContracts = batch.orderedIds
        .map((id) => {
          const contract = byId.get(id);
          const base = batch.bases[id];
          if (!contract || base === undefined) return null;
          const latest = stableChecksum(contract.openapi);
          return latest === base
            ? null
            : { contractId: id, contractName: contract.name, base, latest };
        })
        .filter((item): item is BatchConflictError['changedContracts'][number] => !!item);

      // 对方已冻结本批契约必冲突；revision 过期且内容漂移同样按冲突处理
      const revisionStale = envelope.revision !== input.expectedRevision;
      if (foreignReleases.length || (revisionStale && changedContracts.length)) {
        throw new BatchConflictError({
          latestRevision: envelope.revision,
          releases: foreignReleases,
          changedContracts,
        });
      }

      if (batch.verifiedIds.length !== batch.orderedIds.length) {
        throw new Error('还有契约未完成逐份核验，不能冻结。');
      }

      // 同一次写库前再按当前数据重算调用关系与门禁，失败则整体不写入
      const plan = planReleaseBatch(batch.contractIds, envelope.contracts);
      if (plan.blockers.length) {
        throw new Error(`调用关系已变化：${plan.blockers[0].detail}`);
      }
      for (const item of plan.order) {
        const blockers = item.gateIssues.filter((issue) => issue.severity === 'blocker');
        if (blockers.length) {
          throw new Error(`${item.contract.name} 校验失败：${blockers[0].detail}`);
        }
        if (item.contract.status === 'frozen') {
          // 没有落在 foreignReleases 时间窗内的新版本，仍拒绝重复冻结
          throw new Error(`${item.contract.name} 已是冻结状态，不能重复生成版本。`);
        }
      }

      const versionMap = new Map(input.versions.map((item) => [item.contractId, item.version]));
      const frozenAt = new Date().toISOString();
      const updatedContracts = envelope.contracts.map((contract) => {
        if (!batch.orderedIds.includes(contract.id)) return contract;
        const version = versionMap.get(contract.id)?.trim();
        if (!version) throw new Error(`${contract.name} 缺少版本号`);
        const release = buildRelease(
          contract,
          version,
          batch.notes || `随批次「${batch.name}」冻结`,
          batch.id,
          frozenAt,
        );
        return {
          ...contract,
          version,
          status: 'frozen' as const,
          versions: [release, ...contract.versions],
        };
      });

      // 关键：所有快照与批次状态在一次 writeStore + 一次批次写入中落库
      envelope.contracts = updatedContracts;
      const frozenBatch: ReleaseBatch = {
        ...batch,
        status: 'frozen',
        frozenAt,
        revision: envelope.revision + 1,
      };
      writeBatches(readBatches().map((item) => (item.id === batch.id ? frozenBatch : item)));

      return {
        batch: frozenBatch,
        contracts: updatedContracts.filter((contract) =>
          batch.orderedIds.includes(contract.id),
        ),
        revision: envelope.revision + 1,
      };
    });
  } catch (error) {
    if (error instanceof BatchConflictError) throw error;
    // 提交时校验失败：批次停在待办，保留已核验进度，供“从待办重试”
    if (error instanceof Error) {
      const batch = readBatches().find((item) => item.id === input.batchId);
      if (batch && batch.status !== 'frozen') {
        mutateBatches((batches) => {
          const index = batches.findIndex((item) => item.id === input.batchId);
          if (index >= 0) {
            batches[index] = { ...batch, status: 'todo', failReason: error.message };
          }
        });
      }
    }
    throw error;
  }
  return clone(result!);
}

/** 找出先确认者针对本批契约新冻结的版本（比建批基线更新的第一条） */
function collectForeignReleases(
  batch: ReleaseBatch,
  contracts: ApiContract[],
): BatchConflictError['releases'] {
  const releases: BatchConflictError['releases'] = [];
  for (const id of batch.orderedIds) {
    const contract = contracts.find((item) => item.id === id);
    const latest = contract?.versions[0];
    if (
      contract &&
      latest &&
      new Date(latest.releasedAt).getTime() >= new Date(batch.createdAt).getTime()
    ) {
      releases.push({ contractId: id, contractName: contract.name, version: latest.version });
    }
  }
  return releases;
}

export function discardReleaseBatch(batchId: string): Promise<void> {
  mutateBatches((batches) => {
    const index = batches.findIndex((item) => item.id === batchId);
    if (index >= 0) batches.splice(index, 1);
  });
  return wait(60);
}

export function generateExampleRequest(contract: ApiContract, change?: ContractChange): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contract.openapi);
  } catch {
    parsed = null;
  }
  const openapi = parsed as
    | {
        paths?: Record<string, Record<string, { summary?: string }>>;
      }
    | null;
  const candidates = openapi?.paths ? Object.entries(openapi.paths) : [];
  const selectedPath = change?.path ?? candidates[0]?.[0] ?? '/resource';
  const selectedMethod = (
    change?.method ??
    (candidates[0]?.[1] ? Object.keys(candidates[0][1])[0] : 'get')
  ).toUpperCase();
  const fields = change
    ? [change.after.replace(/^新增|移除|变为/g, '').trim()]
    : ['orderId: ORD-20260929-001', 'requestId: req-local-demo'];

  return JSON.stringify(
    {
      method: selectedMethod,
      url: `https://api.example.com${selectedPath.replace('{orderId}', 'ORD-20260929-001').replace('{paymentId}', 'PAY-90218').replace('{userId}', 'U-1024')}`,
      headers: {
        Authorization: 'Bearer <token>',
        'X-Client-Version': contract.version,
      },
      body:
        selectedMethod === 'GET'
          ? undefined
          : Object.fromEntries(
              fields.map((field) => {
                const [key, value] = field.split(':').map((item) => item.trim());
                return [key || 'field', value || 'value'];
              }),
            ),
    },
    null,
    2,
  );
}

export function buildChangeReport(contract: ApiContract): string {
  const lines = [
    `# ${contract.name} ${contract.version} 契约变更报告`,
    '',
    `- 领域：${contract.domain}`,
    `- 负责人：${contract.owner}`,
    `- 状态：${contract.status}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## 变更明细',
    ...contract.changes.flatMap((change) => [
      `### ${change.method} ${change.path} - ${change.kind}`,
      `- 兼容性：${change.compatibility}`,
      `- 变更前：${change.before}`,
      `- 变更后：${change.after}`,
      `- 判定依据：${change.rationale}`,
      `- 调用方影响：${change.impactStatement || '未填写'}`,
      `- 迁移方案：${change.migrationPlan || '未填写'}`,
      `- 评审结论：${change.reviewState}`,
      '',
    ]),
    '## 调用方',
    ...contract.consumers.map(
      (consumer) =>
        `- ${consumer.name} / ${consumer.owner} / ${consumer.environment} / ${consumer.clientVersion}`,
    ),
    '',
    '## 豁免记录',
    ...(contract.exemptions.length
      ? contract.exemptions.map(
          (item) => `- ${item.scope}：${item.reason}（至 ${item.expiresAt}）`,
        )
      : ['- 无']),
  ];
  return lines.join('\n');
}

export function diffVersionSummary(contract: ApiContract): string {
  const previous = contract.versions[0];
  if (!previous) {
    return '无可比较的历史正式版本。';
  }
  return [
    `上一版 ${previous.version}`,
    `发布于 ${formatDateTime(previous.releasedAt)}`,
    `校验值 ${previous.checksum}`,
    `本版变更 ${contract.changes.length} 项`,
  ].join('\n');
}

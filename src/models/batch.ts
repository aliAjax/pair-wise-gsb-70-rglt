import type { ApiContract } from './contract';

export type BatchStatus = 'todo' | 'running' | 'blocked' | 'partial' | 'done';
export type EntryStatus = 'todo' | 'frozen' | 'failed';

/** 批次级阻塞：调用关系本身挡住了整批，必须指出是哪一对关系 */
export interface BatchBlocker {
  type: 'cycle' | 'pending_prerequisite' | 'missing_dependency';
  fromContractId: string;
  toContractId: string;
  detail: string;
}

export interface BatchEntry {
  contractId: string;
  /** 规划次序，0 起，上游在前 */
  order: number;
  targetVersion: string;
  notes: string;
  status: EntryStatus;
  /** 规划时契约的修订号，用于跨标签页乐观并发检测 */
  fromRevision: number;
  /** 失败时保留的门禁原因，重试前清空 */
  detail?: string;
  issues?: Array<{ id: string; title: string; detail: string }>;
  snapshotId?: string;
  frozenVersion?: string;
  frozenAt?: string;
  /** 由另一标签页先行冻结，重走时对齐、不再重复生成快照 */
  external?: boolean;
}

export interface ReleaseBatch {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  status: BatchStatus;
  entries: BatchEntry[];
  blockers: BatchBlocker[];
  /** 最近一次确认时发现的跨标签页冲突 */
  conflictAt?: string;
  conflicts?: BatchConflict[];
  lastError?: string;
}

export interface BatchConflict {
  contractId: string;
  reason: 'frozen_by_other' | 'changed_by_other' | 'missing';
  otherVersion?: string;
  detail: string;
}

export interface BatchPlan {
  /** 上游在前的契约 ID 次序 */
  order: string[];
  blockers: BatchBlocker[];
}

/**
 * 按调用关系规划批次：
 * - 批次内按“被依赖方（上游）在前”拓扑排序；
 * - 成环时收集每一条回边（哪对互为上下游挡路），整批不予开冻；
 * - 批次外的上游若仍未冻结（还在待核），同样作为挡路关系列出。
 *
 * 重试时只传入仍待办的份；已冻结的同批上游不在 members 中，
 * 若其 status 已是 frozen 不会产生阻塞，未冻结的同批上游则由执行期次序守卫兜底。
 */
export function planBatch(contracts: ApiContract[], memberIds: string[]): BatchPlan {
  const selected = new Set(memberIds);
  const members = contracts.filter((contract) => selected.has(contract.id));
  const byId = new Map(members.map((contract) => [contract.id, contract]));
  const blockers: BatchBlocker[] = [];

  const nameOf = (id: string): string =>
    contracts.find((contract) => contract.id === id)?.name ?? id;

  // 批次外前置：缺失，或尚未冻结（仍有待核变更）。
  // 注意必须按实际成员集合判断——重试时只传入仍待办的份，已冻结的同批上游不属于“批外”。
  members.forEach((contract) => {
    contract.dependencies.forEach((depId) => {
      if (byId.has(depId)) return;
      const upstream = contracts.find((item) => item.id === depId);
      if (!upstream) {
        blockers.push({
          type: 'missing_dependency',
          fromContractId: contract.id,
          toContractId: depId,
          detail: `${nameOf(contract.id)} 依赖的上游契约 ${depId} 不存在。`,
        });
        return;
      }
      if (upstream.status !== 'frozen') {
        blockers.push({
          type: 'pending_prerequisite',
          fromContractId: contract.id,
          toContractId: depId,
          detail: `上游「${upstream.name}」未纳入本批且尚未冻结，仍有待核变更，${contract.name} 不能先于它冻结。`,
        });
      }
    });
  });

  // 环检测：DFS 三着色，回边即环上的挡路关系
  const color = new Map<string, 0 | 1 | 2>();
  const backEdges: Array<[string, string]> = [];
  const visit = (node: ApiContract): void => {
    color.set(node.id, 1);
    node.dependencies
      .filter((depId) => byId.has(depId))
      .sort()
      .forEach((depId) => {
        const state = color.get(depId);
        if (state === 1) {
          backEdges.push([node.id, depId]);
        } else if (state === undefined) {
          visit(byId.get(depId)!);
        }
      });
    color.set(node.id, 2);
  };
  [...byId.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach((contract) => {
      if (color.get(contract.id) === undefined) visit(contract);
    });

  const seenEdge = new Set<string>();
  backEdges.forEach(([from, to]) => {
    const key = `${from}->${to}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    blockers.push({
      type: 'cycle',
      fromContractId: from,
      toContractId: to,
      detail: `「${nameOf(from)}」与上游「${nameOf(to)}」互相依赖形成环路，无法确定先后次序。`,
    });
  });

  // Kahn 拓扑排序，同层按名称稳定排序；成环时环上节点追加在末尾（仅供展示）
  const indegree = new Map<string, number>();
  members.forEach((contract) => indegree.set(contract.id, 0));
  members.forEach((contract) => {
    contract.dependencies
      .filter((depId) => byId.has(depId))
      .forEach(() => {
        indegree.set(contract.id, (indegree.get(contract.id) ?? 0) + 1);
      });
  });
  const ready = members
    .filter((contract) => (indegree.get(contract.id) ?? 0) === 0)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    .map((contract) => contract.id);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    members.forEach((contract) => {
      if (contract.dependencies.includes(id)) {
        const next = (indegree.get(contract.id) ?? 0) - 1;
        indegree.set(contract.id, next);
        if (next === 0) {
          ready.push(contract.id);
          ready.sort((left, right) =>
            nameOf(left).localeCompare(nameOf(right), 'zh-CN'),
          );
        }
      }
    });
  }
  members
    .filter((contract) => !order.includes(contract.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    .forEach((contract) => order.push(contract.id));

  return { order, blockers };
}

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  todo: '待办',
  running: '冻结中',
  blocked: '被关系阻塞',
  partial: '部分冻结',
  done: '已完成',
};

export const ENTRY_STATUS_LABELS: Record<EntryStatus, string> = {
  todo: '待办',
  frozen: '已冻结',
  failed: '校验失败',
};

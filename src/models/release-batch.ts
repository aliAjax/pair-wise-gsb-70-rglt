import type { ApiContract, ReleaseIssue } from './contract';
import { validateForRelease } from './contract';

/**
 * 调用关系：契约 {@link DependencyEdge#contractId}（下游/调用方）
 * 依赖 {@link DependencyEdge#dependsOnContractId}（上游/被调方）。
 * 批次冻结时上游必须排在下游之前。
 */
export interface DependencyEdge {
  contractId: string;
  dependsOnContractId: string;
  /** 临时编排关系不写回契约定义，只用于本批排序与演示成环场景。 */
  temporary?: boolean;
}

export type BatchBlockerKind = 'cycle' | 'prerequisite_pending' | 'contract_missing';

export interface BatchBlocker {
  kind: BatchBlockerKind;
  /** 挡路的关系对：[上游契约 id, 下游契约 id] */
  pair: [string, string];
  title: string;
  detail: string;
}

export interface BatchPlanItem {
  contract: ApiContract;
  /** 该契约在本批中等待的上游契约 id */
  dependsOn: string[];
  /** 该契约自身的发布门禁问题（不含批次级别的环/前置阻断） */
  gateIssues: ReleaseIssue[];
}

export interface BatchPlan {
  /** 按调用关系计算出的冻结先后次序 */
  order: BatchPlanItem[];
  /** 成环或前置项待核等批次级阻断；存在任意一条时整批停在待办 */
  blockers: BatchBlocker[];
  /** 参与排序的关系对（仅批内），用于界面展示箭头 */
  edges: Array<{ from: string; to: string; temporary: boolean }>;
}

function edgeKey(edge: DependencyEdge): string {
  return `${edge.dependsOnContractId}->${edge.contractId}`;
}

/** 合并契约自带的调用关系与发布经理临时编排的关系，去重。 */
export function mergeEdges(
  contracts: ApiContract[],
  overrides: DependencyEdge[] = [],
): DependencyEdge[] {
  const map = new Map<string, DependencyEdge>();
  for (const contract of contracts) {
    for (const dependsOnContractId of contract.dependencies ?? []) {
      const edge: DependencyEdge = { contractId: contract.id, dependsOnContractId };
      map.set(edgeKey(edge), edge);
    }
  }
  for (const edge of overrides) {
    map.set(edgeKey(edge), { ...edge, temporary: true });
  }
  return [...map.values()];
}

/**
 * 在残留子图中用 DFS 找一条真实的环，返回环上的有向关系对序列。
 * 方向与 edges 一致：pair[0] 为上游，pair[1] 为下游。
 */
function findCycle(
  nodeIds: string[],
  outgoing: Map<string, string[]>,
): Array<[string, string]> {
  const remaining = new Set(nodeIds);
  const stack: string[] = [];
  const onStack = new Set<string>();

  function visit(node: string): string[] | null {
    stack.push(node);
    onStack.add(node);
    const neighbors = (outgoing.get(node) ?? []).filter((next) => remaining.has(next));
    for (const next of neighbors) {
      if (onStack.has(next)) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      const found = visit(next);
      if (found) return found;
    }
    onStack.delete(node);
    stack.pop();
    return null;
  }

  for (const node of nodeIds) {
    if (onStack.has(node)) continue;
    const cycle = visit(node);
    if (cycle) {
      const pairs: Array<[string, string]> = [];
      for (let index = 0; index < cycle.length - 1; index += 1) {
        pairs.push([cycle[index], cycle[index + 1]]);
      }
      return pairs;
    }
  }
  return [];
}

/**
 * 按调用关系计算批次冻结次序。
 *
 * - Kahn 拓扑排序给出上游优先的稳定次序（同层按契约名字典序）；
 * - 排序结束仍有残留节点说明成环，DFS 抽出具体的环并逐对报告；
 * - 批内契约的前置（上游）不在批内时，要求上游已冻结，否则整批停在待办。
 */
export function planReleaseBatch(
  selectedIds: string[],
  contracts: ApiContract[],
  overrides: DependencyEdge[] = [],
): BatchPlan {
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  const selected = new Set(selectedIds);
  const blockers: BatchBlocker[] = [];

  for (const id of selectedIds) {
    if (!byId.has(id)) {
      blockers.push({
        kind: 'contract_missing',
        pair: [id, id],
        title: '契约已不存在',
        detail: `批次引用的契约 ${id} 在当前工作副本中找不到，可能已被其他标签页移除。`,
      });
    }
  }

  const allEdges = mergeEdges(contracts, overrides).filter(
    (edge) => byId.has(edge.contractId) && byId.has(edge.dependsOnContractId),
  );

  // 前置项还在待核：上游不在本批，且上游尚未冻结。被挡节点不允许进入冻结次序。
  const blockedByPrerequisite = new Set<string>();
  for (const edge of allEdges) {
    if (!selected.has(edge.contractId)) continue;
    if (selected.has(edge.dependsOnContractId)) continue;
    const upstream = byId.get(edge.dependsOnContractId);
    if (upstream && upstream.status !== 'frozen') {
      blockedByPrerequisite.add(edge.contractId);
      blockers.push({
        kind: 'prerequisite_pending',
        pair: [edge.dependsOnContractId, edge.contractId],
        title: '前置项还在待核',
        detail: `「${upstream.name}」尚未冻结，却是「${byId.get(edge.contractId)?.name ?? edge.contractId}」的上游，本批必须先带上它或等它冻结。`,
      });
    }
  }

  // 批内邻接表：downstream -> upstreams（入边），upstream -> downstreams（出边）
  const indegree = new Map<string, number>();
  const upstreams = new Map<string, Set<string>>();
  const outgoing = new Map<string, string[]>();
  const batchEdges = new Map<string, DependencyEdge>();

  for (const id of selectedIds) {
    // 前置待核的节点不参与拓扑：整批因此无法给出完整次序，停在待办
    indegree.set(id, blockedByPrerequisite.has(id) ? -1 : 0);
    upstreams.set(id, new Set());
    outgoing.set(id, []);
  }
  for (const edge of allEdges) {
    if (!selected.has(edge.contractId) || !selected.has(edge.dependsOnContractId)) continue;
    const set = upstreams.get(edge.contractId);
    if (set && !set.has(edge.dependsOnContractId)) {
      set.add(edge.dependsOnContractId);
      // 入度 -1 表示该节点已被「前置待核」挡住，保持不可排入
      if ((indegree.get(edge.contractId) ?? 0) >= 0) {
        indegree.set(edge.contractId, (indegree.get(edge.contractId) ?? 0) + 1);
      }
      outgoing.set(edge.dependsOnContractId, [
        ...(outgoing.get(edge.dependsOnContractId) ?? []),
        edge.contractId,
      ]);
      batchEdges.set(edgeKey(edge), edge);
    }
  }

  // Kahn：同层按名字稳定排序，避免每次次序抖动
  const ordered: ApiContract[] = [];
  const ready = [...selectedIds]
    .filter((id) => (indegree.get(id) ?? 0) === 0)
    .sort((a, b) => (byId.get(a)?.name ?? a).localeCompare(byId.get(b)?.name ?? b, 'zh-CN'));
  const enqueued = new Set(ready);

  while (ready.length) {
    const id = ready.shift()!;
    const contract = byId.get(id);
    if (contract) ordered.push(contract);
    for (const next of outgoing.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0 && !enqueued.has(next)) {
        enqueued.add(next);
        ready.push(next);
        ready.sort((a, b) =>
          (byId.get(a)?.name ?? a).localeCompare(byId.get(b)?.name ?? b, 'zh-CN'),
        );
      }
    }
  }

  const stuck = selectedIds.filter((id) => !enqueued.has(id));
  if (stuck.length) {
    const cyclePairs = findCycle(stuck, outgoing);
    if (cyclePairs.length) {
      for (const [upstreamId, downstreamId] of cyclePairs) {
        const edge = batchEdges.get(`${upstreamId}->${downstreamId}`);
        blockers.push({
          kind: 'cycle',
          pair: [upstreamId, downstreamId],
          title: '调用关系成环',
          detail: `「${byId.get(upstreamId)?.name ?? upstreamId}」与「${byId.get(downstreamId)?.name ?? downstreamId}」互相等待：${edge?.temporary ? '（临时编排关系）' : ''}${upstreamId} → ${downstreamId}，环上没有可先冻结的起点。`,
        });
      }
    }
    // 成环节点不进入 order，整批保持待办
  }

  const order: BatchPlanItem[] = ordered.map((contract) => ({
    contract,
    dependsOn: [...(upstreams.get(contract.id) ?? [])],
    gateIssues: validateForRelease(contract),
  }));

  return {
    order,
    blockers,
    edges: [...batchEdges.values()].map((edge) => ({
      from: edge.dependsOnContractId,
      to: edge.contractId,
      temporary: !!edge.temporary,
    })),
  };
}

export function isBlockingPair(blocker: BatchBlocker): boolean {
  return blocker.kind === 'cycle' || blocker.kind === 'prerequisite_pending';
}

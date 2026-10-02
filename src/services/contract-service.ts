import { seedContracts } from '../data/seed';
import type {
  ApiContract,
  ContractChange,
  ContractVersion,
  ReviewState,
} from '../models/contract';
import { stableChecksum, formatDateTime } from '../lib/utils';

export const STORAGE_KEY = 'pair-wise-gsb-70-contracts';
const LATENCY = 180;

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function wait(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, LATENCY));
}

/** 补齐旧版本本地数据缺少的字段，revision 用于跨标签页乐观并发 */
function migrate(contract: ApiContract): ApiContract {
  return {
    ...contract,
    dependencies: contract.dependencies ?? [],
    revision: contract.revision ?? 0,
  };
}

export function loadContracts(): ApiContract[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      return (JSON.parse(stored) as ApiContract[]).map(migrate);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  const seeded = seedContracts.map(migrate);
  storeContracts(seeded);
  return clone(seeded);
}

export function storeContracts(contracts: ApiContract[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contracts));
}

export async function listContracts(): Promise<ApiContract[]> {
  await wait();
  return clone(loadContracts());
}

export async function getContract(id: string): Promise<ApiContract | undefined> {
  const contracts = await listContracts();
  return contracts.find((contract) => contract.id === id);
}

export async function saveContract(updated: ApiContract): Promise<ApiContract> {
  const contracts = loadContracts();
  const current = contracts.find((contract) => contract.id === updated.id);
  const exists = Boolean(current);
  const saved: ApiContract = {
    ...updated,
    dependencies: updated.dependencies ?? current?.dependencies ?? [],
    revision: (current?.revision ?? 0) + (exists ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };
  const next = exists
    ? contracts.map((contract) => (contract.id === updated.id ? saved : contract))
    : [saved, ...contracts];
  storeContracts(next);
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
  const contracts = loadContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }

  const updated: ApiContract = {
    ...contract,
    revision: contract.revision + 1,
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
  storeContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

export async function bulkReviewChanges(
  selections: Array<{ contractId: string; changeId: string }>,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
): Promise<ApiContract[]> {
  const contracts = loadContracts();
  const selected = new Set(selections.map((item) => `${item.contractId}:${item.changeId}`));
  const touched = new Set(selections.map((item) => item.contractId));
  const updated = contracts.map((contract) => ({
    ...contract,
    revision: touched.has(contract.id) ? contract.revision + 1 : contract.revision,
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
  storeContracts(updated);
  await wait();
  return clone(updated);
}

export async function updateContractOpenApi(
  contractId: string,
  openapi: string,
): Promise<ApiContract> {
  const contracts = loadContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }
  const updated = {
    ...contract,
    openapi,
    revision: contract.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  storeContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

export async function updateContractDependencies(
  contractId: string,
  dependencies: string[],
): Promise<ApiContract> {
  const contracts = loadContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }
  const updated: ApiContract = {
    ...contract,
    dependencies: dependencies.filter((id) => id !== contractId),
    revision: contract.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  storeContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

export async function addExemption(
  contractId: string,
  changeId: string,
  reason: string,
): Promise<ApiContract> {
  const contracts = loadContracts();
  const contract = contracts.find((item) => item.id === contractId);
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
  const updated: ApiContract = {
    ...contract,
    revision: contract.revision + 1,
    exemptions: [...contract.exemptions, exemption],
    changes: contract.changes.map((change) =>
      change.id === changeId ? { ...change, reviewState: 'exemption' } : change,
    ),
  };
  storeContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

/**
 * 冻结一份契约的正式版本快照。
 * 快照（含完整 OpenAPI、变更清单与校验值）随契约一次性写入，
 * 不会出现“版本只写了一半”的中间状态。
 */
export function buildFrozenContract(
  contract: ApiContract,
  version: string,
  notes: string,
  releasedAt: string,
): { contract: ApiContract; release: ContractVersion } {
  const release: ContractVersion = {
    id: `ver-${Date.now()}-${contract.id.slice(-6)}`,
    contractId: contract.id,
    version,
    releasedAt,
    checksum: stableChecksum(contract.openapi),
    notes,
    changeIds: contract.changes.map((change) => change.id),
    openapi: contract.openapi,
  };
  return {
    contract: {
      ...contract,
      version,
      status: 'frozen',
      revision: contract.revision + 1,
      versions: [release, ...contract.versions],
    },
    release,
  };
}

export async function freezeVersion(
  contractId: string,
  version: string,
  notes: string,
): Promise<ApiContract> {
  const contracts = loadContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }

  const { contract: frozen } = buildFrozenContract(
    contract,
    version,
    notes,
    new Date().toISOString(),
  );
  storeContracts(contracts.map((item) => (item.id === contractId ? frozen : item)));
  await wait();
  return clone(frozen);
}

export { formatDateTime };

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

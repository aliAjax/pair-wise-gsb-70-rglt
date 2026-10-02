import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  CircleDashed,
  GitMerge,
  Loader2,
  LockKeyhole,
  Play,
  RotateCcw,
  ShieldQuestion,
  TriangleAlert,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  BatchConflictError,
  type CreateBatchInput,
} from '../../services/contract-service';
import {
  useBatches,
  useCommitBatchFreeze,
  useContracts,
  useCreateReleaseBatch,
  useDiscardBatch,
  useStoreRevision,
  useVerifyNextInBatch,
} from '../../services/contract-queries';
import { formatDateTime } from '../../lib/utils';
import type { ApiContract, ReleaseBatch } from '../../models/contract';
import {
  isBlockingPair,
  planReleaseBatch,
  type DependencyEdge,
} from '../../models/release-batch';

function suggestVersion(current: string): string {
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return current;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

/**
 * 批次冻结工作台：
 * 1) 按调用关系排次序，成环/前置待核则整批停在待办并指出挡路关系对；
 * 2) 逐份核验，失败后从留下的待办继续，核完一次原子生成全部快照；
 * 3) 其他标签页抢先确认时，展示对方版本与冲突项，草稿保留、按新次序重走。
 */
export function BatchFreezePanel() {
  const contractsQuery = useContracts();
  const batchesQuery = useBatches();
  const createBatch = useCreateReleaseBatch();
  const verifyNext = useVerifyNextInBatch();
  const commit = useCommitBatchFreeze();
  const discard = useDiscardBatch();

  const contracts = contractsQuery.data ?? [];
  const batches = batchesQuery.data ?? [];
  const storeRevision = useStoreRevision().data;
  const nameById = useMemo(
    () => new Map(contracts.map((contract) => [contract.id, contract.name])),
    [contracts],
  );

  // 手中草稿：即便提交冲突也不清空
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [tempEdges, setTempEdges] = useState<DependencyEdge[]>([]);
  const [edgeDownstream, setEdgeDownstream] = useState('');
  const [edgeUpstream, setEdgeUpstream] = useState('');

  // 建批被挡（成环/前置待核）时展示挡路关系对
  const [blockedPlan, setBlockedPlan] = useState<ReturnType<
    typeof planReleaseBatch
  > | null>(null);

  // 并发冲突：后确认者看到的对方版本与冲突项
  const [conflict, setConflict] = useState<BatchConflictError | null>(null);

  const activeBatch = batches.find((batch) => batch.status !== 'frozen');
  const finishedBatches = batches.filter((batch) => batch.status === 'frozen');

  // 实时预览：草稿选择对应的调用次序与阻断
  const previewPlan = useMemo(
    () => planReleaseBatch(picked, contracts, tempEdges),
    [picked, contracts, tempEdges],
  );

  const [versions, setVersions] = useState<Record<string, string>>({});

  function togglePicked(id: string) {
    setConflict(null);
    setBlockedPlan(null);
    setPicked((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function addTempEdge() {
    if (!edgeDownstream || !edgeUpstream || edgeDownstream === edgeUpstream) return;
    if (
      tempEdges.some(
        (edge) =>
          edge.contractId === edgeDownstream &&
          edge.dependsOnContractId === edgeUpstream,
      )
    ) {
      return;
    }
    setTempEdges((current) => [
      ...current,
      { contractId: edgeDownstream, dependsOnContractId: edgeUpstream, temporary: true },
    ]);
    setEdgeDownstream('');
    setEdgeUpstream('');
  }

  async function submitBatch() {
    if (!picked.length) return;
    const input: CreateBatchInput = {
      name,
      contractIds: previewPlan.order.map((item) => item.contract.id),
      notes,
      temporaryEdges: tempEdges,
    };
    const result = await createBatch.mutateAsync(input);
    if (result.plan.blockers.length) {
      // 整批停在待办：界面指出哪对关系挡路
      setBlockedPlan(result.plan);
      return;
    }
    setBlockedPlan(null);
    setConflict(null);
    if (result.batch) {
      setVersions(
        Object.fromEntries(
          result.batch.orderedIds.map((id) => {
            const contract = contracts.find((item) => item.id === id);
            return [id, contract ? suggestVersion(contract.version) : ''];
          }),
        ),
      );
    }
  }

  async function verify() {
    if (!activeBatch) return;
    setConflict(null);
    await verifyNext.mutateAsync(activeBatch.id);
  }

  async function freeze() {
    if (!activeBatch) return;
    const payload = activeBatch.orderedIds.map((contractId) => ({
      contractId,
      version: versions[contractId] ?? '',
    }));
    if (payload.some((item) => !item.version.trim())) return;
    try {
      await commit.mutateAsync({
        batchId: activeBatch.id,
        versions: payload,
        // 用本标签页观察到的最新库版本；自己补审推进的 revision 不会误判成对方冲突
        expectedRevision: storeRevision || activeBatch.revision,
      });
      // 冻结成功后清空草稿
      setPicked([]);
      setTempEdges([]);
      setName('');
      setNotes('');
      setVersions({});
      setConflict(null);
      setBlockedPlan(null);
    } catch (error) {
      if (error instanceof BatchConflictError) {
        // 后确认者：先看到对方版本和冲突项；草稿（picked/notes/versions）保留
        setConflict(error);
      }
    }
  }

  /** 按最新工作副本重新排次序走一遍，草稿选择保留 */
  async function rerunWithLatest() {
    // 作废建立在旧库版本上的批次，再用最新数据按原草稿重建
    if (activeBatch) {
      await discard.mutateAsync(activeBatch.id);
    }
    const conflictSnapshot = conflict;
    setConflict(null);
    setBlockedPlan(null);

    // 对方已经冻结的契约视为完成，不重复进新批；其余草稿选择保留
    const foreignFrozen = new Set(
      (conflictSnapshot?.releases ?? []).map((release) => release.contractId),
    );
    const remaining = picked.filter((id) => !foreignFrozen.has(id));
    if (!remaining.length) return;

    const result = await createBatch.mutateAsync({
      name,
      contractIds: remaining,
      notes,
      temporaryEdges: tempEdges,
    });
    if (result.plan.blockers.length) {
      setBlockedPlan(result.plan);
      return;
    }
    if (result.batch) {
      setVersions(
        Object.fromEntries(
          result.batch.orderedIds.map((id) => {
            const contract = contracts.find((item) => item.id === id);
            return [id, versions[id] ?? (contract ? suggestVersion(contract.version) : '')];
          }),
        ),
      );
    }
  }

  const shownBlockers = blockedPlan?.blockers ?? (activeBatch ? [] : previewPlan.blockers);
  const liveBlocked = !activeBatch && !blockedPlan && previewPlan.blockers.length > 0;
  const hardBlocked = !!blockedPlan;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitMerge className="h-4 w-4 text-sky-800" />
            按调用关系组批冻结
          </CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            勾选本批契约后，按「上游先于下游」自动排次序；成环或前置项还在待核时，整批停在待办。
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-slate-700">批次名称</label>
              <Input
                className="mt-1.5"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：10 月履约联动发布"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-700">统一发布说明</label>
              <Input
                className="mt-1.5"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="联动范围、兼容层与回滚口径"
              />
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-700">
                本批契约（已选 {picked.length}）
              </span>
              <button
                type="button"
                className="text-xs text-sky-800 hover:underline"
                onClick={() =>
                  setPicked(
                    picked.length === contracts.length
                      ? []
                      : contracts.map((contract) => contract.id),
                  )
                }
              >
                {picked.length === contracts.length ? '全不选' : '全选'}
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {contracts.map((contract) => (
                <label
                  key={contract.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors ${
                    picked.includes(contract.id)
                      ? 'border-sky-300 bg-sky-50'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={picked.includes(contract.id)}
                    onCheckedChange={() => togglePicked(contract.id)}
                  />
                  <span>
                    <span className="block text-sm font-medium text-slate-900">
                      {contract.name}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">
                      v{contract.version} · {contract.domain} ·{' '}
                      {contract.status === 'frozen' ? '已冻结' : '工作副本'}
                      {(contract.dependencies ?? []).length > 0 &&
                        ` · 依赖 ${(contract.dependencies ?? []).length}`}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-dashed border-slate-300 bg-slate-50/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldQuestion className="h-4 w-4 text-slate-600" />
              <span className="text-xs font-medium text-slate-700">
                临时编排调用关系（仅用于本批，可演示成环拦截）
              </span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto]">
              <Select value={edgeDownstream} onValueChange={setEdgeDownstream}>
                <SelectTrigger>
                  <SelectValue placeholder="下游（调用方）" />
                </SelectTrigger>
                <SelectContent>
                  {contracts.map((contract) => (
                    <SelectItem key={contract.id} value={contract.id}>
                      {contract.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="self-center text-xs text-slate-500">依赖</span>
              <Select value={edgeUpstream} onValueChange={setEdgeUpstream}>
                <SelectTrigger>
                  <SelectValue placeholder="上游（被调方）" />
                </SelectTrigger>
                <SelectContent>
                  {contracts.map((contract) => (
                    <SelectItem key={contract.id} value={contract.id}>
                      {contract.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="secondary" size="sm" onClick={addTempEdge}>
                加入关系
              </Button>
            </div>
            {tempEdges.length > 0 && (
              <ul className="mt-2 space-y-1">
                {tempEdges.map((edge) => (
                  <li
                    key={`${edge.dependsOnContractId}-${edge.contractId}`}
                    className="flex items-center gap-2 text-xs text-slate-600"
                  >
                    <Badge tone="amber">临时</Badge>
                    {nameById.get(edge.dependsOnContractId) ?? edge.dependsOnContractId}
                    <ArrowRight className="h-3 w-3" />
                    {nameById.get(edge.contractId) ?? edge.contractId}
                    <button
                      type="button"
                      className="ml-auto text-slate-400 hover:text-red-600"
                      onClick={() =>
                        setTempEdges((current) =>
                          current.filter(
                            (item) =>
                              !(
                                item.contractId === edge.contractId &&
                                item.dependsOnContractId === edge.dependsOnContractId
                              ),
                          ),
                        )
                      }
                      aria-label="移除临时关系"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {picked.length > 0 && <OrderPreview plan={previewPlan} blocked={liveBlocked || hardBlocked} />}

          {shownBlockers.filter(isBlockingPair).length > 0 && (
            <BlockerList
              blockers={shownBlockers.filter(isBlockingPair)}
              persisted={hardBlocked}
            />
          )}

          {!activeBatch && (
            <Button
              className="w-full"
              disabled={!picked.length || liveBlocked || hardBlocked || createBatch.isPending}
              onClick={() => void submitBatch()}
            >
              <Boxes className="h-4 w-4" />
              {hardBlocked
                ? '整批停在待办：先解除挡路关系'
                : liveBlocked
                  ? '存在挡路关系，无法建批'
                  : createBatch.isPending
                    ? '正在排队...'
                    : `按此次序建批（${previewPlan.order.length} 份）`}
            </Button>
          )}
        </CardContent>
      </Card>

      {activeBatch && (
        <BatchRunner
          batch={activeBatch}
          contracts={contracts}
          storeRevision={storeRevision || activeBatch.revision}
          versions={versions}
          onVersionChange={(id, value) =>
            setVersions((current) => ({ ...current, [id]: value }))
          }
          verifying={verifyNext.isPending}
          committing={commit.isPending}
          onVerify={() => void verify()}
          onFreeze={() => void freeze()}
          onDiscard={async () => {
            await discard.mutateAsync(activeBatch.id);
            setBlockedPlan(null);
          }}
        />
      )}

      {conflict && (
        <ConflictBanner
          error={conflict}
          onRerun={() => void rerunWithLatest()}
        />
      )}

      {finishedBatches.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>已冻结批次</CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              每批的版本快照在同一次写入中生成，不会出现半批版本
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {finishedBatches.map((batch) => (
              <div
                key={batch.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-xs"
              >
                <Badge tone="green">已冻结</Badge>
                <span className="text-sm font-medium">{batch.name}</span>
                <span className="text-slate-500">
                  {batch.orderedIds.length} 份 · {batch.frozenAt ? formatDateTime(batch.frozenAt) : ''}
                </span>
                <span className="ml-auto flex flex-wrap items-center gap-1 text-slate-500">
                  {batch.orderedIds.map((id) => nameById.get(id) ?? id).join(' → ')}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function OrderPreview({
  plan,
  blocked,
}: {
  plan: ReturnType<typeof planReleaseBatch>;
  blocked: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        blocked ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-semibold">
        {blocked ? (
          <TriangleAlert className="h-4 w-4 text-red-700" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-emerald-700" />
        )}
        {blocked ? '次序无法确定，整批保持待办' : '冻结次序（上游 → 下游）'}
      </div>
      {plan.order.length > 0 && (
        <ol className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          {plan.order.map((item, index) => [
            <li key={item.contract.id}>
              <span
                className={`inline-flex items-center gap-1 rounded-sm border px-2 py-1 ${
                  item.gateIssues.some((issue) => issue.severity === 'blocker')
                    ? 'border-amber-300 bg-amber-50 text-amber-800'
                    : 'border-slate-300 bg-white text-slate-700'
                }`}
              >
                {item.contract.name}
                {item.gateIssues.some((issue) => issue.severity === 'blocker') && (
                  <TriangleAlert className="h-3 w-3" />
                )}
              </span>
            </li>,
            index < plan.order.length - 1 ? (
              <ArrowRight
                key={`arrow-${item.contract.id}`}
                className="h-3.5 w-3.5 text-slate-400"
              />
            ) : null,
          ])}
        </ol>
      )}
      <p className="mt-2 text-[11px] leading-5 text-slate-600">
        成环节点不会出现在次序中；标黄的契约自身门禁未过，核验时会让整批停在它前面。
      </p>
    </div>
  );
}

function BlockerList({
  blockers,
  persisted,
}: {
  blockers: ReturnType<typeof planReleaseBatch>['blockers'];
  persisted: boolean;
}) {
  return (
    <div className="space-y-2">
      {blockers.map((blocker, index) => (
        <div
          key={`${blocker.kind}-${blocker.pair.join('-')}-${index}`}
          className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
          <div className="text-xs leading-5">
            <div className="flex flex-wrap items-center gap-1.5">
              <strong className="text-sm text-red-800">{blocker.title}</strong>
              <Badge tone="red">挡路关系对</Badge>
              <code className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-[11px] text-red-800">
                {blocker.pair[0]} → {blocker.pair[1]}
              </code>
            </div>
            <p className="mt-1 text-red-700">{blocker.detail}</p>
            {persisted && (
              <p className="mt-1 text-[11px] text-red-600">
                整批已停在待办，解除该关系或补齐前置核验后可直接重试，草稿不会丢失。
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function BatchRunner({
  batch,
  contracts,
  storeRevision,
  versions,
  onVersionChange,
  verifying,
  committing,
  onVerify,
  onFreeze,
  onDiscard,
}: {
  batch: ReleaseBatch;
  contracts: ApiContract[];
  storeRevision: number;
  versions: Record<string, string>;
  onVersionChange: (id: string, value: string) => void;
  verifying: boolean;
  committing: boolean;
  onVerify: () => void;
  onFreeze: () => void;
  onDiscard: () => void;
}) {
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  // 用最新工作副本重算次序，使后确认/其他标签页改动后能看到新次序
  const livePlan = useMemo(
    () => planReleaseBatch(batch.contractIds, contracts),
    [batch.contractIds, contracts],
  );
  const nextId = batch.orderedIds.find((id) => !batch.verifiedIds.includes(id));
  const allVerified = batch.verifiedIds.length === batch.orderedIds.length;
  // 其他标签页已抢先冻结了批内契约
  const foreignFrozen = batch.orderedIds.filter(
    (id) => byId.get(id)?.status === 'frozen',
  );
  const drift =
    livePlan.blockers.length > 0 ||
    foreignFrozen.length > 0 ||
    livePlan.order.some(
      (item, index) => item.contract.id !== batch.orderedIds[index],
    );

  return (
    <Card className="border-sky-200 ring-1 ring-sky-100">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Loader2 className={`h-4 w-4 text-sky-800 ${verifying || committing ? 'animate-spin' : ''}`} />
            {batch.name}
          </CardTitle>
          <Badge tone={allVerified ? 'green' : 'amber'}>
            {allVerified ? '全部核验通过，待冻结' : `核验 ${batch.verifiedIds.length}/${batch.orderedIds.length}`}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          建批于 {formatDateTime(batch.createdAt)} · 建批库版本 {batch.revision} · 当前库版本 {storeRevision}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="space-y-2">
          {batch.orderedIds.map((id, index) => {
            const contract = byId.get(id);
            const isVerified = batch.verifiedIds.includes(id);
            const isNext = id === nextId;
            const failedHere = batch.failedAtId === id;
            return (
              <li
                key={id}
                className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2.5 ${
                  failedHere
                    ? 'border-red-200 bg-red-50'
                    : isVerified
                      ? 'border-emerald-200 bg-emerald-50/60'
                      : isNext
                        ? 'border-amber-300 bg-amber-50/60'
                        : 'border-slate-200'
                }`}
              >
                <span className="grid h-6 w-6 place-items-center rounded-sm bg-white text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                  {index + 1}
                </span>
                {isVerified ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : failedHere ? (
                  <TriangleAlert className="h-4 w-4 text-red-600" />
                ) : (
                  <CircleDashed className="h-4 w-4 text-slate-400" />
                )}
                <div className="min-w-0">
                  <div className="text-sm font-medium">{contract?.name ?? id}</div>
                  <div className="text-xs text-slate-500">
                    {isVerified
                      ? '已逐份核验通过'
                      : failedHere
                        ? batch.failReason ?? '校验失败，待修复后重试'
                        : isNext
                          ? '下一份待办：从这里开始/继续核验'
                          : '待办（等待上游）'}
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {isVerified && (
                    <>
                      <span className="text-xs text-slate-500">快照版本</span>
                      <Input
                        className="h-8 w-28 text-xs"
                        value={versions[id] ?? ''}
                        onChange={(event) => onVersionChange(id, event.target.value)}
                        placeholder="x.y.z"
                      />
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {drift && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              {foreignFrozen.length > 0 ? (
                <>
                  另一个标签页已经冻结了本批中的{' '}
                  {foreignFrozen.map((id) => byId.get(id)?.name ?? id).join('、')}
                  。继续提交会被拦下；点下方提交查看对方版本与冲突项，或直接撤批后按新次序重走，你的草稿会保留。
                </>
              ) : (
                <>
                  工作副本已被其他标签页改动，按最新数据重算的调用次序与本批不一致
                  {livePlan.blockers.length > 0 && `：${livePlan.blockers[0].title}`}
                  。继续冻结会在提交时被拦下，请修复冲突项后按新次序重走。
                </>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!allVerified ? (
            <Button onClick={onVerify} disabled={verifying || committing || drift}>
              {batch.failedAtId ? (
                <>
                  <RotateCcw className="h-4 w-4" />
                  {verifying ? '核验中...' : '从待办重试'}
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" />
                  {verifying
                    ? '正在逐份核验...'
                    : batch.verifiedIds.length
                      ? '继续核验下一份'
                      : '开始逐份核验'}
                </>
              )}
            </Button>
          ) : (
            <Button onClick={onFreeze} disabled={committing || (drift && foreignFrozen.length === 0) || !allVersionFilled(batch, versions)}>
              <LockKeyhole className="h-4 w-4" />
              {committing
                ? '正在一次生成整批快照...'
                : `核完，一次生成 ${batch.orderedIds.length} 份版本快照`}
            </Button>
          )}
          <Button variant="ghost" onClick={onDiscard} disabled={verifying || committing}>
            <Trash2 className="h-4 w-4" />
            撤批
          </Button>
        </div>
        <p className="text-[11px] leading-5 text-slate-500">
          中途某份校验失败时，已核验进度保留、未生成任何版本；修复后从留下的待办继续。
          冻结瞬间会在同一次写入中重校全部契约，任一失败则整批不落库。
        </p>
      </CardContent>
    </Card>
  );
}

function allVersionFilled(batch: ReleaseBatch, versions: Record<string, string>): boolean {
  return batch.orderedIds.every((id) => (versions[id] ?? '').trim().length > 0);
}

function ConflictBanner({
  error,
  onRerun,
}: {
  error: BatchConflictError;
  onRerun: () => void;
}) {
  return (
    <Card className="border-red-300 ring-1 ring-red-100">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-red-800">
          <GitMerge className="h-4 w-4" />
          另一个标签页已先确认本批
        </CardTitle>
        <p className="mt-1 text-xs text-slate-500">
          对方先拿到库版本 {error.latestRevision}。你手中的勾选、说明和版本号草稿都还在，下面是对方版本与冲突项。
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <strong className="text-xs font-medium text-slate-700">对方已冻结版本</strong>
          {error.releases.length ? (
            <ul className="mt-1.5 space-y-1">
              {error.releases.map((release) => (
                <li
                  key={release.contractId}
                  className="flex items-center gap-2 text-xs text-slate-700"
                >
                  <Badge tone="slate">v{release.version}</Badge>
                  {release.contractName}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-slate-500">对方改动了工作副本，但未冻结本批契约。</p>
          )}
        </div>
        <div>
          <strong className="text-xs font-medium text-slate-700">冲突契约</strong>
          {error.changedContracts.length ? (
            <ul className="mt-1.5 space-y-1">
              {error.changedContracts.map((item) => (
                <li key={item.contractId} className="text-xs text-slate-700">
                  {item.contractName}：基线校验值{' '}
                  <code className="font-mono">{item.base}</code> → 最新{' '}
                  <code className="font-mono text-red-700">{item.latest}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-slate-500">本批契约内容未变，只是库版本被对方推进。</p>
          )}
        </div>
        <Button variant="secondary" onClick={onRerun}>
          <RotateCcw className="h-4 w-4" />
          知道了，按新次序重走（草稿保留）
        </Button>
      </CardContent>
    </Card>
  );
}

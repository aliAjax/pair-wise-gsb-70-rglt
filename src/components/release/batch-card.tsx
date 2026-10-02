import { Link } from '@tanstack/react-router';
import {
  AlertOctagon,
  ArrowDownToLine,
  ArrowRight,
  Ban,
  CheckCircle2,
  CircleDashed,
  CopyPlus,
  RefreshCcw,
  Trash2,
  TriangleAlert,
  Workflow,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ApiContract } from '../../models/contract';
import {
  BATCH_STATUS_LABELS,
  ENTRY_STATUS_LABELS,
  type BatchBlocker,
  type ReleaseBatch,
} from '../../models/batch';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Progress } from '../ui/progress';
import { Textarea } from '../ui/textarea';
import { formatDateTime } from '../../lib/utils';
import {
  useConfirmBatch,
  useDeleteBatch,
  useReplanBatch,
  useRetryBatch,
  useUpdateDraft,
} from '../../services/batch-queries';

const STATUS_TONE: Record<ReleaseBatch['status'], 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'slate'> = {
  todo: 'neutral',
  running: 'blue',
  blocked: 'red',
  partial: 'amber',
  done: 'green',
};

const BLOCKER_META: Record<BatchBlocker['type'], { label: string; icon: typeof Ban }> = {
  cycle: { label: '调用关系成环', icon: AlertOctagon },
  pending_prerequisite: { label: '上游仍在待核', icon: Workflow },
  missing_dependency: { label: '上游契约缺失', icon: Ban },
};

export function BatchCard({ batch, contracts }: { batch: ReleaseBatch; contracts: ApiContract[] }) {
  const confirm = useConfirmBatch();
  const retry = useRetryBatch();
  const replan = useReplanBatch();
  const remove = useDeleteBatch();
  const updateDraft = useUpdateDraft();
  const [showConflictDetail, setShowConflictDetail] = useState(false);

  const byId = useMemo(() => new Map(contracts.map((contract) => [contract.id, contract])), [contracts]);
  const entries = [...batch.entries].sort((a, b) => a.order - b.order);
  const frozenCount = entries.filter((entry) => entry.status === 'frozen').length;
  const progress = entries.length ? (frozenCount / entries.length) * 100 : 0;
  const hasFailed = entries.some((entry) => entry.status === 'failed');
  const hasConflict = Boolean(batch.conflicts?.length);

  function blockerPair(blocker: BatchBlocker) {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-xs">
        <span className="rounded-sm bg-red-100 px-1.5 py-0.5 font-sans text-red-800">
          {byId.get(blocker.fromContractId)?.name ?? blocker.fromContractId}
        </span>
        <ArrowRight className="h-3 w-3 text-red-400" />
        <span className="rounded-sm bg-red-100 px-1.5 py-0.5 font-sans text-red-800">
          {byId.get(blocker.toContractId)?.name ?? blocker.toContractId}
        </span>
      </span>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              {batch.label}
              <Badge tone={STATUS_TONE[batch.status]}>{BATCH_STATUS_LABELS[batch.status]}</Badge>
            </CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              创建于 {formatDateTime(batch.createdAt)} · {frozenCount}/{entries.length} 份已冻结
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void remove.mutateAsync(batch.id)}>
            <Trash2 className="h-3.5 w-3.5" />
            删除批次
          </Button>
        </div>
        <Progress className="mt-3" value={progress} />
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 调用关系挡路：指出具体是哪一对 */}
        {batch.blockers.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-red-800">
              <XCircle className="h-4 w-4" />
              整批停在待办：{batch.blockers.length} 对关系挡路
            </div>
            <ul className="mt-2 space-y-2">
              {batch.blockers.map((blocker, index) => {
                const meta = BLOCKER_META[blocker.type];
                const Icon = meta.icon;
                return (
                  <li key={`${blocker.fromContractId}-${blocker.toContractId}-${index}`} className="text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="red">
                        <Icon className="mr-1 h-3 w-3" />
                        {meta.label}
                      </Badge>
                      {blockerPair(blocker)}
                    </div>
                    <p className="mt-1 leading-5 text-red-800/80">{blocker.detail}</p>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-[11px] text-red-700/80">
              解除关系（补评审、把上游纳入本批或消除环）后点「按新次序重走」。
            </p>
          </div>
        )}

        {/* 跨标签页冲突：后确认者看到对方版本与冲突项 */}
        {hasConflict && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
              <CopyPlus className="h-4 w-4" />
              另一标签页已提交同一批 · {batch.conflicts!.length} 项冲突
              {batch.conflictAt && (
                <span className="ml-auto text-[11px] font-normal text-amber-700">
                  发现于 {formatDateTime(batch.conflictAt)}
                </span>
              )}
            </div>
            <ul className="mt-2 space-y-2">
              {batch.conflicts!.map((conflict) => {
                const contract = byId.get(conflict.contractId);
                return (
                  <li key={conflict.contractId} className="rounded-md border border-amber-200 bg-white p-2.5 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">
                        {contract?.name ?? conflict.contractId}
                      </span>
                      {conflict.reason === 'frozen_by_other' && (
                        <Badge tone="green">对方已冻结 v{conflict.otherVersion}</Badge>
                      )}
                      {conflict.reason === 'changed_by_other' && (
                        <Badge tone="amber">对方更新了工作副本</Badge>
                      )}
                      {conflict.reason === 'missing' && <Badge tone="red">契约缺失</Badge>}
                    </div>
                    <p className="mt-1 leading-5 text-slate-600">{conflict.detail}</p>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-[11px] leading-5 text-amber-800">
              手中草稿（目标版本与发布说明）原样保留。确认对方版本后点「按新次序重走」，
              已被对方冻结的份会对齐为外部冻结、不再重复生成快照，其余按新拓扑次序继续。
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              disabled={replan.isPending}
              onClick={() => void replan.mutateAsync(batch.id)}
            >
              <RefreshCcw className="h-3.5 w-3.5" />
              {replan.isPending ? '正在对齐并重排' : '按新次序重走'}
            </Button>
          </div>
        )}

        {/* 中途失败说明 */}
        {hasFailed && batch.lastError && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">{batch.lastError}</p>
              <p className="mt-0.5 text-amber-800">
                修复门禁项后点「从待办重试」，将从失败的这份继续；已冻结版本完整保留，不会重复冻结。
              </p>
            </div>
          </div>
        )}

        {/* 逐份条目：上游在前 */}
        <ol className="space-y-2">
          {entries.map((entry, index) => {
            const contract = byId.get(entry.contractId);
            const isLast = index === entries.length - 1;
            return (
              <li key={entry.contractId}>
                <div className="rounded-md border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="grid h-6 w-6 place-items-center rounded-full bg-slate-900 text-[11px] font-semibold text-white">
                      {index + 1}
                    </span>
                    <span className="text-sm font-medium text-slate-900">
                      {contract?.name ?? entry.contractId}
                    </span>
                    <Badge
                      tone={
                        entry.status === 'frozen'
                          ? 'green'
                          : entry.status === 'failed'
                            ? 'red'
                            : 'neutral'
                      }
                    >
                      {entry.status === 'frozen' && <CheckCircle2 className="mr-1 h-3 w-3" />}
                      {entry.status === 'failed' && <XCircle className="mr-1 h-3 w-3" />}
                      {entry.status === 'todo' && <CircleDashed className="mr-1 h-3 w-3" />}
                      {ENTRY_STATUS_LABELS[entry.status]}
                    </Badge>
                    {entry.external && <Badge tone="slate">另一标签页冻结</Badge>}
                    <span className="ml-auto flex flex-wrap items-center gap-1.5">
                      {(contract?.dependencies ?? [])
                        .map((depId) => entries.find((item) => item.contractId === depId))
                        .filter(Boolean)
                        .map((upstream) => (
                          <span
                            key={upstream!.contractId}
                            className="inline-flex items-center gap-1 text-[11px] text-slate-500"
                          >
                            <ArrowRight className="h-3 w-3" />
                            先于 {byId.get(upstream!.contractId)?.name}
                          </span>
                        ))}
                    </span>
                  </div>

                  {entry.status === 'frozen' ? (
                    <div className="mt-2.5 flex flex-wrap items-center gap-3 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>
                        已生成完整版本快照 <strong>v{entry.frozenVersion}</strong>
                      </span>
                      <span className="text-emerald-700">
                        {entry.frozenAt ? formatDateTime(entry.frozenAt) : ''}
                      </span>
                      {contract && (
                        <Link
                          to="/contracts/$contractId"
                          params={{ contractId: contract.id }}
                          className="ml-auto font-medium text-emerald-800 hover:underline"
                        >
                          查看快照与差异
                        </Link>
                      )}
                    </div>
                  ) : (
                    <div className="mt-2.5 grid gap-2 sm:grid-cols-[140px_1fr]">
                      <Input
                        value={entry.targetVersion}
                        onChange={(event) =>
                          void updateDraft.mutateAsync({
                            batchId: batch.id,
                            contractId: entry.contractId,
                            targetVersion: event.target.value,
                            notes: entry.notes,
                          })
                        }
                        placeholder="目标版本号"
                        className="h-8 text-xs"
                      />
                      <Textarea
                        value={entry.notes}
                        onChange={(event) =>
                          void updateDraft.mutateAsync({
                            batchId: batch.id,
                            contractId: entry.contractId,
                            targetVersion: entry.targetVersion,
                            notes: event.target.value,
                          })
                        }
                        placeholder="本份发布说明（草稿，失败后可调整再重试）"
                        className="min-h-8 text-xs"
                        rows={1}
                      />
                    </div>
                  )}

                  {entry.status === 'failed' && entry.issues && (
                    <div className="mt-2.5 rounded-md border border-red-200 bg-red-50 p-2.5">
                      <p className="flex items-center gap-1.5 text-xs font-semibold text-red-800">
                        <TriangleAlert className="h-3.5 w-3.5" />
                        {entry.detail}
                      </p>
                      <ul className="mt-1.5 space-y-1">
                        {entry.issues.map((issue) => (
                          <li key={issue.id} className="text-[11px] leading-5 text-red-800/90">
                            <strong>{issue.title}：</strong>
                            {issue.detail}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                {!isLast && (
                  <div className="flex justify-center py-0.5" aria-hidden>
                    <ArrowDownToLine className="h-3.5 w-3.5 text-slate-300" />
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          {hasFailed ? (
            <Button
              disabled={batch.status === 'blocked' || batch.status === 'done' || retry.isPending}
              onClick={() => void retry.mutateAsync(batch.id)}
            >
              {retry.isPending ? (
                <>
                  <RefreshCcw className="h-4 w-4 animate-spin" />
                  正在重排并从待办继续
                </>
              ) : (
                <>
                  <ArrowDownToLine className="h-4 w-4" />
                  从待办重试
                </>
              )}
            </Button>
          ) : (
            <Button
              disabled={
                batch.status === 'blocked' ||
                batch.status === 'done' ||
                confirm.isPending ||
                !entries.some((entry) => entry.status !== 'frozen')
              }
              onClick={() => void confirm.mutateAsync({ batchId: batch.id, draft: batch })}
            >
              {confirm.isPending ? (
                <>
                  <RefreshCcw className="h-4 w-4 animate-spin" />
                  正在按序冻结
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  确认整批并按序冻结
                </>
              )}
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={replan.isPending || batch.status === 'done'}
            onClick={() => void replan.mutateAsync(batch.id)}
          >
            <RefreshCcw className="h-4 w-4" />
            重新按调用关系排序
          </Button>
          {hasConflict && (
            <Button variant="ghost" onClick={() => setShowConflictDetail((value) => !value)}>
              {showConflictDetail ? '收起冲突说明' : '冲突处理说明'}
            </Button>
          )}
        </div>
        {showConflictDetail && hasConflict && (
          <p className="text-[11px] leading-5 text-slate-500">
            并发规则：同一批在两个标签页打开时，先确认者正常推进；后确认者提交时系统逐份比对修订号，
            只把对方已冻结版本与冲突项展示出来，绝不覆盖任何一方草稿。对齐后按新次序重走，
            外部冻结的份跳过，剩余份继续从待办执行。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

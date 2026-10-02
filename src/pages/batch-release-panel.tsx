import { GitMerge, LockKeyhole, ShieldCheck, Workflow } from 'lucide-react';
import { BatchCard } from '../components/release/batch-card';
import { BatchCreateCard } from '../components/release/batch-create-card';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { useBatches } from '../services/batch-queries';
import { useContracts } from '../services/contract-queries';

export function BatchReleasePanel() {
  const contracts = useContracts();
  const batches = useBatches();

  const list = batches.data ?? [];

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        {batches.isLoading ? (
          <Card>
            <CardContent className="py-16 text-center text-sm text-slate-500">
              正在载入发布批次...
            </CardContent>
          </Card>
        ) : list.length ? (
          list.map((batch) => (
            <BatchCard key={batch.id} batch={batch} contracts={contracts.data ?? []} />
          ))
        ) : (
          <Card>
            <CardContent className="py-16 text-center text-sm text-slate-500">
              还没有发布批次。在右侧凑批后，系统会先按调用关系编排次序。
            </CardContent>
          </Card>
        )}
      </div>

      <div className="space-y-4">
        <BatchCreateCard contracts={contracts.data ?? []} />
        <Card>
          <CardHeader>
            <CardTitle>批次冻结规则</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-slate-600">
            <Policy icon={Workflow} text="严格按调用关系排序：上游（被依赖方）冻结后才轮到下游。" />
            <Policy
              icon={GitMerge}
              text="关系成环，或批次外前置项还在待核，整批停在待办，并点名是哪对关系挡路。"
            />
            <Policy
              icon={ShieldCheck}
              text="逐份“先校验、后生成快照”；中途某份失败立即停，已生成快照完整，修复后从留下的待办重试。"
            />
            <Policy
              icon={LockKeyhole}
              text="另一个标签页同时确认同一批时，后确认者先看到对方版本与冲突项；草稿保留，可按新次序重走。"
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Policy({ icon: Icon, text }: { icon: typeof Workflow; text: string }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-sky-800" />
      <span>{text}</span>
    </div>
  );
}

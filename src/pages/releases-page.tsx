import { Link } from '@tanstack/react-router';
import { Archive, LockKeyhole, PackageCheck } from 'lucide-react';
import { useMemo } from 'react';
import { BatchFreezePanel } from '../components/contract/batch-freeze-panel';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { formatDateTime } from '../lib/utils';
import { useContracts } from '../services/contract-queries';

export function ReleasesPage() {
  const contracts = useContracts();

  const versions = useMemo(
    () =>
      (contracts.data ?? [])
        .flatMap((contract) =>
          contract.versions.map((release) => ({ contract, release })),
        )
        .sort(
          (left, right) =>
            new Date(right.release.releasedAt).getTime() -
            new Date(left.release.releasedAt).getTime(),
        ),
    [contracts.data],
  );

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">Release Center</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">
          契约版本发布
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          把几份契约凑成一批时，先按调用关系确定上游优先的冻结次序：碰成环或前置项还在待核，整批停在待办并指出挡路的关系对。
          逐份核验通过后一次生成全部版本快照；中途失败从留下的待办重试，任何时刻都不会只写出半批版本。
        </p>
      </div>

      <BatchFreezePanel />

      <Card>
        <CardHeader>
          <CardTitle>正式版本记录</CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            {versions.length} 个冻结版本，新版本永不覆盖旧版
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">契约</th>
                  <th className="px-4 py-3 font-medium">版本</th>
                  <th className="px-4 py-3 font-medium">发布时间</th>
                  <th className="px-4 py-3 font-medium">校验值</th>
                  <th className="px-4 py-3 font-medium">发布说明</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {versions.map(({ contract, release }) => (
                  <tr key={release.id} className="border-t border-slate-100">
                    <td className="px-4 py-4">
                      <div className="font-medium">{contract.name}</div>
                      <div className="mt-1 text-xs text-slate-500">{contract.domain}</div>
                    </td>
                    <td className="px-4 py-4">
                      <Badge tone="slate">v{release.version}</Badge>
                      {release.batchId && (
                        <Badge className="ml-1" tone="blue">
                          批次
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-4 text-slate-600">
                      {formatDateTime(release.releasedAt)}
                    </td>
                    <td className="px-4 py-4 font-mono text-xs text-slate-600">
                      {release.checksum}
                    </td>
                    <td className="max-w-md px-4 py-4 text-slate-600">{release.notes}</td>
                    <td className="px-4 py-4 text-right">
                      <Link
                        to="/contracts/$contractId"
                        params={{ contractId: contract.id }}
                        className="text-xs font-medium text-sky-800 hover:underline"
                      >
                        查看版本
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!versions.length && (
              <p className="px-4 py-16 text-center text-sm text-slate-500">
                尚无冻结的正式版本。
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>批次冻结策略</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm text-slate-600 sm:grid-cols-3">
          <Policy
            icon={PackageCheck}
            title="按调用关系排序"
            text="上游（被调方）先冻结；成环或前置项待核时整批停在待办，并标出挡路关系对。"
          />
          <Policy
            icon={Archive}
            title="原子版本快照"
            text="逐份核验通过后，所有契约的版本快照在同一次写入落库；中途失败从待办重试，不留半批版本。"
          />
          <Policy
            icon={LockKeyhole}
            title="多标签页并发"
            text="后确认者先看到对方版本与冲突项；手中草稿保留，可按新次序重走。"
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Policy({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Archive;
  title: string;
  text: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-sky-800" />
      <div>
        <div className="font-medium text-slate-800">{title}</div>
        <p className="mt-1 text-xs leading-5">{text}</p>
      </div>
    </div>
  );
}

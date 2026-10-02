import { GitBranch, ListOrdered, Plus, Workflow } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ApiContract } from '../../models/contract';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Checkbox } from '../../components/ui/checkbox';
import { Input } from '../../components/ui/input';
import { useCreateBatch, useUpdateDependencies } from '../../services/batch-queries';

export function BatchCreateCard({ contracts }: { contracts: ApiContract[] }) {
  const createBatch = useCreateBatch();
  const updateDependencies = useUpdateDependencies();
  const [label, setLabel] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [dependencyEditing, setDependencyEditing] = useState<string | null>(null);

  const nameById = useMemo(
    () => new Map(contracts.map((contract) => [contract.id, contract])),
    [contracts],
  );

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  async function submit() {
    if (!selected.length) return;
    await createBatch.mutateAsync({
      label: label.trim(),
      contractIds: selected,
    });
    setLabel('');
    setSelected([]);
  }

  async function toggleDependency(contractId: string, depId: string) {
    const contract = nameById.get(contractId);
    if (!contract) return;
    const next = contract.dependencies.includes(depId)
      ? contract.dependencies.filter((id) => id !== depId)
      : [...contract.dependencies, depId];
    await updateDependencies.mutateAsync({ contractId, dependencies: next });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListOrdered className="h-4 w-4 text-sky-800" />
          凑一批发布
        </CardTitle>
        <p className="mt-1 text-xs text-slate-500">
          勾选要凑批的契约，系统按调用关系自动排出上游在前的冻结次序；成环或前置项还在待核时整批停在待办。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="text-xs font-medium text-slate-700">批次名称（可选）</label>
          <Input
            className="mt-1.5"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="例如：十月初履约链路发布批"
          />
        </div>

        <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {contracts.map((contract) => {
            const checked = selected.includes(contract.id);
            return (
              <div key={contract.id} className="px-3 py-3">
                <div className="flex items-start gap-3">
                  <Checkbox
                    className="mt-0.5"
                    checked={checked}
                    onCheckedChange={() => toggle(contract.id)}
                    aria-label={`选择 ${contract.name}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-slate-900">{contract.name}</span>
                      <Badge tone="neutral">v{contract.version}</Badge>
                      {contract.status === 'frozen' && <Badge tone="slate">已冻结</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Workflow className="h-3 w-3 text-slate-400" />
                      {contract.dependencies.length ? (
                        contract.dependencies.map((depId) => (
                          <Badge key={depId} tone="blue">
                            依赖 {nameById.get(depId)?.name ?? depId}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs text-slate-400">无上游依赖（链路起点）</span>
                      )}
                      <button
                        type="button"
                        className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-sky-800 hover:underline"
                        onClick={() =>
                          setDependencyEditing((current) => (current === contract.id ? null : contract.id))
                        }
                      >
                        <GitBranch className="h-3 w-3" />
                        调整调用关系
                      </button>
                    </div>

                    {dependencyEditing === contract.id && (
                      <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2.5">
                        <p className="text-[11px] text-slate-500">
                          勾选该契约调用的上游（上游必须先冻结）。把关系调成互相依赖即可模拟成环。
                        </p>
                        <div className="mt-2 space-y-1.5">
                          {contracts
                            .filter((item) => item.id !== contract.id)
                            .map((candidate) => (
                              <label
                                key={candidate.id}
                                className="flex items-center gap-2 text-xs text-slate-700"
                              >
                                <Checkbox
                                  checked={contract.dependencies.includes(candidate.id)}
                                  onCheckedChange={() =>
                                    void toggleDependency(contract.id, candidate.id)
                                  }
                                />
                                {candidate.name}
                              </label>
                            ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <Button
          className="w-full"
          disabled={!selected.length || createBatch.isPending}
          onClick={() => void submit()}
        >
          <Plus className="h-4 w-4" />
          {createBatch.isPending ? '正在编排批次' : `按调用关系编排 ${selected.length} 份契约`}
        </Button>
      </CardContent>
    </Card>
  );
}

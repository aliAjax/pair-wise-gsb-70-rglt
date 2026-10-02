import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReleaseBatch } from '../models/batch';
import {
  confirmBatch,
  createBatch,
  deleteBatch,
  listBatches,
  replanBatch,
  retryBatch,
  updateDraft,
} from './batch-service';
import { updateContractDependencies } from './contract-service';

export const batchKeys = {
  all: ['release-batches'] as const,
};

export function useBatches() {
  return useQuery({
    queryKey: batchKeys.all,
    queryFn: listBatches,
  });
}

export function useCreateBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { label: string; contractIds: string[] }) =>
      createBatch(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: batchKeys.all }),
  });
}

export function useReplanBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => replanBatch(batchId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: batchKeys.all });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
    },
  });
}

export function useUpdateDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      batchId: string;
      contractId: string;
      targetVersion: string;
      notes: string;
    }) =>
      updateDraft(input.batchId, input.contractId, {
        targetVersion: input.targetVersion,
        notes: input.notes,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: batchKeys.all }),
  });
}

export function useConfirmBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { batchId: string; draft?: ReleaseBatch }) =>
      confirmBatch(input.batchId, input.draft),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: batchKeys.all });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
    },
  });
}

export function useRetryBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => retryBatch(batchId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: batchKeys.all });
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
    },
  });
}

export function useDeleteBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteBatch,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: batchKeys.all }),
  });
}

export function useUpdateDependencies() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; dependencies: string[] }) =>
      updateContractDependencies(input.contractId, input.dependencies),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contracts'] }),
  });
}

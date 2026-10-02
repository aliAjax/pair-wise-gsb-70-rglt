import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ReviewState } from '../models/contract';
import {
  addExemption,
  bulkReviewChanges,
  commitBatchFreeze,
  createReleaseBatch,
  discardReleaseBatch,
  freezeVersion,
  getContract,
  getStoreRevision,
  listBatches,
  listContracts,
  reviewChange,
  saveContract,
  updateContractOpenApi,
  verifyNextInBatch,
  type CreateBatchInput,
} from './contract-service';

export const contractKeys = {
  all: ['contracts'] as const,
  detail: (id: string) => ['contracts', id] as const,
  batches: ['release-batches'] as const,
  revision: ['store-revision'] as const,
};

/** 本标签页观察到的最新库版本；所有写操作和其他标签页 storage 事件都会刷新它 */
export function useStoreRevision() {
  return useQuery({
    queryKey: contractKeys.revision,
    queryFn: async () => getStoreRevision(),
    initialData: 0,
  });
}

/**
 * 另一个标签页提交后，本标签页通过 storage 事件立刻拿到最新工作副本，
 * 让后确认者先看到对方冻结出来的版本与冲突项。
 */
export function useCrossTabSync() {
  const queryClient = useQueryClient();
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (
        event.key === 'pair-wise-gsb-70-contracts' ||
        event.key === 'pair-wise-gsb-70-release-batches' ||
        event.key === null
      ) {
        refreshAll(queryClient);
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [queryClient]);
}

function refreshAll(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: contractKeys.all });
  void queryClient.invalidateQueries({ queryKey: contractKeys.batches });
  void queryClient.invalidateQueries({ queryKey: contractKeys.revision });
}

export function useContracts() {
  return useQuery({
    queryKey: contractKeys.all,
    queryFn: listContracts,
  });
}

export function useBatches() {
  return useQuery({
    queryKey: contractKeys.batches,
    queryFn: listBatches,
  });
}

export function useContract(id: string) {
  return useQuery({
    queryKey: contractKeys.detail(id),
    queryFn: () => getContract(id),
    enabled: Boolean(id),
  });
}

export function useReviewChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      contractId: string;
      changeId: string;
      state: ReviewState;
      reviewer: string;
      comment: string;
    }) =>
      reviewChange(
        input.contractId,
        input.changeId,
        input.state,
        input.reviewer,
        input.comment,
      ),
    onSuccess: () => refreshAll(queryClient),
  });
}

export function useBulkReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      selections: Array<{ contractId: string; changeId: string }>;
      state: ReviewState;
      reviewer: string;
      comment: string;
    }) =>
      bulkReviewChanges(
        input.selections,
        input.state,
        input.reviewer,
        input.comment,
      ),
    onSuccess: () => refreshAll(queryClient),
  });
}

export function useUpdateOpenApi() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; openapi: string }) =>
      updateContractOpenApi(input.contractId, input.openapi),
    onSuccess: () => refreshAll(queryClient),
  });
}

export function useSaveContract() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveContract,
    onSuccess: () => refreshAll(queryClient),
  });
}

export function useAddExemption() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; changeId: string; reason: string }) =>
      addExemption(input.contractId, input.changeId, input.reason),
    onSuccess: () => refreshAll(queryClient),
  });
}

export function useFreezeVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; version: string; notes: string }) =>
      freezeVersion(input.contractId, input.version, input.notes),
    onSuccess: () => refreshAll(queryClient),
  });
}

export function useCreateReleaseBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBatchInput) => createReleaseBatch(input),
    onSuccess: () => refreshAll(queryClient),
  });
}

export function useVerifyNextInBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => verifyNextInBatch(batchId),
    onSuccess: () => refreshAll(queryClient),
  });
}

export function useCommitBatchFreeze() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      batchId: string;
      versions: Array<{ contractId: string; version: string }>;
      expectedRevision: number;
    }) => commitBatchFreeze(input),
    onSuccess: () => refreshAll(queryClient),
  });
}

export function useDiscardBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => discardReleaseBatch(batchId),
    onSuccess: () => refreshAll(queryClient),
  });
}

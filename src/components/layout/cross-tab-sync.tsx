import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';

/**
 * 另一个标签页提交同一批时，本地通过 storage 事件即时拿到
 * 对方冻结的版本与批次状态，供冲突面板展示（手中草稿不受影响）。
 */
export function CrossTabSync({ queryClient }: { queryClient: QueryClient }) {
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === 'pair-wise-gsb-70-contracts' ||
        event.key === 'pair-wise-gsb-70-release-batches'
      ) {
        queryClient.invalidateQueries({ queryKey: ['contracts'] });
        queryClient.invalidateQueries({ queryKey: ['release-batches'] });
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [queryClient]);
  return null;
}

import { persistQueryClientRestore, persistQueryClientSubscribe } from '@tanstack/query-persist-client-core';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { QueryClient } from '@tanstack/vue-query';

// 30 天:对齐原 src/store/git.ts 中 commit stats 落盘的最长保留窗口,
// 也覆盖 PR 列表/详情的 7 天窗口。单条 TTL 由各 domain 的 staleTime/gcTime 控制。
const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PERSIST_STORAGE_KEY = 'calamex.vue-query';
// 缓存结构/键规则变化时递增,等价于原来的 versioned cache key。
const PERSIST_BUSTER = '1';

const structurallyShareSerializableData = (oldData: unknown, newData: unknown): unknown => {
  if (oldData === undefined || oldData === newData) {
    return newData;
  }

  try {
    return JSON.stringify(oldData) === JSON.stringify(newData) ? oldData : newData;
  } catch {
    return newData;
  }
};

class CalamexQueryClient extends QueryClient {
  override fetchQuery(
    options: Parameters<QueryClient['fetchQuery']>[0],
  ): ReturnType<QueryClient['fetchQuery']> {
    const previousData = this.getQueryData(options.queryKey);

    return super.fetchQuery(options).then((data) => {
      const cachedData = this.getQueryData(options.queryKey) ?? data;
      const sharedData = structurallyShareSerializableData(previousData, cachedData);

      if (sharedData !== cachedData) {
        this.setQueryData(options.queryKey, sharedData);
      }

      return sharedData as Awaited<ReturnType<QueryClient['fetchQuery']>>;
    }) as ReturnType<QueryClient['fetchQuery']>;
  }
}

/**
 * 全局共享的 TanStack QueryClient。
 *
 * 默认把 server-state 的新鲜窗口设为 30s,对齐原 git store 里
 * PULL_REQUEST_*_REVALIDATE_INTERVAL_MS 的手写 TTL;后台失焦不自动重取,
 * 由各 composable/调用方按需 invalidate,保持与原有“显式刷新”语义一致。
 */
export const queryClient = new CalamexQueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: PERSIST_MAX_AGE_MS,
      retry: 1,
      refetchOnWindowFocus: false,
      structuralSharing: structurallyShareSerializableData,
    },
  },
});

const getPersistStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

let persistenceUnsubscribe: (() => void) | null = null;

/**
 * 接入官方 sync-storage 持久化,替代 git store 里手写的
 * localStorage 序列化/版本校验/prune/removeItem 样板。
 *
 * 仅持久化显式标记 `meta: { persist: true }` 且已成功的查询(PR 列表、PR 详情、
 * commit stats),其余 server-state 仅驻留内存——与原实现“只有这几类缓存落盘”一致。
 * 幂等:重复调用不会重复订阅。
 */
export const setupQueryPersistence = async (): Promise<void> => {
  const storage = getPersistStorage();
  if (!storage || persistenceUnsubscribe) return;

  const persister = createSyncStoragePersister({
    storage,
    key: PERSIST_STORAGE_KEY,
  });

  const persistOptions = {
    queryClient,
    persister,
    maxAge: PERSIST_MAX_AGE_MS,
    buster: PERSIST_BUSTER,
    dehydrateOptions: {
      shouldDehydrateQuery: (query: { meta?: Record<string, unknown>; state: { status: string } }) =>
        query.meta?.persist === true && query.state.status === 'success',
    },
  };

  try {
    await persistQueryClientRestore(persistOptions);
  } catch (error) {
    console.warn('vue-query 持久化恢复失败', error);
  }

  persistenceUnsubscribe = persistQueryClientSubscribe(persistOptions);
};

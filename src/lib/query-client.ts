import {
  type PersistedClient,
  type Persister,
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from '@tanstack/query-persist-client-core';
import { QueryClient } from '@tanstack/vue-query';
import { del, get, set } from 'idb-keyval';

// 30 天:对齐原 src/store/git.ts 中 commit stats 落盘的最长保留窗口,
// 也覆盖 PR 列表/详情的 7 天窗口。单条 TTL 由各 domain 的 staleTime/gcTime 控制。
const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PERSIST_STORAGE_KEY = 'calamex.vue-query';
// 缓存结构/键规则变化时递增,等价于原来的 versioned cache key。
const PERSIST_BUSTER = '1';
// 写盘节流窗口:把启动期与刷新期密集的缓存写入(removeQueries/setQueryData)
// 合并为一次 IndexedDB 写,避免逐次落盘阻塞。
const PERSIST_THROTTLE_MS = 2_000;

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
  // QueryClient.fetchQuery 是带泛型的重载(fetchQuery<TQueryFnData, TError, TData, ...>)。
  // override 必须同样声明泛型 <T>,否则调用方写 fetchQuery<IGitCommitDetailPayload>(...)
  // 会触发 ts(2558)「应有 0 个类型参数但获得 1 个」。这里把 T 透传给 super.fetchQuery
  // 并作为返回类型,保持与原生签名一致的泛型推断。
  override fetchQuery<T>(options: Parameters<QueryClient['fetchQuery']>[0]): Promise<T> {
    const previousData = this.getQueryData(options.queryKey);

    return super.fetchQuery(options).then((data) => {
      const cachedData = this.getQueryData(options.queryKey) ?? data;
      const sharedData = structurallyShareSerializableData(previousData, cachedData);

      if (sharedData !== cachedData) {
        this.setQueryData(options.queryKey, sharedData);
      }

      return sharedData as T;
    });
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

/**
 * 基于 IndexedDB(idb-keyval)的异步持久化器。
 *
 * 取代旧的 createSyncStoragePersister + localStorage 方案:后者在启动时同步
 * JSON.parse 整块缓存、并在每次缓存变动时同步全量序列化写回 localStorage,
 * 随历史数据累积会把主线程钉死(表现为进入应用后界面整体卡死)。
 *
 * IndexedDB 走结构化克隆且 I/O 异步,序列化不再阻塞主线程;写入再叠加节流,
 * 把启动/刷新期的密集写入合并为一次落盘。
 */
const createIdbPersister = (): Persister => {
  let pendingClient: PersistedClient | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    flushTimer = null;
    if (pendingClient === null) return;
    const client = pendingClient;
    pendingClient = null;
    try {
      await set(PERSIST_STORAGE_KEY, client);
    } catch (error) {
      console.warn('vue-query 持久化写入失败', error);
    }
  };

  return {
    persistClient: (client: PersistedClient): void => {
      pendingClient = client;
      if (flushTimer === null) {
        flushTimer = setTimeout(() => {
          void flush();
        }, PERSIST_THROTTLE_MS);
      }
    },
    restoreClient: async (): Promise<PersistedClient | undefined> => {
      try {
        return (await get<PersistedClient>(PERSIST_STORAGE_KEY)) ?? undefined;
      } catch (error) {
        console.warn('vue-query 持久化恢复失败', error);
        return undefined;
      }
    },
    removeClient: async (): Promise<void> => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingClient = null;
      try {
        await del(PERSIST_STORAGE_KEY);
      } catch (error) {
        console.warn('vue-query 持久化清理失败', error);
      }
    },
  };
};

/**
 * 清理旧版本遗留在 localStorage 的整块缓存。
 * 旧实现把所有可持久化查询塞进单个 localStorage key,跨会话只增不减,
 * 既是本次卡死的根因,也会拖慢其它同步 localStorage 读取(如 pinia 持久化)。
 */
const cleanupLegacyLocalStoragePersist = (): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PERSIST_STORAGE_KEY);
  } catch {
    // localStorage 不可用时忽略。
  }
};

const isPersistenceAvailable = (): boolean =>
  typeof window !== 'undefined' && typeof indexedDB !== 'undefined';

let persistenceUnsubscribe: (() => void) | null = null;

/**
 * 接入官方 persist-client 持久化,落盘介质为 IndexedDB(异步)。
 *
 * 仅持久化显式标记 `meta: { persist: true }` 且已成功的查询(PR 列表、PR 详情、
 * commit stats),其余 server-state 仅驻留内存——与原实现“只有这几类缓存落盘”一致。
 * 幂等:重复调用不会重复订阅。
 */
export const setupQueryPersistence = async (): Promise<void> => {
  if (persistenceUnsubscribe) return;

  // 迁移:先清掉旧的 localStorage 膨胀块(根因),再切换到异步 IndexedDB。
  cleanupLegacyLocalStoragePersist();

  if (!isPersistenceAvailable()) return;

  const persister = createIdbPersister();

  const persistOptions = {
    queryClient,
    persister,
    maxAge: PERSIST_MAX_AGE_MS,
    buster: PERSIST_BUSTER,
    dehydrateOptions: {
      shouldDehydrateQuery: (query: {
        meta?: Record<string, unknown>;
        state: { status: string };
      }) => query.meta?.persist === true && query.state.status === 'success',
    },
  };

  try {
    await persistQueryClientRestore(persistOptions);
  } catch (error) {
    console.warn('vue-query 持久化恢复失败', error);
  }

  persistenceUnsubscribe = persistQueryClientSubscribe(persistOptions);
};

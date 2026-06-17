import { createStore, del, get, set, type UseStore } from 'idb-keyval';

import type { IAiConversationThread } from '@/store/aiConversation';
import { logger } from '@/utils/platform/logger';
import { restoreAttachmentPreviewPointers } from './debouncedPersistStorage';

/**
 * 规范化(按线程)持久化引擎 —— ai-conversation 专用。
 *
 * 背景 / 根因:
 * 现有持久化走 pinia-plugin-persistedstate, 其在 store 每次 mutation 时同步
 * `JSON.stringify(整个 threads)` 一次, 然后才把字符串交给 storage。流式回答
 * 每个 rAF 帧都会提交一次 store(commitDisplayMessagesToStore), 于是整库历史
 * (最多 AI_CONVERSATION_HISTORY_LIMIT 个线程, 含 active 线程的图片 base64)被
 * 在主线程每秒全量序列化约 60 次, 成本随历史体量线性增长。debouncedPersistStorage
 * 只防抖了 idb 写盘, 序列化发生在它的上游、与 mutation 同步, 防抖救不了它。
 *
 * 本引擎用规范化布局取代单体 blob:
 *   - 每个线程一条 idb 记录(`shell-ide.ai-conversation.thread:<id>`);
 *   - 一条轻量索引记录(`shell-ide.ai-conversation.index`), 只存 activeThreadId
 *     与线程顺序(不含 messages)。
 * 写入按"脏线程"集合 + 防抖落盘, 一次 flush 只序列化被改动的线程 —— 流式期间
 * 即只有 active 线程, 把"逐帧 O(全库)"变成"防抖 O(单线程)"。这同时惠及所有
 * mutation(滚动 / 改标题 / 加消息), 而非只救流式。
 *
 * 迁移: 非破坏式。读取旧单体 blob(`shell-ide.ai-conversation`)拆分为新记录,
 * 但故意保留旧 blob 作为回退备份(待切换验证稳定后由后续 commit 清理)。
 *
 * 安全不变量(沿用 debouncedPersistStorage):
 *   - 图片 base64 抽取为 `idb://` 指针(同一 idb 库/表、同一 FNV-1a 内容哈希,
 *     因此 payload 去重, 并可被既有 restoreAttachmentPreviewPointers 解析);
 *   - hydrate 时仅 eager 恢复 active 线程图片, 其余线程保留指针懒加载;
 *   - 防抖上限(SAVE_MAX_WAIT_MS)与 pagehide/visibilitychange flush。
 *
 * 注意: 本模块尚未在任何地方被 import, 对运行时行为零影响。把 aiConversation
 * store 与 main.ts hydrate 切到本引擎在后续 commit 完成。
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 专用 IndexedDB 库/表名, 与 debouncedPersistStorage 保持一致以共享图片 payload。 */
const IDB_DB_NAME = 'shell-ide.ai-conversation';
const IDB_STORE_NAME = 'persist';

/** 旧单体 blob key(迁移源, 非破坏式保留)。 */
const LEGACY_BLOB_KEY = 'shell-ide.ai-conversation';
/** 新格式: 索引记录 key(只含 activeThreadId + 线程顺序)。 */
const INDEX_KEY = 'shell-ide.ai-conversation.index';
/** 新格式: 每线程记录 key 前缀。 */
const THREAD_KEY_PREFIX = 'shell-ide.ai-conversation.thread:';
/** 索引格式版本, 便于后续演进。 */
const PERSIST_VERSION = 2;

/** 写入防抖: 流式/滚动期间高频写合并为一次落盘。 */
const SAVE_DEBOUNCE_MS = 300;
/** 防抖最大等待: 持续高频写也至少每 SAVE_MAX_WAIT_MS 落盘一次, 避免被饿死。 */
const SAVE_MAX_WAIT_MS = 1000;

const ATTACHMENT_PREVIEW_KEY_PREFIX = 'ai-conversation-attachment-preview:';
const ATTACHMENT_PREVIEW_POINTER_PREFIX = 'idb://ai-conversation-attachment-preview/';
const DATA_IMAGE_URL_MARKER = 'data:image/';
const DATA_IMAGE_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/iu;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IPersistedIndex {
  version: number;
  activeThreadId: string | null;
  threadOrder: string[];
}

export interface IAiConversationThreadHydrateResult {
  status: 'loaded' | 'empty' | 'migrated';
  activeThreadId: string | null;
  threads: IAiConversationThread[];
}

export interface IAiConversationPersistRequest {
  activeThreadId: string | null;
  threads: readonly IAiConversationThread[];
  /** 本次变更涉及的线程 id(需要重新序列化落盘的线程)。 */
  changedThreadIds?: readonly string[];
  /** 本次被删除的线程 id(需要从 idb 删除其记录)。 */
  removedThreadIds?: readonly string[];
  /** activeThreadId 或线程顺序是否变化(决定是否重写索引)。 */
  indexChanged?: boolean;
}

// ---------------------------------------------------------------------------
// Logging + idb store
// ---------------------------------------------------------------------------

const persistLogger = logger.child({ scope: 'ai-conversation-thread-persist' });

let idbStore: UseStore | null = null;

const getStore = (): UseStore => {
  if (!idbStore) {
    idbStore = createStore(IDB_DB_NAME, IDB_STORE_NAME);
  }
  return idbStore;
};

// ---------------------------------------------------------------------------
// Image payload extraction (write side)
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isDataImageUrl = (value: string): boolean => DATA_IMAGE_URL_PATTERN.test(value);

/** 与 debouncedPersistStorage 同款 FNV-1a, 保证同一图片得到同一 idb key 以去重。 */
const createAttachmentPreviewStorageId = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${value.length.toString(36)}-${hash.toString(36).padStart(7, '0')}`;
};

const extractAttachmentPreviewPayloads = async (value: unknown): Promise<void> => {
  if (Array.isArray(value)) {
    for (const item of value) {
      await extractAttachmentPreviewPayloads(item);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'src' && typeof child === 'string' && isDataImageUrl(child)) {
      const id = createAttachmentPreviewStorageId(child);
      await set(`${ATTACHMENT_PREVIEW_KEY_PREFIX}${id}`, child, getStore());
      value[key] = `${ATTACHMENT_PREVIEW_POINTER_PREFIX}${id}`;
      continue;
    }

    await extractAttachmentPreviewPayloads(child);
  }
};

/**
 * 把单个线程序列化为持久化字符串; 仅当内联出现新的 base64 图片时才解析+抽取,
 * 否则走 fast path 直接 stringify(既有 `idb://` 指针无需再处理)。
 */
const serializeThreadForPersist = async (thread: IAiConversationThread): Promise<string> => {
  const json = JSON.stringify(thread);
  if (!json.includes(DATA_IMAGE_URL_MARKER)) {
    return json;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    await extractAttachmentPreviewPayloads(parsed);
    return JSON.stringify(parsed);
  } catch (error) {
    persistLogger.warn({ event: 'ai-conversation-thread-extract-failed', err: error });
    return json;
  }
};

// ---------------------------------------------------------------------------
// Read / hydrate
// ---------------------------------------------------------------------------

const isPersistedIndex = (value: unknown): value is IPersistedIndex =>
  isRecord(value) && Array.isArray((value as Record<string, unknown>).threadOrder);

const isConversationBlobShape = (
  value: unknown,
): value is { activeThreadId: unknown; threads: unknown[] } =>
  isRecord(value) && Array.isArray((value as Record<string, unknown>).threads);

const readIndex = async (): Promise<IPersistedIndex | null> => {
  const raw = await get<string>(INDEX_KEY, getStore());
  if (typeof raw !== 'string') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPersistedIndex(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * 读取单个线程记录。restoreImages=true 时把图片指针解析回 base64(仅用于 active
 * 线程); 其余线程保留指针, 待 store 在切换时懒加载。
 * 结构校验交由 store 的 zod hydrate(normalizeHydratedThreads / salvage), 此处只做
 * 基本形状判断, 解析失败的记录跳过。
 */
const readThread = async (
  id: string,
  restoreImages: boolean,
): Promise<IAiConversationThread | null> => {
  const raw = await get<string>(`${THREAD_KEY_PREFIX}${id}`, getStore());
  if (typeof raw !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const thread = parsed as unknown as IAiConversationThread;
  if (!restoreImages) {
    return thread;
  }
  const { value } = await restoreAttachmentPreviewPointers(thread);
  return value;
};

/** 全量写入(迁移 / 首次建立新格式时使用)。 */
const persistFull = async (
  activeThreadId: string | null,
  threads: readonly IAiConversationThread[],
): Promise<void> => {
  const store = getStore();
  for (const thread of threads) {
    await set(`${THREAD_KEY_PREFIX}${thread.id}`, await serializeThreadForPersist(thread), store);
  }
  const index: IPersistedIndex = {
    version: PERSIST_VERSION,
    activeThreadId,
    threadOrder: threads.map((thread) => thread.id),
  };
  await set(INDEX_KEY, JSON.stringify(index), store);
};

/**
 * 从旧单体 blob 迁移到新格式。非破坏式: 写入新记录后保留旧 blob 作回退备份。
 * 返回内存态(仅 active 线程恢复图片 base64)。
 */
const migrateFromLegacyBlob = async (): Promise<{
  activeThreadId: string | null;
  threads: IAiConversationThread[];
} | null> => {
  const raw = await get<string>(LEGACY_BLOB_KEY, getStore());
  if (typeof raw !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isConversationBlobShape(parsed)) {
    return null;
  }
  const activeThreadId =
    typeof parsed.activeThreadId === 'string' ? parsed.activeThreadId : null;
  const threads = (parsed.threads as unknown[]).filter(
    (thread): thread is IAiConversationThread =>
      isRecord(thread) && typeof (thread as { id?: unknown }).id === 'string',
  );

  await persistFull(activeThreadId, threads);

  const restored = await Promise.all(
    threads.map(async (thread) =>
      thread.id === activeThreadId
        ? (await restoreAttachmentPreviewPointers(thread)).value
        : thread,
    ),
  );
  return { activeThreadId, threads: restored };
};

/**
 * Hydrate: 优先读新格式索引; 无索引则尝试从旧单体 blob 迁移; 都没有则空态。
 * 结构归一化/校验由调用方(store)负责。
 */
export const hydrateAiConversationThreadStorage =
  async (): Promise<IAiConversationThreadHydrateResult> => {
    if (typeof window === 'undefined') {
      return { status: 'empty', activeThreadId: null, threads: [] };
    }
    try {
      const index = await readIndex();
      if (index) {
        const threads: IAiConversationThread[] = [];
        for (const id of index.threadOrder) {
          const thread = await readThread(id, id === index.activeThreadId);
          if (thread) {
            threads.push(thread);
          }
        }
        return {
          status: threads.length > 0 ? 'loaded' : 'empty',
          activeThreadId: index.activeThreadId,
          threads,
        };
      }
      const migrated = await migrateFromLegacyBlob();
      if (migrated) {
        return {
          status: 'migrated',
          activeThreadId: migrated.activeThreadId,
          threads: migrated.threads,
        };
      }
    } catch (error) {
      persistLogger.warn({ event: 'ai-conversation-thread-hydrate-failed', err: error });
    }
    return { status: 'empty', activeThreadId: null, threads: [] };
  };

// ---------------------------------------------------------------------------
// Dirty-tracked debounced persist (hot path)
// ---------------------------------------------------------------------------

let latestActiveThreadId: string | null = null;
let latestThreads: readonly IAiConversationThread[] = [];
const dirtyThreadIds = new Set<string>();
const removedThreadIds = new Set<string>();
let indexDirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let firstPendingAt: number | null = null;
let persistQueue: Promise<void> = Promise.resolve();

const enqueue = (operation: () => Promise<void>, errorEvent: string): void => {
  persistQueue = persistQueue
    .catch(() => undefined)
    .then(operation)
    .catch((error) => {
      persistLogger.error({ event: errorEvent, err: error });
    });
};

const clearSaveTimer = (): void => {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
};

const flushNow = (): void => {
  clearSaveTimer();
  firstPendingAt = null;
  if (dirtyThreadIds.size === 0 && removedThreadIds.size === 0 && !indexDirty) {
    return;
  }
  const activeThreadId = latestActiveThreadId;
  const threadOrder = latestThreads.map((thread) => thread.id);
  const threadsById = new Map(latestThreads.map((thread) => [thread.id, thread] as const));
  const writeIds = [...dirtyThreadIds];
  const deleteIds = [...removedThreadIds];
  dirtyThreadIds.clear();
  removedThreadIds.clear();
  indexDirty = false;

  enqueue(async () => {
    const store = getStore();
    for (const id of writeIds) {
      const thread = threadsById.get(id);
      if (!thread) {
        continue;
      }
      await set(`${THREAD_KEY_PREFIX}${id}`, await serializeThreadForPersist(thread), store);
    }
    for (const id of deleteIds) {
      await del(`${THREAD_KEY_PREFIX}${id}`, store);
    }
    const index: IPersistedIndex = {
      version: PERSIST_VERSION,
      activeThreadId,
      threadOrder,
    };
    await set(INDEX_KEY, JSON.stringify(index), store);
  }, 'ai-conversation-thread-save-failed');
};

const scheduleFlush = (): void => {
  if (typeof window === 'undefined') {
    return;
  }
  const now = Date.now();
  if (firstPendingAt === null) {
    firstPendingAt = now;
  }
  const elapsed = now - firstPendingAt;
  const delay = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS - elapsed));
  clearSaveTimer();
  saveTimer = setTimeout(() => {
    flushNow();
  }, delay);
};

/**
 * 提交一次持久化请求。只把 changedThreadIds 标脏、removedThreadIds 标删,
 * 防抖后一次性落盘 —— 流式期间通常只有 active 线程被标脏。
 */
export const scheduleAiConversationThreadPersist = (
  request: IAiConversationPersistRequest,
): void => {
  latestActiveThreadId = request.activeThreadId;
  latestThreads = request.threads;
  for (const id of request.changedThreadIds ?? []) {
    dirtyThreadIds.add(id);
  }
  for (const id of request.removedThreadIds ?? []) {
    removedThreadIds.add(id);
    dirtyThreadIds.delete(id);
  }
  if (request.indexChanged) {
    indexDirty = true;
  }
  scheduleFlush();
};

/** best-effort: 立即落盘未 flush 的脏数据(页面隐藏/卸载, 或外部主动触发)。 */
export const flushAiConversationThreadPersist = (): void => {
  flushNow();
};

let flushListenersRegistered = false;

/** 注册应用级 flush 监听器(幂等)。常驻不解绑, 进程退出由 WebView 统一回收。 */
export const registerAiConversationThreadFlushListeners = (): void => {
  if (flushListenersRegistered || typeof window === 'undefined') {
    return;
  }
  flushListenersRegistered = true;
  window.addEventListener('pagehide', flushAiConversationThreadPersist);
  window.addEventListener('beforeunload', flushAiConversationThreadPersist);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushAiConversationThreadPersist();
      }
    });
  }
};

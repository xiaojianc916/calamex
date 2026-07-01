import { createStore, get, set, type UseStore } from 'idb-keyval';

import { logger } from '@/utils/platform/logger';

/**
 * ai-conversation 附件预览（图片 base64）的 IndexedDB 旁路存储。
 *
 * 会话快照里的图片预览以 data:image base64 形式出现，体积大。落盘前用
 * preparePersistValue 把它们抽取成内容派生 id 的 idb:// 指针单独存入 IndexedDB，
 * 快照本身只保留指针；读取时按需用 restoreAttachmentPreviewPointers 把指针解析回
 * base64，避免把大体积 base64 反复写进主快照、或在启动时一次性灌进内存。
 *
 * 历史背景：本模块原是 debouncedPersistStorage 的一部分（为已退役的 legacy
 * aiConversation pinia 持久化服务）。legacy StorageLike / hydrate / localStorage 迁移
 * 逻辑已随 ADR-0014 Step 8 删除；附件预览抽取/恢复因仍被 entries 引擎
 * （aiThreadEntriesStorage / entriesRenderHydrate / aiThread store）复用而保留至此。
 *
 * 数据安全约束：IndexedDB 库/表名与历史保持一致（'shell-ide.ai-conversation' /
 * 'persist'），且与 aiThreadEntriesStorage 共用同一库/表——切勿改名，否则历史会话
 * 图片将全部失联。
 */

const IDB_DB_NAME = 'shell-ide.ai-conversation';
const IDB_STORE_NAME = 'persist';
const ATTACHMENT_PREVIEW_POINTER_PREFIX = 'idb://ai-conversation-attachment-preview/';
const ATTACHMENT_PREVIEW_KEY_PREFIX = 'ai-conversation-attachment-preview:';
const DATA_IMAGE_URL_MARKER = 'data:image/';
const DATA_IMAGE_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/iu;
const ATTACHMENT_PREVIEW_POINTER_PATTERN = /^idb:\/\/ai-conversation-attachment-preview\//u;

const persistLogger = logger.child({ scope: 'ai-conversation-attachment-preview' });

let idbStore: UseStore | null = null;

const getIdbStore = (): UseStore => {
  if (!idbStore) {
    idbStore = createStore(IDB_DB_NAME, IDB_STORE_NAME);
  }
  return idbStore;
};

const createAttachmentPreviewStorageId = async (value: string): Promise<string> => {
  // 官方 Web Crypto SHA-256 做内容寻址，替代手搓 32 位 FNV-1a。
  // 32 位散列在 `${length}-` 前缀下仍有生日碰撞（同长不同图 → 串图）；SHA-256 全长十六进制实际杜绝碰撞。
  // crypto.subtle 在 Tauri WebView 的安全上下文可用。
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${value.length.toString(36)}-${hex}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isDataImageUrl = (value: string): boolean => DATA_IMAGE_URL_PATTERN.test(value);

const isAttachmentPreviewPointer = (value: string): boolean =>
  ATTACHMENT_PREVIEW_POINTER_PATTERN.test(value);

const toAttachmentPreviewKey = (id: string): string => `${ATTACHMENT_PREVIEW_KEY_PREFIX}${id}`;
const toAttachmentPreviewPointer = (id: string): string =>
  `${ATTACHMENT_PREVIEW_POINTER_PREFIX}${id}`;

const getAttachmentPreviewIdFromPointer = (value: string): string | null => {
  if (!isAttachmentPreviewPointer(value)) {
    return null;
  }

  const id = value.slice(ATTACHMENT_PREVIEW_POINTER_PREFIX.length).trim();

  return id || null;
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
      const id = await createAttachmentPreviewStorageId(child);
      await set(toAttachmentPreviewKey(id), child, getIdbStore());
      value[key] = toAttachmentPreviewPointer(id);
      continue;
    }

    await extractAttachmentPreviewPayloads(child);
  }
};

const restoreAttachmentPreviewPayloads = async (value: unknown): Promise<boolean> => {
  if (Array.isArray(value)) {
    let changed = false;
    for (const item of value) {
      if (await restoreAttachmentPreviewPayloads(item)) {
        changed = true;
      }
    }
    return changed;
  }

  if (!isRecord(value)) {
    return false;
  }

  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'src' && typeof child === 'string') {
      const id = getAttachmentPreviewIdFromPointer(child);

      if (id) {
        const restored = await get<string>(toAttachmentPreviewKey(id), getIdbStore());
        if (typeof restored === 'string' && isDataImageUrl(restored)) {
          value[key] = restored;
          changed = true;
        }
      }

      continue;
    }

    if (await restoreAttachmentPreviewPayloads(child)) {
      changed = true;
    }
  }
  return changed;
};

/**
 * 落盘前把快照内 `attachmentPreview.src` 的 data:image base64 抽取为 idb:// 指针
 * （内容派生 id，幂等同 id，不产生重复 blob），返回改写后的快照 JSON 字符串。
 */
export const preparePersistValue = async (value: string): Promise<string> => {
  // Fast path: most conversation writes are text/scroll/status updates. If no fresh
  // inline image payload exists, avoid parsing and recursively walking the whole
  // conversation snapshot on every debounced persist. Existing idb:// pointers do
  // not need re-extraction.
  if (!value.includes(DATA_IMAGE_URL_MARKER)) {
    return value;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    await extractAttachmentPreviewPayloads(parsed);

    return JSON.stringify(parsed);
  } catch (error) {
    persistLogger.warn({ event: 'ai-conversation-attachment-preview-extract-failed', err: error });
    return value;
  }
};

/**
 * 懒加载按需解析：把任意值内 `attachmentPreview.src` 的 `idb://` 指针解析回 base64。
 * 供 store 在某历史线程被激活时调用（hydrate 时只恢复了 active 线程，其余线程仍是指针）。
 *
 * - 深拷贝后解析，绝不改动调用方持有的原对象；
 * - changed=false 表示没有任何指针被解析（store 无需回写，避免无谓持久化）。
 */
export const restoreAttachmentPreviewPointers = async <T>(
  value: T,
): Promise<{ changed: boolean; value: T }> => {
  if (typeof window === 'undefined') {
    return { changed: false, value };
  }

  const cloned = structuredClone(value);
  const changed = await restoreAttachmentPreviewPayloads(cloned);

  return changed ? { changed, value: cloned } : { changed: false, value };
};

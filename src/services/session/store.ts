import { Store } from '@tauri-apps/plugin-store';

import { AppError } from '@/types/app-error';
import { SessionSnapshotSchema, type TSessionSnapshot } from '@/types/session';
import { createUniqueId } from '@/utils/core/id';
import { toErrorMessage } from '@/utils/error/error';
import { desktopRuntimeReady } from '@/utils/platform/desktop-runtime';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_STORE_FILE = 'session.json';
const SESSION_SNAPSHOT_KEY = 'snapshot';
// 会话快照统一落到漫游根 %APPDATA%\.calamex\config\session.json。
const SESSION_STORE_RELATIVE_SEGMENTS = ['.calamex', 'config', SESSION_STORE_FILE] as const;
// localStorage 兜底键（Tauri store 不可用时使用）。
const SESSION_FALLBACK_STORAGE_KEY = 'calamex:session-snapshot';
// 旧版兜底键，仅用于一次性迁移到新键。
const LEGACY_SESSION_FALLBACK_STORAGE_KEY = 'shell-ide:session-snapshot';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 从 Tauri Store / localStorage 读出的原始 JSON，结构不保证符合 schema。 */
type TRawSnapshot = Record<string, unknown>;

const logWarn = (event: string, extra?: unknown): void => {
  const payload = {
    timestamp: new Date().toISOString(),
    level: 'warn',
    scope: 'session',
    event,
    extra: extra === undefined ? undefined : toErrorMessage(extra, String(extra)),
  };
  console.warn(JSON.stringify(payload));
};

// ---------------------------------------------------------------------------
// Error factories
// ---------------------------------------------------------------------------

const createSessionValidationError = (cause: unknown): AppError =>
  new AppError({
    code: 'SESSION_VALIDATION_FAILED',
    message: '会话快照不符合 schema,已拒绝保存。',
    scope: 'ipc',
    traceId: createUniqueId(),
    cause,
  });

const createSessionPersistError = (cause: unknown): AppError =>
  new AppError({
    code: 'SESSION_PERSIST_FAILED',
    message: '保存会话快照失败:主存储与降级存储均无法写入。',
    scope: 'ipc',
    traceId: createUniqueId(),
    cause,
  });

// ---------------------------------------------------------------------------
// Store loader (with retry on rejected cache)
// ---------------------------------------------------------------------------

let storePromise: Promise<Store> | null = null;

/**
 * 解析会话存储文件的绝对路径：%APPDATA%\.calamex\config\session.json。
 *
 * appDataDir() 返回 Tauri 标识目录(%APPDATA%\com.xiaojianc.Calamex)，取其父目录(=%APPDATA%)
 * 后落到统一的 .calamex 根，使会话快照与其它本地数据同根。任意一步失败（如非 Tauri
 * 运行环境 / 单测）时抛出，由 getStore 兜底回退到默认文件名。
 */
const resolveStorePath = async (): Promise<string> => {
  const { appDataDir, join, normalize } = await import('@tauri-apps/api/path');
  const identifierDir = await appDataDir();
  const absolute = await join(identifierDir, '..', ...SESSION_STORE_RELATIVE_SEGMENTS);
  return normalize(absolute);
};

/**
 * Tauri Store 单例 lazy loader。
 *
 * 关键设计:`Store.load` 失败时**清空 storePromise**,允许下次重试。
 * 路径解析失败时降级为默认相对文件名,保证非 Tauri / 单测环境仍可用。
 */
const getStore = (): Promise<Store> => {
  if (storePromise) {
    return storePromise;
  }
  storePromise = (async (): Promise<Store> => {
    let storePath = SESSION_STORE_FILE;
    try {
      storePath = await resolveStorePath();
    } catch (cause) {
      logWarn('snapshot-store-path-resolve-failed', cause);
    }
    return Store.load(storePath);
  })().catch((error) => {
    storePromise = null;
    throw error;
  });
  return storePromise;
};

// ---------------------------------------------------------------------------
// Fallback storage (localStorage)
// ---------------------------------------------------------------------------

/**
 * 一次性迁移旧版兜底键 (shell-ide:session-snapshot) 到新键 (calamex:session-snapshot)。
 * 仅当新键尚无值时搬运,随后移除旧键。失败只警告。
 */
const migrateLegacyFallbackKey = (): void => {
  if (
    !(desktopRuntimeReady.value && typeof window !== 'undefined' && Boolean(window.localStorage))
  ) {
    return;
  }
  try {
    const legacy = window.localStorage.getItem(LEGACY_SESSION_FALLBACK_STORAGE_KEY);
    if (legacy == null) {
      return;
    }
    if (window.localStorage.getItem(SESSION_FALLBACK_STORAGE_KEY) == null) {
      window.localStorage.setItem(SESSION_FALLBACK_STORAGE_KEY, legacy);
    }
    window.localStorage.removeItem(LEGACY_SESSION_FALLBACK_STORAGE_KEY);
  } catch (cause) {
    logWarn('snapshot-fallback-key-migrate-failed', cause);
  }
};

const readFallbackSnapshot = (): TRawSnapshot | null => {
  if (
    !(desktopRuntimeReady.value && typeof window !== 'undefined' && Boolean(window.localStorage))
  ) {
    return null;
  }
  migrateLegacyFallbackKey();
  const raw = window.localStorage.getItem(SESSION_FALLBACK_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    logWarn('snapshot-fallback-invalid-json', cause);
    return null;
  }
};

const writeFallbackSnapshot = (snapshot: TSessionSnapshot): void => {
  if (
    !(desktopRuntimeReady.value && typeof window !== 'undefined' && Boolean(window.localStorage))
  ) {
    throw new Error('fallback storage unavailable');
  }
  window.localStorage.setItem(SESSION_FALLBACK_STORAGE_KEY, JSON.stringify(snapshot));
};

const clearFallbackSnapshot = (): void => {
  if (
    !(desktopRuntimeReady.value && typeof window !== 'undefined' && Boolean(window.localStorage))
  ) {
    return;
  }
  window.localStorage.removeItem(SESSION_FALLBACK_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_SESSION_FALLBACK_STORAGE_KEY);
};

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

/**
 * schemaVersion 迁移入口。
 *
 * 当前仅支持 v1;后续版本按 from -> to 串行迁移。无匹配路径返回 null,
 * 调用方走降级或当作 "无快照" 处理。
 *
 * 添加新版本范式:
 *   case 1: return migrateV1ToV2(raw);
 *   case 2: return raw;
 */
const migrate = (raw: TRawSnapshot): TRawSnapshot | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  switch (version) {
    case 1:
      return raw;
    default:
      logWarn('schema-no-migration-path', { from: version });
      return null;
  }
};

/** migrate + schema parse 的统一管线;校验失败返回 null 并打 warn。 */
const validateRawSnapshot = (raw: TRawSnapshot, invalidEvent: string): TSessionSnapshot | null => {
  const migrated = migrate(raw);
  if (migrated == null) {
    return null;
  }
  const parsed = SessionSnapshotSchema.safeParse(migrated);
  if (!parsed.success) {
    logWarn(invalidEvent, parsed.error.issues);
    return null;
  }
  return parsed.data;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 读取会话快照。
 *
 * 行为:
 * 1. 优先读主存储 (Tauri Store);成功且非空 → 直接返回。
 * 2. 主存储 IO **抛错** → 回退到 localStorage fallback。
 * 3. 主存储**显式为空** (key 不存在) → 不读 fallback,直接返回 null。
 */
export const loadSession = async (): Promise<TSessionSnapshot | null> => {
  try {
    const raw = await (await getStore()).get(SESSION_SNAPSHOT_KEY);
    if (raw == null) {
      return null;
    }
    return validateRawSnapshot(raw, 'snapshot-invalid');
  } catch (cause) {
    logWarn('snapshot-read-failed', cause);
  }

  const fallbackRaw = readFallbackSnapshot();
  if (fallbackRaw == null) {
    return null;
  }
  const result = validateRawSnapshot(fallbackRaw, 'snapshot-fallback-invalid');
  if (result != null) {
    logWarn('snapshot-read-fallback-hit');
  }
  return result;
};

/**
 * 保存会话快照。
 *
 * 行为:
 * 1. 按 schema 校验输入,失败抛 `SESSION_VALIDATION_FAILED` (调用方 Bug)。
 * 2. 写主存储 (Tauri Store)。
 * 3. 镜像写 fallback (localStorage),作为主存储未来损坏时的应急副本。
 */
export const saveSession = async (snapshot: TSessionSnapshot): Promise<void> => {
  let validated: TSessionSnapshot;
  try {
    validated = SessionSnapshotSchema.parse(snapshot);
  } catch (cause) {
    throw createSessionValidationError(cause);
  }

  let storeFailedCause: unknown = null;
  try {
    const store = await getStore();
    await store.set(SESSION_SNAPSHOT_KEY, validated);
    await store.save();
  } catch (cause) {
    storeFailedCause = cause;
    logWarn('snapshot-store-save-failed', cause);
  }

  if (storeFailedCause == null) {
    // 主存储已是权威。fallback 仅是镜像,失败只警告,不向上抛。
    try {
      writeFallbackSnapshot(validated);
    } catch (fallbackCause) {
      logWarn('snapshot-fallback-mirror-failed', fallbackCause);
    }
    return;
  }

  // 主存储失败 → fallback 是最后一道防线;再失败就真的没救了。
  try {
    writeFallbackSnapshot(validated);
    logWarn('snapshot-save-via-fallback');
  } catch (fallbackCause) {
    throw createSessionPersistError({
      store: toErrorMessage(storeFailedCause, String(storeFailedCause)),
      fallback: toErrorMessage(fallbackCause, String(fallbackCause)),
    });
  }
};

/** 清除会话快照 (主 + fallback)。fire-and-forget 语义,主存储失败仅警告。 */
export const clearSession = async (): Promise<void> => {
  try {
    const store = await getStore();
    await store.delete(SESSION_SNAPSHOT_KEY);
    await store.save();
  } catch (cause) {
    logWarn('snapshot-store-clear-failed', cause);
  }
  clearFallbackSnapshot();
};

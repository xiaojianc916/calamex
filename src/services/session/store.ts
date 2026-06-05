import { Store } from '@tauri-apps/plugin-store';

import { AppError } from '@/types/app-error';
import { SessionSnapshotSchema, type TSessionSnapshot } from '@/types/session';

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
// Logging helpers
// ---------------------------------------------------------------------------

const logWarn = (event: string, detail?: unknown): void => {
  // 会话持久化属于尽力而为的能力，任何异常都不应中断主流程。
  console.warn(`[session-store] ${event}`, detail ?? '');
};

// ---------------------------------------------------------------------------
// Tauri store loader
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

const getStore = (): Promise<Store> => {
  if (storePromise) {
    return storePromise;
  }
  storePromise = (async (): Promise<Store> => {
    let storePath = SESSION_STORE_FILE;
    try {
      storePath = await resolveStorePath();
    } catch (cause) {
      // 路径 API 不可用（非 Tauri 环境 / 单测）：回退到默认相对文件名，保证可用性。
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
// localStorage fallback
// ---------------------------------------------------------------------------

const isFallbackStorageAvailable = (): boolean => {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
};

/**
 * 一次性迁移旧版兜底键 (shell-ide:session-snapshot) 到新键 (calamex:session-snapshot)。
 * 仅当新键尚无值时搬运，随后移除旧键。失败只警告。
 */
const migrateLegacyFallbackKey = (): void => {
  if (!isFallbackStorageAvailable()) {
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

const readFallbackSnapshot = (): unknown => {
  if (!isFallbackStorageAvailable()) {
    return null;
  }
  migrateLegacyFallbackKey();
  try {
    const raw = window.localStorage.getItem(SESSION_FALLBACK_STORAGE_KEY);
    return raw == null ? null : (JSON.parse(raw) as unknown);
  } catch (cause) {
    logWarn('snapshot-fallback-read-failed', cause);
    return null;
  }
};

const writeFallbackSnapshot = (snapshot: TSessionSnapshot): void => {
  if (!isFallbackStorageAvailable()) {
    return;
  }
  try {
    window.localStorage.setItem(SESSION_FALLBACK_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (cause) {
    logWarn('snapshot-fallback-write-failed', cause);
  }
};

const clearFallbackSnapshot = (): void => {
  if (!isFallbackStorageAvailable()) {
    return;
  }
  try {
    window.localStorage.removeItem(SESSION_FALLBACK_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_SESSION_FALLBACK_STORAGE_KEY);
  } catch (cause) {
    logWarn('snapshot-fallback-clear-failed', cause);
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 读取会话快照。优先 Tauri store，失败回退 localStorage。
 * 解析失败返回 null，绝不抛出，避免阻断应用启动。
 */
export const loadSession = async (): Promise<TSessionSnapshot | null> => {
  let rawSnapshot: unknown = null;
  try {
    const store = await getStore();
    rawSnapshot = (await store.get(SESSION_SNAPSHOT_KEY)) ?? null;
  } catch (cause) {
    logWarn('snapshot-store-read-failed', cause);
    rawSnapshot = readFallbackSnapshot();
  }

  if (rawSnapshot == null) {
    return null;
  }

  const parsed = SessionSnapshotSchema.safeParse(rawSnapshot);
  if (!parsed.success) {
    logWarn('snapshot-validation-failed', parsed.error);
    return null;
  }
  return parsed.data;
};

/**
 * 保存会话快照。优先 Tauri store，失败回退 localStorage。
 */
export const saveSession = async (snapshot: TSessionSnapshot): Promise<void> => {
  const parsed = SessionSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new AppError('SESSION_SNAPSHOT_INVALID', '会话快照不符合约束，已拒绝写入。', {
      cause: parsed.error,
    });
  }

  try {
    const store = await getStore();
    await store.set(SESSION_SNAPSHOT_KEY, parsed.data);
    await store.save();
  } catch (cause) {
    logWarn('snapshot-store-write-failed', cause);
    writeFallbackSnapshot(parsed.data);
  }
};

/**
 * 清除会话快照（store + 所有兜底键）。
 */
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

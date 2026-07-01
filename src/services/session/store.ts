import { AppError } from '@/types/app-error';
import { SessionSnapshotSchema, type TSessionSnapshot } from '@/types/session';
import { createUniqueId } from '@/utils/core/id';
import { logger } from '@/utils/platform/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 会话快照的唯一权威存储键 (localStorage)。 */
const SESSION_STORAGE_KEY = 'calamex:session-snapshot';
/** 旧版键,仅用于一次性迁移到新键。 */
const LEGACY_SESSION_STORAGE_KEY = 'shell-ide:session-snapshot';

// ---------------------------------------------------------------------------
// Types & logger
// ---------------------------------------------------------------------------

/** 从 localStorage 读出的原始 JSON,结构不保证符合 schema。 */
type TRawSnapshot = Record<string, unknown>;

const sessionLogger = logger.child({ scope: 'session' });

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
    message: '保存会话快照失败:localStorage 不可写。',
    scope: 'ipc',
    traceId: createUniqueId(),
    cause,
  });

// ---------------------------------------------------------------------------
// localStorage 访问
// ---------------------------------------------------------------------------

/**
 * 解析可用的 localStorage。非浏览器 / Webview 环境(如部分单测)或被隐私策略禁用时
 * 返回 null,由调用方决定降级(读返回 null / 写抛 persist 错误)。
 */
const resolveLocalStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage ?? null;
  } catch (cause) {
    sessionLogger.warn({ event: 'snapshot-localstorage-unavailable', err: cause });
    return null;
  }
};

/**
 * 一次性迁移旧版键 (shell-ide:session-snapshot) 到新键 (calamex:session-snapshot)。
 * 仅当新键尚无值时搬运,随后移除旧键。失败只警告。
 */
const migrateLegacyKey = (storage: Storage): void => {
  try {
    const legacy = storage.getItem(LEGACY_SESSION_STORAGE_KEY);
    if (legacy == null) {
      return;
    }
    if (storage.getItem(SESSION_STORAGE_KEY) == null) {
      storage.setItem(SESSION_STORAGE_KEY, legacy);
    }
    storage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  } catch (cause) {
    sessionLogger.warn({ event: 'snapshot-legacy-key-migrate-failed', err: cause });
  }
};

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

/**
 * schemaVersion 迁移入口。当前仅支持 v1;后续版本按 from -> to 串行迁移。
 * 无匹配路径返回 null,调用方当作 "无快照" 处理。
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
      sessionLogger.warn({ event: 'schema-no-migration-path', from: version });
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
    sessionLogger.warn({ event: invalidEvent, err: parsed.error.issues });
    return null;
  }
  return parsed.data;
};

// ---------------------------------------------------------------------------
// 同步核心 (localStorage 唯一权威)
// ---------------------------------------------------------------------------

/** 同步读取并校验会话快照;无快照 / 坏数据返回 null,绝不抛。 */
export const readSessionSnapshot = (): TSessionSnapshot | null => {
  const storage = resolveLocalStorage();
  if (!storage) {
    return null;
  }
  migrateLegacyKey(storage);
  const raw = storage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  let parsed: TRawSnapshot;
  try {
    parsed = JSON.parse(raw) as TRawSnapshot;
  } catch (cause) {
    sessionLogger.warn({ event: 'snapshot-invalid-json', err: cause });
    return null;
  }
  return validateRawSnapshot(parsed, 'snapshot-invalid');
};

/**
 * 同步写入会话快照。入参非法抛 SESSION_VALIDATION_FAILED(调用方 Bug);
 * localStorage 不可写抛 SESSION_PERSIST_FAILED。
 */
export const writeSessionSnapshot = (snapshot: TSessionSnapshot): void => {
  let validated: TSessionSnapshot;
  try {
    validated = SessionSnapshotSchema.parse(snapshot);
  } catch (cause) {
    throw createSessionValidationError(cause);
  }
  const storage = resolveLocalStorage();
  if (!storage) {
    throw createSessionPersistError(new Error('localStorage unavailable'));
  }
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(validated));
  } catch (cause) {
    throw createSessionPersistError(cause);
  }
};

/** 同步清除会话快照(新键 + 旧键)。失败只警告。 */
export const clearSessionSnapshot = (): void => {
  const storage = resolveLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(SESSION_STORAGE_KEY);
    storage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  } catch (cause) {
    sessionLogger.warn({ event: 'snapshot-clear-failed', err: cause });
  }
};

// ---------------------------------------------------------------------------
// 兼容异步 API (保持既有调用方签名不变)
// ---------------------------------------------------------------------------

/** 读取会话快照(Promise 包装,兼容既有调用方)。 */
export const loadSession = (): Promise<TSessionSnapshot | null> =>
  Promise.resolve(readSessionSnapshot());

/** 保存会话快照;校验失败返回 rejected Promise(SESSION_VALIDATION_FAILED)。 */
export const saveSession = (snapshot: TSessionSnapshot): Promise<void> => {
  try {
    writeSessionSnapshot(snapshot);
    return Promise.resolve();
  } catch (cause) {
    return Promise.reject(cause);
  }
};

/** 清除会话快照。 */
export const clearSession = (): Promise<void> => {
  clearSessionSnapshot();
  return Promise.resolve();
};

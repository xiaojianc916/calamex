#!/usr/bin/env node
// R2 — 会话持久化收敛为 localStorage 唯一权威(同步),移除启动阻塞式异步 hydrate。
// 幂等 + CRLF 安全 + 写前全仓扫描(越界引用即中止,绝不半途写坏)。零删除。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const die = (m) => { console.error('\n\u2717 ' + m + '\n'); process.exit(1); };
const info = (m) => console.log(m);

if (!existsSync(join(ROOT, 'package.json')) || !existsSync(join(ROOT, 'src'))) {
  die('未找到 package.json 或 src/。请在仓库根目录 (D:\\com.xiaojianc\\my_desktop_app) 运行 node 1.mjs。');
}

const detectEol = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const toLf = (s) => s.replace(/\r\n/g, '\n');
const readText = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) die('缺少文件: ' + rel);
  return readFileSync(p, 'utf8');
};
const overwrite = (rel, lf) => {
  const p = join(ROOT, rel);
  const eol = existsSync(p) ? detectEol(readFileSync(p, 'utf8')) : '\r\n';
  writeFileSync(p, lf.replace(/\n/g, eol), 'utf8');
  info('  \u2713 覆盖 ' + rel);
};

// ---------- 写前全仓扫描 ----------
const SKIP = new Set(['node_modules', '.git', 'dist', 'target', '.next', 'coverage', 'gen']);
const walk = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|vue|js|mjs)$/.test(name)) acc.push(full);
  }
  return acc;
};
const scan = (needle, allowRel) => {
  const allow = new Set();
  for (const r of allowRel) { allow.add(r); allow.add(r.split('/').join(sep)); }
  const hits = [];
  for (const f of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, f);
    const relPosix = rel.split(sep).join('/');
    if (allow.has(rel) || allow.has(relPosix)) continue;
    if (readFileSync(f, 'utf8').includes(needle)) hits.push(relPosix);
  }
  if (hits.length) {
    die('发现未预期的「' + needle + '」引用,已中止(未写):\n- ' + hits.join('\n- ') +
      '\n\n这些文件仍依赖将被移除的符号。先告诉我,我来适配,别盲目重跑。');
  }
};

info('R2 · 写前全仓扫描...');
scan('hydrateSessionStorage', [
  'src/app/main.ts',
  'src/store/plugins/tauriSessionStorage.ts',
  'src/store/plugins/tauriSessionStorage.spec.ts',
]);
scan('THydrateStatus', [
  'src/store/plugins/tauriSessionStorage.ts',
  'src/store/plugins/tauriSessionStorage.spec.ts',
]);
info('  \u2713 未发现越界引用');

// ---------- main.ts 锚点补丁 ----------
const MAIN = 'src/app/main.ts';
const mainRaw = readText(MAIN);
const mainEol = detectEol(mainRaw);
let mainSrc = toLf(mainRaw);

const replaceIn = (src, oldLf, newLf, label, optional) => {
  const i = src.indexOf(oldLf);
  if (i === -1) {
    if (optional) { info('  · 跳过(锚点未命中,非致命): ' + label); return src; }
    die('未找到锚点「' + label + '」。' + MAIN + ' 可能已改动,请把当前该段贴给我,勿盲目重跑。');
  }
  if (src.indexOf(oldLf, i + oldLf.length) !== -1) die('锚点「' + label + '」出现多次,拒绝盲改。');
  return src.slice(0, i) + newLf + src.slice(i + oldLf.length);
};

mainSrc = replaceIn(
  mainSrc,
  "import { hydrateSessionStorage } from '@/store/plugins/tauriSessionStorage';\n",
  '',
  'hydrateSessionStorage import 行',
  false,
);

const STALE = [
  '    // session 快照是首屏(编辑器/工作区状态)恢复所必需的，仍在挂载前阻塞 await。',
  '    // 而 AI 会话历史只有懒加载的 AI 面板才会用到——首屏并不需要它就位。因此把它移出挂载',
  '    // 关键路径：在后台 idle 时读 entries 快照并灌入权威线程，不 await。entries hydrate 带',
  '    // 300ms 超时 + resolver 回退（坏快照/超时不致空白，详见 entriesRenderHydrate /',
  '    // aiThreadEntriesStorage），会在用户真正打开 AI 面板前完成。\n',
].join('\n');
mainSrc = replaceIn(mainSrc, STALE, '', '旧 session hydrate 注释块', true);

const THREE = [
  "    markStartup('session-storage-hydrate-start');",
  '    await hydrateSessionStorage();',
  "    markStartup('session-storage-hydrated');",
].join('\n');
const NEWC = [
  '    // 会话快照恢复不再阻塞启动:localStorage 已是唯一权威(见 services/session/store 与',
  '    // store/plugins/tauriSessionStorage)。Pinia persistedstate 在 editor store 首次实例化时',
  '    // 同步 getItem 即还原快照,无需在挂载前 await 任何异步 hydrate。AI 会话历史仍非首屏',
  '    // 必需,由下方 hydrateAiConversationAfterBootstrap 在挂载后 idle 时后台灌入。',
].join('\n');
mainSrc = replaceIn(mainSrc, THREE, NEWC, 'session hydrate 阻塞调用', false);

// ---------- 文件内容 ----------
const STORE_TS = `import { AppError } from '@/types/app-error';
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
`;

const TAURI_TS = `import type { StorageLike } from 'pinia-plugin-persistedstate';
import { z } from 'zod';

import {
  clearSessionSnapshot,
  readSessionSnapshot,
  writeSessionSnapshot,
} from '@/services/session/store';
import { SessionSnapshotSchema, type TSessionSnapshot } from '@/types/session';
import { logger } from '@/utils/platform/logger';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

const EDITOR_SESSION_KEY = 'shell-ide:editor';

/**
 * pinia-plugin-persistedstate 的 StorageLike 适配器,后端为 localStorage
 * (唯一权威,见 services/session/store)。
 *
 * getItem / setItem / removeItem 全部同步:localStorage 读写本身同步且廉价,不再需要
 * 异步 hydrate、超时占位、deferredWrite、对账或防抖——这些都是旧 Tauri-store 异步 IPC
 * 竞态的历史包袱,已随 localStorage 权威化一并移除。
 *
 * 在 plugin 契约之外额外暴露 removeItem,供业务层(登出 / 切换工作区 / 测试 reset)主动
 * 清理持久化快照。plugin 自身不会调用 removeItem。
 */
export interface ITauriSessionStorage extends StorageLike {
  removeItem(key: string): void;
}

const sessionLogger = logger.child({ scope: 'session' });

const PersistedEditorStoreSchema = z.object({
  sessionSnapshot: SessionSnapshotSchema,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const tauriSessionStorage: ITauriSessionStorage = {
  getItem(key) {
    if (key !== EDITOR_SESSION_KEY) {
      return null;
    }
    const snapshot = readSessionSnapshot();
    if (snapshot == null) {
      return null;
    }
    return JSON.stringify({ sessionSnapshot: snapshot });
  },

  setItem(key, value) {
    if (key !== EDITOR_SESSION_KEY) {
      return;
    }
    let snapshot: TSessionSnapshot;
    try {
      snapshot = PersistedEditorStoreSchema.parse(JSON.parse(value)).sessionSnapshot;
    } catch (error) {
      // schema 校验失败:不写盘。用户感知是 "改的东西没存",必须留痕。
      sessionLogger.warn({ event: 'snapshot-validation-failed', err: error });
      return;
    }
    try {
      writeSessionSnapshot(snapshot);
    } catch (error) {
      sessionLogger.warn({ event: 'snapshot-persist-failed', err: error });
    }
  },

  removeItem(key) {
    if (key !== EDITOR_SESSION_KEY) {
      return;
    }
    clearSessionSnapshot();
  },
};
`;

const STORE_SPEC = `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '@/types/app-error';

const warnMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/platform/logger', () => {
  const make = (): unknown => ({
    warn: warnMock,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => make(),
  });
  return { logger: make() };
});

const SESSION_KEY = 'calamex:session-snapshot';
const LEGACY_KEY = 'shell-ide:session-snapshot';

const createMemoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    clear: (): void => {
      map.clear();
    },
    getItem: (key: string): string | null => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number): string | null => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string): void => {
      map.delete(key);
    },
    setItem: (key: string, value: string): void => {
      map.set(key, String(value));
    },
  };
};

const createSnapshot = (workspaceRoot: string | null = '/tmp/workspace') => ({
  schemaVersion: 1 as const,
  workspaceRoot,
  openTabs: [],
  activeTabPath: null,
  viewStates: [],
  recentWorkspaces: [],
  recentFiles: [],
  savedAt: new Date().toISOString(),
});

describe('sessionStore (localStorage 权威)', () => {
  let storage: Storage;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storage = createMemoryStorage();
    vi.stubGlobal('window', { localStorage: storage } as unknown as Window & typeof globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('无快照时 loadSession 返回 null', async () => {
    const { loadSession } = await import('@/services/session/store');
    await expect(loadSession()).resolves.toBeNull();
  });

    it('saveSession 写入后 loadSession 读回同一快照', async () => {
    const { saveSession, loadSession } = await import('@/services/session/store');
    await saveSession(createSnapshot('/tmp/roundtrip'));
    await expect(loadSession()).resolves.toMatchObject({ workspaceRoot: '/tmp/roundtrip' });
    expect(storage.getItem(SESSION_KEY)).not.toBeNull();
  });

  it('saveSession 入参非法时抛 AppError(SESSION_VALIDATION_FAILED) 且不写盘', async () => {
    const { saveSession } = await import('@/services/session/store');
    await expect(saveSession({} as never)).rejects.toMatchObject<AppError>({
      code: 'SESSION_VALIDATION_FAILED',
      scope: 'ipc',
    });
    expect(storage.getItem(SESSION_KEY)).toBeNull();
  });

  it('schema 校验失败时 loadSession 返回 null 并 warn', async () => {
    storage.setItem(
      SESSION_KEY,
      JSON.stringify({
        schemaVersion: 999,
        workspaceRoot: null,
        openTabs: [],
        activeTabPath: null,
        viewStates: [],
        recentWorkspaces: [],
        recentFiles: [],
        savedAt: new Date().toISOString(),
      }),
    );
    const { loadSession } = await import('@/services/session/store');
    await expect(loadSession()).resolves.toBeNull();
    expect(warnMock).toHaveBeenCalled();
  });

  it('坏 JSON 时 loadSession 返回 null 且不抛', async () => {
    storage.setItem(SESSION_KEY, '{ not json');
    const { loadSession } = await import('@/services/session/store');
    await expect(loadSession()).resolves.toBeNull();
    expect(warnMock).toHaveBeenCalled();
  });

  it('clearSession 清除快照', async () => {
    const { saveSession, clearSession, loadSession } = await import('@/services/session/store');
    await saveSession(createSnapshot());
    await clearSession();
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    await expect(loadSession()).resolves.toBeNull();
  });

  it('首次读取时把旧版键迁移到新键', async () => {
    storage.setItem(LEGACY_KEY, JSON.stringify(createSnapshot('/tmp/legacy')));
    const { loadSession } = await import('@/services/session/store');
    await expect(loadSession()).resolves.toMatchObject({ workspaceRoot: '/tmp/legacy' });
    expect(storage.getItem(SESSION_KEY)).not.toBeNull();
    expect(storage.getItem(LEGACY_KEY)).toBeNull();
  });
});
`;

const TAURI_SPEC = `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warnMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/platform/logger', () => {
  const make = (): unknown => ({
    warn: warnMock,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => make(),
  });
  return { logger: make() };
});

const EDITOR_KEY = 'shell-ide:editor';
const SESSION_KEY = 'calamex:session-snapshot';

const createMemoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    clear: (): void => {
      map.clear();
    },
    getItem: (key: string): string | null => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number): string | null => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string): void => {
      map.delete(key);
    },
    setItem: (key: string, value: string): void => {
      map.set(key, String(value));
    },
  };
};

const createSnapshot = (workspaceRoot = '/tmp/workspace') => ({
  schemaVersion: 1 as const,
  workspaceRoot,
  openTabs: [],
  activeTabPath: null,
  viewStates: [],
  recentWorkspaces: [],
  recentFiles: [],
  savedAt: new Date().toISOString(),
});

describe('tauriSessionStorage (同步 localStorage 适配器)', () => {
  let storage: Storage;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storage = createMemoryStorage();
    vi.stubGlobal('window', { localStorage: storage } as unknown as Window & typeof globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('无快照时 getItem 返回 null', async () => {
    const { tauriSessionStorage } = await import('@/store/plugins/tauriSessionStorage');
    expect(tauriSessionStorage.getItem(EDITOR_KEY)).toBeNull();
  });

  it('setItem 同步落盘,getItem 立即读回', async () => {
    const { tauriSessionStorage } = await import('@/store/plugins/tauriSessionStorage');
    tauriSessionStorage.setItem(
      EDITOR_KEY,
      JSON.stringify({ sessionSnapshot: createSnapshot('/tmp/sync') }),
    );
    expect(storage.getItem(SESSION_KEY)).not.toBeNull();
    const raw = tauriSessionStorage.getItem(EDITOR_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).sessionSnapshot).toMatchObject({ workspaceRoot: '/tmp/sync' });
  });

  it('忽略非编辑器键', async () => {
    const { tauriSessionStorage } = await import('@/store/plugins/tauriSessionStorage');
    tauriSessionStorage.setItem('other', JSON.stringify({ sessionSnapshot: createSnapshot() }));
    expect(tauriSessionStorage.getItem('other')).toBeNull();
    expect(storage.getItem(SESSION_KEY)).toBeNull();
  });

  it('非法快照既不写盘也记录 warn', async () => {
    const { tauriSessionStorage } = await import('@/store/plugins/tauriSessionStorage');
    tauriSessionStorage.setItem(
      EDITOR_KEY,
      JSON.stringify({ sessionSnapshot: { schemaVersion: 1 } }),
    );
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    expect(warnMock).toHaveBeenCalled();
  });

  it('removeItem 清空持久化快照', async () => {
    const { tauriSessionStorage } = await import('@/store/plugins/tauriSessionStorage');
    tauriSessionStorage.setItem(
      EDITOR_KEY,
      JSON.stringify({ sessionSnapshot: createSnapshot() }),
    );
    expect(storage.getItem(SESSION_KEY)).not.toBeNull();
    tauriSessionStorage.removeItem(EDITOR_KEY);
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    expect(tauriSessionStorage.getItem(EDITOR_KEY)).toBeNull();
  });
});
`;

// ---------- 执行写入(扫描已过,零删除) ----------
info('R2 · 写入...');
overwrite('src/services/session/store.ts', STORE_TS);
overwrite('src/store/plugins/tauriSessionStorage.ts', TAURI_TS);
writeFileSync(join(ROOT, MAIN), mainSrc.replace(/\n/g, mainEol), 'utf8');
info('  \u2713 补丁 ' + MAIN);
overwrite('src/services/session/store.spec.ts', STORE_SPEC);
overwrite('src/store/plugins/tauriSessionStorage.spec.ts', TAURI_SPEC);

info('\n\u2705 R2 完成(会话持久化 → localStorage 唯一权威,启动 await 已移除,零删除)。');
info('请依次运行验证:');
info('  pnpm typecheck && pnpm lint && pnpm test');
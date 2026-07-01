// refactor-drop-async-session-wrappers.mjs
// 目的:删除 session/store.ts 的三个异步兼容包装(loadSession/saveSession/clearSession),
//       把唯一生产调用方(useWorkbench.flushSession)改用同步 writeSessionSnapshot,
//       并把三个测试改测/改 mock 同步核心。行为等价(async 函数内同步 throw == rejected Promise)。
// 运行:仓库根目录  node refactor-drop-async-session-wrappers.mjs
// 安全:基线守卫 + 幂等;先全部改在内存,校验通过才统一落盘,避免半迁移态。
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const P_STORE = path.join('src', 'services', 'session', 'store.ts');
const P_STORE_SPEC = path.join('src', 'services', 'session', 'store.spec.ts');
const P_WB = path.join('src', 'app', 'composables', 'useWorkbench.ts');
const P_WB_SPEC = path.join('src', 'app', 'composables', 'useWorkbench.lifecycle.spec.ts');
const P_FACADE_SPEC = path.join('src', 'composables', '__tests__', 'workbench.facade.spec.ts');

const abort = (msg) => {
  console.error(`✗ ${msg}\n  未改动任何文件。`);
  process.exit(1);
};
const read = async (rel) => {
  if (!existsSync(rel)) abort(`找不到 ${rel},脚本需在仓库根目录运行。`);
  return readFile(rel, 'utf8');
};
// 精确单次替换:oldStr 必须恰好出现一次,否则中止(防止误伤/文件已漂移)。
const replaceOnce = (src, oldStr, newStr, label) => {
  const parts = src.split(oldStr);
  if (parts.length !== 2) abort(`${label}: 预期锚点恰好出现 1 次,实际 ${parts.length - 1} 次。基线不符,中止。`);
  return parts.join(newStr);
};

// --- 读取 ---
const storeSrc = await read(P_STORE);
const storeSpecSrc = await read(P_STORE_SPEC);
const wbSrc = await read(P_WB);
const wbSpecSrc = await read(P_WB_SPEC);
const facadeSpecSrc = await read(P_FACADE_SPEC);

// --- 幂等:已迁移则跳过 ---
const alreadyDone =
  !storeSrc.includes('兼容异步 API') &&
  !wbSrc.includes("import { saveSession } from '@/services/session/store';");
if (alreadyDone) {
  console.log('✓ 已迁移过(store.ts 无异步包装且 useWorkbench 不再 import saveSession),跳过。');
  process.exit(0);
}

// --- 1) store.ts:截断掉「兼容异步 API」整段 ---
const ASYNC_MARKER =
  '\n// ---------------------------------------------------------------------------\n' +
  '// 兼容异步 API (保持既有调用方签名不变)';
const cut = storeSrc.indexOf(ASYNC_MARKER);
if (cut === -1) abort('store.ts: 找不到「兼容异步 API」段落锚点,基线不符,中止。');
for (const sym of ['export const loadSession', 'export const saveSession', 'export const clearSession']) {
  if (!storeSrc.includes(sym)) abort(`store.ts: 缺少 ${sym},基线不符,中止。`);
}
const newStore = storeSrc.slice(0, cut).replace(/\s*$/, '') + '\n';

// --- 2) useWorkbench.ts:import + flushSession 改同步核心 ---
let newWb = replaceOnce(
  wbSrc,
  "import { saveSession } from '@/services/session/store';",
  "import { writeSessionSnapshot } from '@/services/session/store';",
  'useWorkbench.ts import',
);
newWb = replaceOnce(
  newWb,
  '  const flushSession = async (): Promise<void> => {\n' +
    '    await saveSession(editorStore.sessionSnapshot);\n' +
    '  };',
  // 保持 async:同步 writeSessionSnapshot 抛错 → 自动变 rejected Promise,
  // 与旧 saveSession 的 reject 语义一致,flushSessionWithTimeout 的 catch 照常接住。
  '  const flushSession = async (): Promise<void> => {\n' +
    '    writeSessionSnapshot(editorStore.sessionSnapshot);\n' +
    '  };',
  'useWorkbench.ts flushSession',
);

// --- 3) useWorkbench.lifecycle.spec.ts:mock 改名 ---
const newWbSpec = replaceOnce(
  wbSpecSrc,
  "vi.mock('@/services/session/store', () => ({\n" +
    '  saveSession: vi.fn(() => Promise.resolve()),\n' +
    '}));',
  "vi.mock('@/services/session/store', () => ({\n" +
    '  writeSessionSnapshot: vi.fn(),\n' +
    '}));',
  'useWorkbench.lifecycle.spec.ts mock',
);

// --- 4) workbench.facade.spec.ts:hoisted + vi.mock 两处改名 ---
let newFacade = replaceOnce(
  facadeSpecSrc,
  '  mockSessionStore: {\n    saveSession: vi.fn(() => Promise.resolve()),\n  },',
  '  mockSessionStore: {\n    writeSessionSnapshot: vi.fn(),\n  },',
  'workbench.facade.spec.ts hoisted',
);
newFacade = replaceOnce(
  newFacade,
  "vi.mock('@/services/session/store', () => ({\n" +
    '  saveSession: mockSessionStore.saveSession,\n' +
    '}));',
  "vi.mock('@/services/session/store', () => ({\n" +
    '  writeSessionSnapshot: mockSessionStore.writeSessionSnapshot,\n' +
    '}));',
  'workbench.facade.spec.ts vi.mock',
);

// --- 5) store.spec.ts:整文件重写,改测同步核心(7 用例 1:1 对应,reject→throw) ---
const NEW_STORE_SPEC = `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('sessionStore (localStorage 权威, 同步核心)', () => {
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

  it('无快照时 readSessionSnapshot 返回 null', async () => {
    const { readSessionSnapshot } = await import('@/services/session/store');
    expect(readSessionSnapshot()).toBeNull();
  });

  it('writeSessionSnapshot 写入后 readSessionSnapshot 读回同一快照', async () => {
    const { writeSessionSnapshot, readSessionSnapshot } = await import('@/services/session/store');
    writeSessionSnapshot(createSnapshot('/tmp/roundtrip'));
    expect(readSessionSnapshot()).toMatchObject({ workspaceRoot: '/tmp/roundtrip' });
    expect(storage.getItem(SESSION_KEY)).not.toBeNull();
  });

  it('writeSessionSnapshot 入参非法时抛 AppError(SESSION_VALIDATION_FAILED) 且不写盘', async () => {
    const { writeSessionSnapshot } = await import('@/services/session/store');
    let caught: AppError | null = null;
    try {
      writeSessionSnapshot({} as never);
    } catch (error) {
      caught = error as AppError;
    }
    expect(caught).toMatchObject<AppError>({
      code: 'SESSION_VALIDATION_FAILED',
      scope: 'ipc',
    });
    expect(storage.getItem(SESSION_KEY)).toBeNull();
  });

  it('schema 校验失败时 readSessionSnapshot 返回 null 并 warn', async () => {
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
    const { readSessionSnapshot } = await import('@/services/session/store');
    expect(readSessionSnapshot()).toBeNull();
    expect(warnMock).toHaveBeenCalled();
  });

  it('坏 JSON 时 readSessionSnapshot 返回 null 且不抛', async () => {
    storage.setItem(SESSION_KEY, '{ not json');
    const { readSessionSnapshot } = await import('@/services/session/store');
    expect(readSessionSnapshot()).toBeNull();
    expect(warnMock).toHaveBeenCalled();
  });

  it('clearSessionSnapshot 清除快照', async () => {
    const { writeSessionSnapshot, clearSessionSnapshot, readSessionSnapshot } = await import(
      '@/services/session/store'
    );
    writeSessionSnapshot(createSnapshot());
    clearSessionSnapshot();
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    expect(readSessionSnapshot()).toBeNull();
  });

  it('首次读取时把旧版键迁移到新键', async () => {
    storage.setItem(LEGACY_KEY, JSON.stringify(createSnapshot('/tmp/legacy')));
    const { readSessionSnapshot } = await import('@/services/session/store');
    expect(readSessionSnapshot()).toMatchObject({ workspaceRoot: '/tmp/legacy' });
    expect(storage.getItem(SESSION_KEY)).not.toBeNull();
    expect(storage.getItem(LEGACY_KEY)).toBeNull();
  });
});
`;

// --- 统一落盘(全部校验通过后) ---
await writeFile(P_STORE, newStore, 'utf8');
await writeFile(P_WB, newWb, 'utf8');
await writeFile(P_WB_SPEC, newWbSpec, 'utf8');
await writeFile(P_FACADE_SPEC, newFacade, 'utf8');
await writeFile(P_STORE_SPEC, NEW_STORE_SPEC, 'utf8');

console.log('✓ 已删除三个异步兼容包装,并把调用方/测试改到同步核心。');
console.log('  改动文件:');
console.log('   - src/services/session/store.ts            (删「兼容异步 API」整段)');
console.log('   - src/app/composables/useWorkbench.ts       (saveSession → writeSessionSnapshot)');
console.log('   - src/services/session/store.spec.ts        (整文件重写,测同步核心)');
console.log('   - src/app/composables/useWorkbench.lifecycle.spec.ts (mock 改名)');
console.log('   - src/composables/__tests__/workbench.facade.spec.ts (mock 改名)');
console.log('  必跑验证:');
console.log('   pnpm test src/services/session/ src/app/composables/ src/composables/__tests__/');
console.log('   pnpm tsc --noEmit  &&  pnpm lint --fix');
console.log('   node scan-session-api-usage.mjs   # 三个符号应彻底归零(仅剩本脚本自匹配)');
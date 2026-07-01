import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    tauriSessionStorage.setItem(EDITOR_KEY, JSON.stringify({ sessionSnapshot: createSnapshot() }));
    expect(storage.getItem(SESSION_KEY)).not.toBeNull();
    tauriSessionStorage.removeItem(EDITOR_KEY);
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    expect(tauriSessionStorage.getItem(EDITOR_KEY)).toBeNull();
  });
});

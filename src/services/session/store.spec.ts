import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoadSession = vi.fn();
const mockSaveSession = vi.fn();
const mockClearSession = vi.fn();

vi.mock('@/services/session/store', () => ({
  clearSession: mockClearSession,
  loadSession: mockLoadSession,
  saveSession: mockSaveSession,
}));

const EDITOR_KEY = 'shell-ide:editor';

describe('tauriSessionStorage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('hydrateSessionStorage 超时后不抛异常，getItem 返回 null', async () => {
    vi.useFakeTimers();
    mockLoadSession.mockReturnValue(new Promise(() => undefined));

    const { hydrateSessionStorage, tauriSessionStorage } = await import(
      '@/store/plugins/tauriSessionStorage'
    );

    const task = hydrateSessionStorage();
    await vi.advanceTimersByTimeAsync(301);
    await task;

    expect(tauriSessionStorage.getItem('shell-ide:editor')).toBeNull();
  });

  it('hydrate 后 getItem 返回缓存快照', async () => {
    mockLoadSession.mockResolvedValue({
      schemaVersion: 1,
      workspaceRoot: '/tmp/workspace',
      openTabs: [],
      activeTabPath: null,
      viewStates: [],
      recentWorkspaces: [],
      recentFiles: [],
      savedAt: new Date().toISOString(),
    });

    const { hydrateSessionStorage, tauriSessionStorage } = await import(
      '@/store/plugins/tauriSessionStorage'
    );

    await hydrateSessionStorage();
    const raw = tauriSessionStorage.getItem('shell-ide:editor');

    expect(raw).not.toBeNull();
    expect(typeof raw).toBe('string');
  });

  it('removeItem 会取消防抖保存并清空持久化快照，避免旧会话回写', async () => {
    vi.useFakeTimers();
    mockLoadSession.mockResolvedValue(null);
    mockSaveSession.mockResolvedValue(undefined);
    mockClearSession.mockResolvedValue(undefined);

    const { hydrateSessionStorage, tauriSessionStorage } = await import(
      '@/store/plugins/tauriSessionStorage'
    );

    await hydrateSessionStorage();
    tauriSessionStorage.setItem(
      'shell-ide:editor',
      JSON.stringify({ sessionSnapshot: createSnapshot() }),
    );
    tauriSessionStorage.removeItem('shell-ide:editor');

    await vi.advanceTimersByTimeAsync(501);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSaveSession).not.toHaveBeenCalled();
    expect(mockClearSession).toHaveBeenCalledOnce();
    expect(tauriSessionStorage.getItem('shell-ide:editor')).toBeNull();
  });

  it('hydrate 超时占位期写入的会话,后台读取返回后落用户值而非磁盘旧值', async () => {
    vi.useFakeTimers();
    let resolveLoad: (value: unknown) => void = () => undefined;
    mockLoadSession.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    mockSaveSession.mockResolvedValue(undefined);

    const { hydrateSessionStorage, tauriSessionStorage } = await import(
      '@/store/plugins/tauriSessionStorage'
    );

    const task = hydrateSessionStorage();
    await vi.advanceTimersByTimeAsync(301);
    expect(await task).toBe('timeout');

    // 占位期用户写入新会话(此时不应直接落盘)。
    const userSnapshot = createSnapshot('/tmp/user-edit');
    tauriSessionStorage.setItem(EDITOR_KEY, JSON.stringify({ sessionSnapshot: userSnapshot }));
    expect(mockSaveSession).not.toHaveBeenCalled();

    // 后台读取真正返回(磁盘上是另一份旧快照)。
    resolveLoad(createSnapshot('/tmp/disk-old'));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(501);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSaveSession).toHaveBeenCalledOnce();
    expect(mockSaveSession.mock.calls[0]?.[0]).toMatchObject({ workspaceRoot: '/tmp/user-edit' });
  });

  it('hydrate 超时但占位期无写入,后台读取返回后恢复磁盘快照且不回写', async () => {
    vi.useFakeTimers();
    let resolveLoad: (value: unknown) => void = () => undefined;
    mockLoadSession.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    mockSaveSession.mockResolvedValue(undefined);

    const { hydrateSessionStorage, tauriSessionStorage } = await import(
      '@/store/plugins/tauriSessionStorage'
    );

    const task = hydrateSessionStorage();
    await vi.advanceTimersByTimeAsync(301);
    expect(await task).toBe('timeout');
    expect(tauriSessionStorage.getItem(EDITOR_KEY)).toBeNull();

    // 后台读取返回磁盘快照:应恢复进 cache,但不触发落盘。
    resolveLoad(createSnapshot('/tmp/disk-recovered'));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2001);
    await Promise.resolve();

    const raw = tauriSessionStorage.getItem(EDITOR_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).sessionSnapshot).toMatchObject({
      workspaceRoot: '/tmp/disk-recovered',
    });
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it('持续高频写入不会饿死防抖,最迟在 SAVE_MAX_WAIT_MS 内落盘一次', async () => {
    vi.useFakeTimers();
    mockLoadSession.mockResolvedValue(null);
    mockSaveSession.mockResolvedValue(undefined);

    const { hydrateSessionStorage, tauriSessionStorage } = await import(
      '@/store/plugins/tauriSessionStorage'
    );

    await hydrateSessionStorage();

    // 每 400ms 写一次(小于 500ms 防抖窗口),持续 2000ms。
    for (let elapsed = 0; elapsed <= 2000; elapsed += 400) {
      tauriSessionStorage.setItem(
        EDITOR_KEY,
        JSON.stringify({ sessionSnapshot: createSnapshot(`/tmp/burst-${elapsed}`) }),
      );
      await vi.advanceTimersByTimeAsync(400);
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSaveSession).toHaveBeenCalled();
  });
});

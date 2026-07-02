import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 防抖窗口上限 + 余量。
const SAVE_WAIT_MS = 350;
// hydrate 超时窗口(300ms) + 余量。
const HYDRATE_TIMEOUT_WAIT_MS = 350;

const { idbMock } = vi.hoisted(() => {
  const map = new Map<string, string>();
  return {
    idbMock: {
      map,
      createStore: vi.fn(() => ({})),
      get: vi.fn(async (key: string) => map.get(key)),
      set: vi.fn(async (key: string, value: string) => {
        map.set(key, value);
      }),
      del: vi.fn(async (key: string) => {
        map.delete(key);
      }),
    },
  };
});

vi.mock('idb-keyval', () => ({
  createStore: idbMock.createStore,
  get: idbMock.get,
  set: idbMock.set,
  del: idbMock.del,
}));

const KEY = 'shell-ide.ai-thread-entries';

const loadModule = async () => {
  vi.resetModules();
  return import('./aiThreadEntriesStorage');
};

beforeEach(() => {
  idbMock.map.clear();
  idbMock.createStore.mockClear();
  idbMock.get.mockClear();
  idbMock.set.mockClear();
  idbMock.del.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ai-thread-entries 镜像持久化 storage', () => {
  it('idb 为空时 hydrate 返回 empty', async () => {
    const mod = await loadModule();
    const { status, raw } = await mod.hydrateAiThreadEntriesSnapshot();
    expect(status).toBe('empty');
    expect(raw).toBeNull();
    expect(mod.getAiThreadEntriesSnapshotRaw()).toBeNull();
  });

  it('hydrate 命中后返回原始快照(不还原图片指针)', async () => {
    const raw = JSON.stringify({ version: 1, activeThreadId: null, threads: [] });
    idbMock.map.set(KEY, raw);
    const mod = await loadModule();
    const result = await mod.hydrateAiThreadEntriesSnapshot();
    expect(result.status).toBe('loaded');
    expect(result.raw).toBe(raw);
  });

  it('schedule 后防抖落盘到新 key', async () => {
    const mod = await loadModule();
    await mod.hydrateAiThreadEntriesSnapshot();
    mod.scheduleAiThreadEntriesPersist('{"v":1}');
    expect(mod.getAiThreadEntriesSnapshotRaw()).toBe('{"v":1}');
    expect(idbMock.set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(idbMock.set).toHaveBeenCalledWith(KEY, '{"v":1}', expect.anything());
  });

  it('schedule 与 cache 相同时不重复落盘', async () => {
    idbMock.map.set(KEY, '{"v":1}');
    const mod = await loadModule();
    await mod.hydrateAiThreadEntriesSnapshot();
    idbMock.set.mockClear();
    mod.scheduleAiThreadEntriesPersist('{"v":1}');
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(idbMock.set).not.toHaveBeenCalled();
  });

  it('快照内 data:image 经 preparePersistValue 抽取为共享池指针', async () => {
    const mod = await loadModule();
    await mod.hydrateAiThreadEntriesSnapshot();
    const snapshot = JSON.stringify({
      version: 1,
      activeThreadId: 't',
      threads: [
        {
          id: 't',
          entries: [
            {
              type: 'user_message',
              references: [{ attachmentPreview: { src: 'data:image/png;base64,XYZ' } }],
            },
          ],
        },
      ],
    });
    mod.scheduleAiThreadEntriesPersist(snapshot);
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);

    // data:image 抽取走 crypto.subtle.digest（libuv 线程池完成 → 宏任务回调），
    // advanceTimersByTimeAsync 的微任务冲洗驱动不到它，落盘链仍挂起。
    // 切回真实计时，用 vi.waitFor 轮询等待 idb.set 真正写入。
    vi.useRealTimers();
    await vi.waitFor(() => {
      expect(idbMock.map.get(KEY)).toBeDefined();
    });

    const written = idbMock.map.get(KEY);
    expect(written).toContain('idb://ai-conversation-attachment-preview/');
    expect(written).not.toContain('data:image/png;base64,XYZ');
    // base64 落入共享图片池
    expect([...idbMock.map.values()]).toContain('data:image/png;base64,XYZ');
  });

  it('flush 立即把未落盘快照入队写入', async () => {
    const mod = await loadModule();
    await mod.hydrateAiThreadEntriesSnapshot();
    mod.scheduleAiThreadEntriesPersist('{"v":2}');
    expect(idbMock.set).not.toHaveBeenCalled();
    mod.flushAiThreadEntriesPersist();
    await vi.advanceTimersByTimeAsync(0);
    expect(idbMock.set).toHaveBeenCalledWith(KEY, '{"v":2}', expect.anything());
  });

  it('clear 删除新 key 并清空 cache', async () => {
    idbMock.map.set(KEY, '{"v":1}');
    const mod = await loadModule();
    await mod.hydrateAiThreadEntriesSnapshot();
    mod.clearAiThreadEntriesSnapshot();
    expect(mod.getAiThreadEntriesSnapshotRaw()).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(idbMock.del).toHaveBeenCalledWith(KEY, expect.anything());
  });

  it('hydrate 超时返回 timeout 且 cache 为 null', async () => {
    idbMock.get.mockImplementationOnce(() => new Promise<string | undefined>(() => {}));
    const mod = await loadModule();
    const hydratePromise = mod.hydrateAiThreadEntriesSnapshot();
    await vi.advanceTimersByTimeAsync(HYDRATE_TIMEOUT_WAIT_MS);
    const result = await hydratePromise;
    expect(result.status).toBe('timeout');
    expect(result.raw).toBeNull();
    expect(mod.getAiThreadEntriesSnapshotRaw()).toBeNull();
  });
});

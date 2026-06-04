import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 防抖窗口上限 + 一点余量，确保定时器已触发。
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

const KEY = 'shell-ide.ai-conversation';

const loadModule = async () => {
  vi.resetModules();
  return import('./debouncedPersistStorage');
};

beforeEach(() => {
  idbMock.map.clear();
  idbMock.createStore.mockClear();
  idbMock.get.mockClear();
  idbMock.set.mockClear();
  idbMock.del.mockClear();
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ai-conversation idb 持久化 storage', () => {
  it('hydrate 前 getItem 返回 null', async () => {
    const mod = await loadModule();
    expect(mod.getAiConversationPersistStorage().getItem(KEY)).toBeNull();
  });

  it('hydrate 命中 idb 已有值后 getItem 返回该值', async () => {
    idbMock.map.set(KEY, '{"threads":[]}');
    const mod = await loadModule();
    const status = await mod.hydrateAiConversationStorage();
    expect(status).toBe('loaded');
    expect(mod.getAiConversationPersistStorage().getItem(KEY)).toBe('{"threads":[]}');
  });

  it('idb 为空时从 localStorage 迁移并清除旧 key', async () => {
    localStorage.setItem(KEY, '{"legacy":true}');
    const mod = await loadModule();
    const status = await mod.hydrateAiConversationStorage();
    expect(status).toBe('loaded');
    expect(idbMock.set).toHaveBeenCalledWith(KEY, '{"legacy":true}', expect.anything());
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(mod.getAiConversationPersistStorage().getItem(KEY)).toBe('{"legacy":true}');
  });

  it('idb 与 localStorage 均为空时以空态启动', async () => {
    const mod = await loadModule();
    const status = await mod.hydrateAiConversationStorage();
    expect(status).toBe('empty');
    expect(mod.getAiConversationPersistStorage().getItem(KEY)).toBeNull();
  });

  it('setItem 更新 cache 并防抖落盘到 idb', async () => {
    const mod = await loadModule();
    await mod.hydrateAiConversationStorage();
    const storage = mod.getAiConversationPersistStorage();

    storage.setItem(KEY, '{"v":1}');
    expect(storage.getItem(KEY)).toBe('{"v":1}'); // cache 立即可见
    expect(idbMock.set).not.toHaveBeenCalled(); // 尚未落盘

    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(idbMock.set).toHaveBeenCalledWith(KEY, '{"v":1}', expect.anything());
  });

  it('setItem 与 cache 相同时不重复落盘', async () => {
    idbMock.map.set(KEY, '{"v":1}');
    const mod = await loadModule();
    await mod.hydrateAiConversationStorage();
    idbMock.set.mockClear();
    const storage = mod.getAiConversationPersistStorage();

    storage.setItem(KEY, '{"v":1}'); // 与 cache 相同
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(idbMock.set).not.toHaveBeenCalled();
  });

  it('removeItem 清空 cache 并删除 idb 记录', async () => {
    idbMock.map.set(KEY, '{"v":1}');
    const mod = await loadModule();
    await mod.hydrateAiConversationStorage();
    const storage = mod.getAiConversationPersistStorage();

    storage.removeItem(KEY);
    expect(storage.getItem(KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(idbMock.del).toHaveBeenCalledWith(KEY, expect.anything());
  });

  it('hydrate 超时占位期的 setItem 不落盘,settle 后以用户新值落盘', async () => {
    let resolveGet: (value: string | undefined) => void = () => {};
    idbMock.get.mockImplementationOnce(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveGet = resolve;
        }),
    );
    const mod = await loadModule();
    const storage = mod.getAiConversationPersistStorage();

    const hydratePromise = mod.hydrateAiConversationStorage();
    await vi.advanceTimersByTimeAsync(HYDRATE_TIMEOUT_WAIT_MS);
    expect(await hydratePromise).toBe('timeout');

    // 占位期写入:仅进 cache,不落盘
    storage.setItem(KEY, '{"fresh":true}');
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(idbMock.set).not.toHaveBeenCalled();

    // 磁盘历史此刻才返回 → 对账:用户新值权威,落盘
    resolveGet('{"history":true}');
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(idbMock.set).toHaveBeenCalledWith(KEY, '{"fresh":true}', expect.anything());
  });

  it('hydrate 超时且占位期无写入时,settle 后恢复磁盘历史且不落盘', async () => {
    let resolveGet: (value: string | undefined) => void = () => {};
    idbMock.get.mockImplementationOnce(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveGet = resolve;
        }),
    );
    const mod = await loadModule();
    const storage = mod.getAiConversationPersistStorage();

    const hydratePromise = mod.hydrateAiConversationStorage();
    await vi.advanceTimersByTimeAsync(HYDRATE_TIMEOUT_WAIT_MS);
    expect(await hydratePromise).toBe('timeout');
    expect(storage.getItem(KEY)).toBeNull();

    resolveGet('{"history":true}');
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(storage.getItem(KEY)).toBe('{"history":true}');
    expect(idbMock.set).not.toHaveBeenCalled();
  });

  it('hydrate 超时占位期 store 回写的空白初始态不得覆盖磁盘历史', async () => {
    let resolveGet: (value: string | undefined) => void = () => {};
    idbMock.get.mockImplementationOnce(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveGet = resolve;
        }),
    );
    const mod = await loadModule();
    const storage = mod.getAiConversationPersistStorage();

    const hydratePromise = mod.hydrateAiConversationStorage();
    await vi.advanceTimersByTimeAsync(HYDRATE_TIMEOUT_WAIT_MS);
    expect(await hydratePromise).toBe('timeout');

    // 模拟 pinia 超时占位期同步 hydrate:getItem 返回 null,afterHydrate 随即
    // 把 store 归一化为空白初始态并回写一次。
    expect(storage.getItem(KEY)).toBeNull();
    storage.setItem(KEY, '{"activeThreadId":"t","threads":[]}');
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(idbMock.set).not.toHaveBeenCalled();

    // 磁盘历史此刻才读出:必须恢复,且不得被空白初始态覆盖。
    resolveGet('{"history":true}');
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(idbMock.set).not.toHaveBeenCalled();
    expect(storage.getItem(KEY)).toBe('{"history":true}');
  });

  it('hydrate 超时:空白回写被忽略,但其后用户真实输入仍落盘', async () => {
    let resolveGet: (value: string | undefined) => void = () => {};
    idbMock.get.mockImplementationOnce(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveGet = resolve;
        }),
    );
    const mod = await loadModule();
    const storage = mod.getAiConversationPersistStorage();

    const hydratePromise = mod.hydrateAiConversationStorage();
    await vi.advanceTimersByTimeAsync(HYDRATE_TIMEOUT_WAIT_MS);
    expect(await hydratePromise).toBe('timeout');

    expect(storage.getItem(KEY)).toBeNull();
    storage.setItem(KEY, '{"activeThreadId":"t","threads":[]}'); // 回声:丢弃
    storage.setItem(KEY, '{"fresh":true}'); // 用户真实输入
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(idbMock.set).not.toHaveBeenCalled(); // 尚未 settle，仍在 defer

    resolveGet('{"history":true}');
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(idbMock.set).toHaveBeenCalledWith(KEY, '{"fresh":true}', expect.anything());
  });

  it('hydrate 超时:settle 之后才到达的空白回写仍被忽略', async () => {
    let resolveGet: (value: string | undefined) => void = () => {};
    idbMock.get.mockImplementationOnce(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveGet = resolve;
        }),
    );
    const mod = await loadModule();
    const storage = mod.getAiConversationPersistStorage();

    const hydratePromise = mod.hydrateAiConversationStorage();
    await vi.advanceTimersByTimeAsync(HYDRATE_TIMEOUT_WAIT_MS);
    expect(await hydratePromise).toBe('timeout');
    expect(storage.getItem(KEY)).toBeNull();

    // settle 先发生:磁盘历史恢复。
    resolveGet('{"history":true}');
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(storage.getItem(KEY)).toBe('{"history":true}');

    // 之后才到达的空白回写:必须丢弃,不得覆盖已恢复的历史。
    storage.setItem(KEY, '{"activeThreadId":"t","threads":[]}');
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(idbMock.set).not.toHaveBeenCalled();
    expect(storage.getItem(KEY)).toBe('{"history":true}');
  });

  it('hydrate 只回填 active 线程图片, 其余历史线程保留 idb:// 指针（懒加载）', async () => {
    idbMock.map.set('ai-conversation-attachment-preview:a1', 'data:image/png;base64,ACTIVE');
    idbMock.map.set('ai-conversation-attachment-preview:b1', 'data:image/png;base64,OTHER');
    const snapshot = JSON.stringify({
      activeThreadId: 'tA',
      threads: [
        {
          id: 'tA',
          messages: [
            {
              references: [
                { attachmentPreview: { src: 'idb://ai-conversation-attachment-preview/a1' } },
              ],
            },
          ],
        },
        {
          id: 'tB',
          messages: [
            {
              references: [
                { attachmentPreview: { src: 'idb://ai-conversation-attachment-preview/b1' } },
              ],
            },
          ],
        },
      ],
    });
    idbMock.map.set(KEY, snapshot);

    const mod = await loadModule();
    await mod.hydrateAiConversationStorage();

    const restored = JSON.parse(mod.getAiConversationPersistStorage().getItem(KEY) ?? 'null') as {
      threads: Array<{
        messages: Array<{ references: Array<{ attachmentPreview: { src: string } }> }>;
      }>;
    };
    // active 线程：指针已解析为 base64
    expect(restored.threads[0].messages[0].references[0].attachmentPreview.src).toBe(
      'data:image/png;base64,ACTIVE',
    );
    // 非 active 线程：仍保留指针（按需加载）
    expect(restored.threads[1].messages[0].references[0].attachmentPreview.src).toBe(
      'idb://ai-conversation-attachment-preview/b1',
    );
  });

  it('restoreAttachmentPreviewPointers 按需把指针解析回 base64 且不改动原对象', async () => {
    idbMock.map.set('ai-conversation-attachment-preview:b1', 'data:image/png;base64,OTHER');
    const mod = await loadModule();

    const input = [
      {
        references: [{ attachmentPreview: { src: 'idb://ai-conversation-attachment-preview/b1' } }],
      },
    ];
    const result = await mod.restoreAttachmentPreviewPointers(input);

    expect(result.changed).toBe(true);
    expect(result.value[0].references[0].attachmentPreview.src).toBe('data:image/png;base64,OTHER');
    // 深拷贝：原对象保持指针不变
    expect(input[0].references[0].attachmentPreview.src).toBe(
      'idb://ai-conversation-attachment-preview/b1',
    );
  });

  it('restoreAttachmentPreviewPointers 无指针时 changed=false 并原样返回', async () => {
    const mod = await loadModule();

    const input = [{ references: [{ attachmentPreview: { src: 'data:image/png;base64,X' } }] }];
    const result = await mod.restoreAttachmentPreviewPointers(input);

    expect(result.changed).toBe(false);
    expect(result.value).toBe(input);
  });
});

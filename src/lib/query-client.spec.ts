import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 用内存 Map 模拟 idb-keyval,避免测试环境对 IndexedDB 的依赖。
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
  };
});

describe('setupQueryPersistence', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('启动时清理旧的 localStorage 持久化块', async () => {
    window.localStorage.setItem('calamex.vue-query', '{"clientState":"legacy"}');

    const { setupQueryPersistence } = await import('./query-client');
    await setupQueryPersistence();

    expect(window.localStorage.getItem('calamex.vue-query')).toBeNull();
  });

  it('重复调用保持幂等', async () => {
    const { setupQueryPersistence } = await import('./query-client');

    await setupQueryPersistence();
    await expect(setupQueryPersistence()).resolves.toBeUndefined();
  });
});

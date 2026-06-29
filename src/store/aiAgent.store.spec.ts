import { createPinia, setActivePinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';

import { useAiAgentStore } from '@/store/aiAgent';

const createPersistedPinia = () => {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({}).use(pinia);
  setActivePinia(pinia);
  return pinia;
};

describe('aiAgent store persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('默认使用 agent 模式，并在刷新后恢复用户上次切换的模式', async () => {
    createPersistedPinia();
    const store = useAiAgentStore();

    expect(store.mode).toBe('agent');

    store.mode = 'plan';
    await nextTick();

    createPersistedPinia();
    const restored = useAiAgentStore();

    expect(restored.mode).toBe('plan');
  });

  it('默认执行模式为 interactive，并在刷新后恢复用户切换的自主模式', async () => {
    createPersistedPinia();
    const store = useAiAgentStore();

    expect(store.executionMode).toBe('interactive');

    store.setExecutionMode('autonomous');
    await nextTick();

    createPersistedPinia();
    const restored = useAiAgentStore();

    expect(restored.executionMode).toBe('autonomous');
  });
});

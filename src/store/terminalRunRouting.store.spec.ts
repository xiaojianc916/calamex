import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTerminalRunRoutingStore } from '@/store/terminalRunRouting';

describe('useTerminalRunRoutingStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('默认无运行归属会话', () => {
    const store = useTerminalRunRoutingStore();
    expect(store.activeRunSessionId).toBeNull();
  });

  it('可设置并清空运行归属的唯一会话编号', () => {
    const store = useTerminalRunRoutingStore();
    store.setActiveRunSessionId('terminal-abc-1');
    expect(store.activeRunSessionId).toBe('terminal-abc-1');
    store.setActiveRunSessionId(null);
    expect(store.activeRunSessionId).toBeNull();
  });
});

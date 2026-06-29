import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTerminalTabsStore } from '@/domains/terminal/state/terminalTabs';
import { DEFAULT_TERMINAL_SESSION_ID } from '@/types/terminal';

describe('terminal tabs store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('初始包含首会话且为 active', () => {
    const store = useTerminalTabsStore();
    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.sessionId).toBe(DEFAULT_TERMINAL_SESSION_ID);
    expect(store.activeSessionId).toBe(DEFAULT_TERMINAL_SESSION_ID);
    expect(store.activeTab?.sessionId).toBe(DEFAULT_TERMINAL_SESSION_ID);
  });

  it('addTab 新建独立会话并切换为 active，标题单调递增', () => {
    const store = useTerminalTabsStore();
    const tab = store.addTab();
    expect(store.tabs).toHaveLength(2);
    expect(store.activeSessionId).toBe(tab.sessionId);
    expect(tab.sessionId).not.toBe(DEFAULT_TERMINAL_SESSION_ID);
    expect(tab.title).toBe('终端 2');

    const second = store.addTab();
    expect(second.title).toBe('终端 3');
    expect(second.sessionId).not.toBe(tab.sessionId);
  });

  it('setActive 仅在 tab 存在时生效', () => {
    const store = useTerminalTabsStore();
    const tab = store.addTab();

    store.setActive(DEFAULT_TERMINAL_SESSION_ID);
    expect(store.activeSessionId).toBe(DEFAULT_TERMINAL_SESSION_ID);

    store.setActive('not-exist');
    expect(store.activeSessionId).toBe(DEFAULT_TERMINAL_SESSION_ID);

    store.setActive(tab.sessionId);
    expect(store.activeSessionId).toBe(tab.sessionId);
  });

  it('closeTab 关闭不存在的 tab 返回 false', () => {
    const store = useTerminalTabsStore();
    expect(store.closeTab('not-exist')).toBe(false);
    expect(store.tabs).toHaveLength(1);
  });

  it('关闭 active tab 后回退到相邻 tab，关闭非 active 不影响选中', () => {
    const store = useTerminalTabsStore();
    const second = store.addTab();
    const third = store.addTab();
    expect(store.activeSessionId).toBe(third.sessionId);

    expect(store.closeTab(third.sessionId)).toBe(true);
    expect(store.activeSessionId).toBe(second.sessionId);

    store.closeTab(DEFAULT_TERMINAL_SESSION_ID);
    expect(store.activeSessionId).toBe(second.sessionId);
    expect(store.tabs).toHaveLength(1);
  });

  it('关闭最后一个 tab 后 active 为空字符串，activeTab 为 null', () => {
    const store = useTerminalTabsStore();
    expect(store.closeTab(DEFAULT_TERMINAL_SESSION_ID)).toBe(true);
    expect(store.tabs).toHaveLength(0);
    expect(store.activeSessionId).toBe('');
    expect(store.activeTab).toBeNull();
  });

  it('ensurePrimaryTab 在无 tab 时补回首会话，有 tab 时为 no-op', () => {
    const store = useTerminalTabsStore();
    store.closeTab(DEFAULT_TERMINAL_SESSION_ID);
    expect(store.tabs).toHaveLength(0);

    store.ensurePrimaryTab();
    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.sessionId).toBe(DEFAULT_TERMINAL_SESSION_ID);
    expect(store.activeSessionId).toBe(DEFAULT_TERMINAL_SESSION_ID);

    store.ensurePrimaryTab();
    expect(store.tabs).toHaveLength(1);
  });

  it('setTabTitle 忽略空白标题，否则更新；不存在的会话安静忽略', () => {
    const store = useTerminalTabsStore();
    store.setTabTitle(DEFAULT_TERMINAL_SESSION_ID, '  ');
    expect(store.tabs[0]?.title).toBe('终端 1');

    store.setTabTitle(DEFAULT_TERMINAL_SESSION_ID, '构建');
    expect(store.tabs[0]?.title).toBe('构建');

    store.setTabTitle('not-exist', '随便');
    expect(store.tabs).toHaveLength(1);
  });
});

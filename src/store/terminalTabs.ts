import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { DEFAULT_TERMINAL_SESSION_ID } from '@/types/terminal';
import { createPrefixedId } from '@/utils/id';

/** 单个终端 tab 描述（视图层），后端会话由 registry 按 sessionId 持有。 */
export interface ITerminalTab {
  sessionId: string;
  title: string;
}

/**
 * 终端多会话 tab store。
 *
 * 约定：
 *  - 不再区分“主会话”：所有 tab 均可点击 × 关闭。
 *  - 关闭最后一个 tab 后，终端面板由调用方（RunPanel）隐藏。
 *  - 面板重新开启时调用 ensurePrimaryTab() 补一个首会话。
 *  - 首会话固定用 DEFAULT_TERMINAL_SESSION_ID（'main-terminal'），以保证运行管线
 *    （facade / run-chunk / trackRun）始终有归属终端。
 *  - 额外会话的 sessionId 由 crypto.randomUUID() 生成（见 @/utils/id），全局唯一、
 *    不依赖进程内状态，跨重载 / 多窗口不碍撞。
 *  - `+` 直接新建一个独立的 WSL2 交互会话（生成新 sessionId），不弹菜单。
 *  - 后端会话的 dispose 由调用方（RunPanel）负责。
 */
export const useTerminalTabsStore = defineStore('terminal-tabs', () => {
  const tabs = ref<ITerminalTab[]>([{ sessionId: DEFAULT_TERMINAL_SESSION_ID, title: '终端 1' }]);
  const activeSessionId = ref<string>(DEFAULT_TERMINAL_SESSION_ID);

  // 标题用单调递增计数，避免关闭后复用导致重名。
  const creationCount = ref(1);

  const activeTab = computed(
    () => tabs.value.find((tab) => tab.sessionId === activeSessionId.value) ?? null,
  );

  // 会话唯一编号：使用 UUID v4（见 @/utils/id），与终端显示序号（终端 N）解耦。
  const createSessionId = (): string => createPrefixedId('terminal');

  const setActive = (sessionId: string): void => {
    if (tabs.value.some((tab) => tab.sessionId === sessionId)) {
      activeSessionId.value = sessionId;
    }
  };

  /** 新建一个独立 WSL2 会话 tab，并切换为 active。 */
  const addTab = (): ITerminalTab => {
    creationCount.value += 1;
    const tab: ITerminalTab = {
      sessionId: createSessionId(),
      title: `终端 ${creationCount.value}`,
    };
    tabs.value.push(tab);
    activeSessionId.value = tab.sessionId;
    return tab;
  };

  /** 关闭一个 tab（任意 tab 均可关闭）。返回是否真正移除。 */
  const closeTab = (sessionId: string): boolean => {
    const index = tabs.value.findIndex((tab) => tab.sessionId === sessionId);
    if (index === -1) return false;
    tabs.value.splice(index, 1);
    if (activeSessionId.value === sessionId) {
      const fallback = tabs.value[index] ?? tabs.value[index - 1] ?? null;
      activeSessionId.value = fallback?.sessionId ?? '';
    }
    return true;
  };

  /**
   * 终端面板（重新）开启时调用：若当前没有任何 tab，则补一个首会话。
   * 首会话固定用 DEFAULT_TERMINAL_SESSION_ID，保证运行管线始终有归属终端。
   */
  const ensurePrimaryTab = (): void => {
    if (tabs.value.length > 0) return;
    creationCount.value = 1;
    tabs.value = [{ sessionId: DEFAULT_TERMINAL_SESSION_ID, title: '终端 1' }];
    activeSessionId.value = DEFAULT_TERMINAL_SESSION_ID;
  };

  const setTabTitle = (sessionId: string, title: string): void => {
    const tab = tabs.value.find((item) => item.sessionId === sessionId);
    if (tab && title.trim()) tab.title = title;
  };

  return {
    tabs,
    activeSessionId,
    activeTab,
    setActive,
    addTab,
    closeTab,
    ensurePrimaryTab,
    setTabTitle,
  };
});

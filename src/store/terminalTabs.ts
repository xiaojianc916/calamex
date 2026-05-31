import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { DEFAULT_TERMINAL_SESSION_ID } from '@/types/terminal';

/** 单个终端 tab 描述（视图层），后端会话由 registry 按 sessionId 持有。 */
export interface ITerminalTab {
  sessionId: string;
  title: string;
}

/**
 * 终端多会话 tab store。
 *
 * 约定：
 *  - 第一个 tab 固定使用 DEFAULT_TERMINAL_SESSION_ID（'main-terminal'），运行管线
 *    （facade / run-chunk / trackRun）始终路由到该会话，因此该 tab 不可关闭。
 *  - `+` 直接新建一个独立的 WSL2 交互会话（生成新的 sessionId），不弹菜单。
 *  - 关闭 tab 仅从列表移除并切换 active；后端会话的 dispose 由调用方（RunPanel）负责。
 */
export const useTerminalTabsStore = defineStore('terminal-tabs', () => {
  const tabs = ref<ITerminalTab[]>([
    { sessionId: DEFAULT_TERMINAL_SESSION_ID, title: '终端 1' },
  ]);
  const activeSessionId = ref<string>(DEFAULT_TERMINAL_SESSION_ID);

  // 标题用单调递增计数，避免关闭后复用导致重名。
  const creationCount = ref(1);
  // sessionId 生成序列。
  let idSeq = 0;

  const activeTab = computed(
    () => tabs.value.find((tab) => tab.sessionId === activeSessionId.value) ?? null,
  );

  /** 主会话（main-terminal）不可关闭，以保证运行管线始终有归属终端。 */
  const isClosable = (sessionId: string): boolean =>
    sessionId !== DEFAULT_TERMINAL_SESSION_ID;

  const createSessionId = (): string => {
    idSeq += 1;
    return `terminal-${Date.now().toString(36)}-${idSeq.toString(36)}`;
  };

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

  /** 关闭一个 tab（主会话不可关闭）。返回是否真正移除。 */
  const closeTab = (sessionId: string): boolean => {
    if (!isClosable(sessionId)) return false;
    const index = tabs.value.findIndex((tab) => tab.sessionId === sessionId);
    if (index === -1) return false;
    tabs.value.splice(index, 1);
    if (activeSessionId.value === sessionId) {
      const fallback = tabs.value[index] ?? tabs.value[index - 1] ?? null;
      activeSessionId.value = fallback?.sessionId ?? DEFAULT_TERMINAL_SESSION_ID;
    }
    return true;
  };

  const setTabTitle = (sessionId: string, title: string): void => {
    const tab = tabs.value.find((item) => item.sessionId === sessionId);
    if (tab && title.trim()) tab.title = title;
  };

  return {
    tabs,
    activeSessionId,
    activeTab,
    isClosable,
    setActive,
    addTab,
    closeTab,
    setTabTitle,
  };
});

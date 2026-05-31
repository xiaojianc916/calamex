<template>
  <section class="run-panel-shell">
    <header class="run-panel-toolbar">
      <TerminalTabBar
        class="run-panel-tabbar"
        :tabs="tabs"
        :active-session-id="activeSessionId"
        @select="handleSelectTab"
        @close="handleCloseTab"
        @new="handleNewTab"
      />

      <div class="run-panel-actions">
        <button type="button" class="icon-button app-tooltip-target run-panel-action-button" data-tooltip="重连终端"
          data-tooltip-placement="top" aria-label="重连终端" @click="void handleRestartTerminal()">
          <span aria-hidden="true" class="icon-[lucide--refresh-ccw]" />
        </button>

        <button type="button" class="icon-button app-tooltip-target run-panel-action-button" data-tooltip="清屏"
          data-tooltip-placement="top" aria-label="清屏" :disabled="!isTerminalReady" @click="void handleClearTerminal()">
          <span aria-hidden="true" class="icon-[lucide--eraser]" />
        </button>

        <button type="button" class="icon-button app-tooltip-target run-panel-action-button"
          :data-tooltip="props.isMaximized ? '还原终端高度' : '最大化终端'" data-tooltip-placement="top"
          :aria-label="props.isMaximized ? '还原终端高度' : '最大化终端'" :aria-pressed="props.isMaximized"
          @click="$emit('toggle-maximize')">
          <span v-if="!props.isMaximized" aria-hidden="true" class="icon-[lucide--maximize-2]" />
          <span v-else aria-hidden="true" class="icon-[lucide--minimize-2]" />
        </button>

        <button type="button" class="icon-button app-tooltip-target run-panel-action-button" data-tooltip="关闭终端面板"
          data-tooltip-placement="top" aria-label="关闭终端面板" @click="emit('hide')">
          <span aria-hidden="true" class="icon-[lucide--x]" />
        </button>
      </div>
    </header>

    <div class="run-panel-body">
      <div class="run-panel-view is-terminal">
        <div
          v-for="tab in tabs"
          v-show="tab.sessionId === activeSessionId"
          :key="tab.sessionId"
          class="run-panel-terminal-slot"
        >
          <EmbeddedTerminal
            :session-id="tab.sessionId"
            :visible="props.visible && tab.sessionId === activeSessionId"
            :theme="props.theme"
            :terminal-settings="props.terminalSettings"
            @run-chunk="$emit('terminal-run-chunk', $event)"
            @run-completed="$emit('terminal-run-completed', $event)"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import EmbeddedTerminal from '@/components/workbench/EmbeddedTerminal.vue';
import TerminalTabBar from '@/components/workbench/TerminalTabBar.vue';
import { useMessage } from '@/composables/useMessage';
import { useTerminalTabsStore } from '@/store/terminalTabs';
import { useTerminalRegistryStore } from '@/terminal/registry';
import type { TThemeMode } from '@/types/app';
import type { ITerminalSettings } from '@/types/settings';
import type {
  ITerminalRunChunkPayload,
  ITerminalRunCompletedPayload,
} from '@/types/terminal';
import { toErrorMessage } from '@/utils/error';

const props = defineProps<{
  theme: TThemeMode;
  terminalSettings: ITerminalSettings;
  visible: boolean;
  isMaximized: boolean;
}>();

const emit = defineEmits<{
  hide: [];
  'terminal-run-chunk': [payload: ITerminalRunChunkPayload];
  'terminal-run-completed': [payload: ITerminalRunCompletedPayload];
  'toggle-maximize': [];
}>();

const message = useMessage();
const tabsStore = useTerminalTabsStore();
const { tabs, activeSessionId } = storeToRefs(tabsStore);
const registry = useTerminalRegistryStore();

// 工具栏作用于当前激活会话；状态来自 registry 共享 refs（会话创建前后同源）。
const isTerminalReady = computed(
  () => registry.getStatusRefs(activeSessionId.value).status.value === 'ready',
);

const handleSelectTab = (sessionId: string): void => {
  tabsStore.setActive(sessionId);
};

const handleNewTab = (): void => {
  tabsStore.addTab();
};

const handleCloseTab = (sessionId: string): void => {
  // 先移除 tab（触发 EmbeddedTerminal 卸载 / detach），再彻底销毁后端会话。
  if (!tabsStore.closeTab(sessionId)) return;
  void nextTick().then(() => registry.dispose(sessionId));
  // 关掉最后一个 tab → 整个终端界面关闭（交给父级隐藏面板）。
  if (tabs.value.length === 0) {
    emit('hide');
  }
};

// 终端面板（重新）可见且无任何会话时，补一个首终端，实现“重新启动”。
const ensureTerminalPresence = (): void => {
  if (props.visible && tabs.value.length === 0) {
    tabsStore.ensurePrimaryTab();
  }
};

onMounted(ensureTerminalPresence);
watch(() => props.visible, ensureTerminalPresence);

const runTerminalAction = async (
  task: () => Promise<void>,
  fallbackMessage: string,
): Promise<void> => {
  try {
    await task();
  } catch (error) {
    message.error(toErrorMessage(error, fallbackMessage));
  }
};

const handleRestartTerminal = (): Promise<void> =>
  runTerminalAction(async () => {
    await registry.get(activeSessionId.value)?.retry();
  }, '重连终端失败');

const handleClearTerminal = (): Promise<void> =>
  runTerminalAction(async () => {
    await registry.get(activeSessionId.value)?.clearScreen();
  }, '清屏失败');
</script>

<style scoped>
.run-panel-tabbar {
  flex: 1;
  min-width: 0;
  height: 100%;
}

.run-panel-terminal-slot {
  width: 100%;
  height: 100%;
  min-height: 0;
  flex: 1 1 auto;
}
</style>

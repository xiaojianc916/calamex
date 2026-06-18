<template>
  <div class="terminal-tabbar">
    <div class="terminal-tabbar-list" role="tablist">
      <div
        v-for="(tab, index) in tabs"
        :key="tab.sessionId"
        class="terminal-tab"
        :class="{ 'is-active': tab.sessionId === activeSessionId }"
        role="tab"
        :aria-selected="tab.sessionId === activeSessionId"
        @click="emit('select', tab.sessionId)"
        @mousedown.middle.prevent="emit('close', tab.sessionId)"
      >
        <span
          class="terminal-tab-icon"
          role="button"
          aria-label="关闭终端"
          @click.stop="emit('close', tab.sessionId)"
        >
          <SquareTerminal class="terminal-tab-icon-glyph terminal-tab-icon-default" aria-hidden="true" />
          <X class="terminal-tab-icon-glyph terminal-tab-icon-close" aria-hidden="true" />
        </span>
        <span
          v-if="runningSessionIds.includes(tab.sessionId)"
          class="terminal-tab-running-dot"
          aria-label="运行中"
          title="运行中"
        />
        <span class="terminal-tab-label" v-text="'终端 ' + (index + 1)" />
      </div>
    </div>

    <button
      type="button"
      class="terminal-tabbar-new icon-button run-panel-action-button"
      aria-label="新建终端"
      @click="emit('new')"
    >
      <Plus aria-hidden="true" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { Plus, SquareTerminal, X } from '@lucide/vue';
import type { ITerminalTab } from '@/store/terminalTabs';

defineProps<{
  tabs: ITerminalTab[];
  activeSessionId: string;
  runningSessionIds: string[];
}>();

const emit = defineEmits<{
  select: [sessionId: string];
  close: [sessionId: string];
  new: [];
}>();
</script>

<style scoped>
.terminal-tabbar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  height: 100%;
}

.terminal-tabbar-list {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  flex: 0 1 auto;
  overflow-x: auto;
  scrollbar-width: none;
}

.terminal-tabbar-list::-webkit-scrollbar {
  display: none;
}

.terminal-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  max-width: 200px;
  padding: 0 10px 0 9px;
  border-radius: 6px;
  background: #fafafa;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}

.terminal-tab:hover {
  background: #f4f4f4;
  color: var(--text-primary);
}

.terminal-tab.is-active {
  background: #f4f4f4;
  color: var(--text-primary);
  font-weight: 600;
}

/* 图标槽固定 14×14：默认显示终端图标，悬停整条标签时整体切换为关闭叉叉，二者同尺寸避免宽度抖动 */
.terminal-tab-icon {
  position: relative;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  font-size: 14px;
  cursor: pointer;
}

.terminal-tab-icon-glyph {
  grid-area: 1 / 1;
  display: block;
  width: 14px;
  height: 14px;
  font-size: 14px;
  line-height: 1;
  transition:
    opacity 120ms ease,
    color 120ms ease;
}

.terminal-tab-icon-default {
  opacity: 0.9;
}

.terminal-tab-icon-close {
  opacity: 0;
}

.terminal-tab:hover .terminal-tab-icon-default {
  opacity: 0;
}

.terminal-tab:hover .terminal-tab-icon-close {
  opacity: 1;
}

.terminal-tab-icon:hover .terminal-tab-icon-close {
  color: var(--danger);
}

.terminal-tab-running-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success, #22c55e);
  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.18);
  animation: terminal-tab-running-pulse 1.6s ease-in-out infinite;
}

@keyframes terminal-tab-running-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

.terminal-tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-tabbar-new {
  flex-shrink: 0;
}
</style>

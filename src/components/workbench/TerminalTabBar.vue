<template>
  <div class="terminal-tabbar">
    <div class="terminal-tabbar-list" role="tablist">
      <div
        v-for="tab in tabs"
        :key="tab.sessionId"
        class="terminal-tab"
        :class="{ 'is-active': tab.sessionId === activeSessionId }"
        role="tab"
        :aria-selected="tab.sessionId === activeSessionId"
        @click="emit('select', tab.sessionId)"
        @mousedown.middle.prevent="emit('close', tab.sessionId)"
      >
        <span aria-hidden="true" class="terminal-tab-icon icon-[lucide--square-terminal]" />
        <span class="terminal-tab-label" v-text="tab.title" />
        <span
          class="terminal-tab-close"
          role="button"
          aria-label="关闭终端"
          @click.stop="emit('close', tab.sessionId)"
        >
          <span aria-hidden="true" class="icon-[lucide--x]" />
        </span>
      </div>
    </div>

    <button
      type="button"
      class="terminal-tabbar-new icon-button"
      aria-label="新建终端"
      @click="emit('new')"
    >
      <span aria-hidden="true" class="icon-[lucide--plus]" />
    </button>
  </div>
</template>

<script setup lang="ts">
import type { ITerminalTab } from '@/store/terminalTabs';

defineProps<{
  tabs: ITerminalTab[];
  activeSessionId: string;
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
  padding: 0 6px 0 9px;
  border-radius: 6px;
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
  background: color-mix(in srgb, var(--surface-hover) 100%, transparent);
  color: var(--text-primary);
}

.terminal-tab.is-active {
  background: color-mix(in srgb, var(--accent-strong) 14%, transparent);
  color: var(--text-primary);
  font-weight: 600;
}

.terminal-tab-icon {
  flex-shrink: 0;
  font-size: 14px;
  opacity: 0.9;
}

.terminal-tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-tab-close {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-tertiary);
  opacity: 0;
  flex-shrink: 0;
  transition:
    opacity 120ms ease,
    background-color 120ms ease,
    color 120ms ease;
}

.terminal-tab:hover .terminal-tab-close,
.terminal-tab.is-active .terminal-tab-close {
  opacity: 1;
}

.terminal-tab-close:hover {
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
}

.terminal-tabbar-new {
  flex-shrink: 0;
}
</style>

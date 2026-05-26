<script setup lang="ts">
import { computed } from 'vue';
import type { LspStatus } from '@/composables/useLsp';

const props = defineProps<{
  status: LspStatus;
  serverName: string;
  error: string | null;
  isRunning: boolean;
  isStarting: boolean;
  hasError: boolean;
}>();

const emit = defineEmits<{
  restart: [];
}>();

const statusLabel = computed<string>(() => {
  switch (props.status) {
    case 'idle':
      return '待启动';
    case 'starting':
      return '启动中…';
    case 'running':
      return '运行中';
    case 'stopped':
      return '已停止';
    case 'error':
      return '异常';
  }
});

const statusDotClass = computed<string>(() => {
  switch (props.status) {
    case 'idle':
      return 'lsp-status-bar__dot--idle';
    case 'starting':
      return 'lsp-status-bar__dot--starting';
    case 'running':
      return 'lsp-status-bar__dot--running';
    case 'stopped':
      return 'lsp-status-bar__dot--stopped';
    case 'error':
      return 'lsp-status-bar__dot--error';
  }
});

const tooltip = computed<string>(() => {
  const base = `${props.serverName} · ${statusLabel.value}`;
  if (props.hasError && props.error) {
    return `${base}\n${props.error}`;
  }
  if (props.status === 'idle') {
    return `${base}\n打开工作区后自动启动`;
  }
  if (props.status === 'stopped') {
    return `${base}\n点击重新启动`;
  }
  return base;
});
</script>

<template>
  <div
    class="lsp-status-bar"
    :class="{ 'lsp-status-bar--interactive': status === 'stopped' || hasError }"
    :title="tooltip"
    role="status"
    :aria-label="tooltip"
    @click="status === 'stopped' || hasError ? emit('restart') : undefined"
  >
    <span class="lsp-status-bar__dot" :class="statusDotClass" aria-hidden="true" />
    <span class="lsp-status-bar__server">{{ serverName }}</span>
    <span class="lsp-status-bar__separator" aria-hidden="true">·</span>
    <span class="lsp-status-bar__label">{{ statusLabel }}</span>
    <span
      v-if="hasError"
      class="lsp-status-bar__error-icon"
      aria-hidden="true"
    >⚠</span>
  </div>
</template>

<style scoped>
.lsp-status-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 12px;
  flex: none;
  border-top: 1px solid color-mix(in srgb, var(--shell-divider) 58%, transparent);
  background: color-mix(in srgb, var(--app-bg) 100%, transparent);
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1;
  user-select: none;
  transition: background-color 120ms ease;
}

.lsp-status-bar--interactive {
  cursor: pointer;
}

.lsp-status-bar--interactive:hover {
  background: color-mix(in srgb, var(--surface-soft) 100%, transparent);
  color: var(--text-primary);
}

/* ── Dot ──────────────────────────────────────────────── */
.lsp-status-bar__dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex: none;
  background: var(--text-quaternary);
  transition: background-color 200ms ease;
}

.lsp-status-bar__dot--idle {
  background: var(--text-quaternary);
}

.lsp-status-bar__dot--starting {
  background: color-mix(in srgb, var(--warning) 88%, white);
  animation: lsp-dot-pulse 900ms ease-in-out infinite;
}

.lsp-status-bar__dot--running {
  background: color-mix(in srgb, var(--success) 88%, white);
}

.lsp-status-bar__dot--stopped {
  background: color-mix(in srgb, var(--warning) 72%, black);
}

.lsp-status-bar__dot--error {
  background: color-mix(in srgb, var(--danger) 88%, white);
}

@keyframes lsp-dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* ── Typography ────────────────────────────────────────── */
.lsp-status-bar__server {
  color: var(--text-secondary);
}

.lsp-status-bar__separator {
  color: var(--text-quaternary);
}

.lsp-status-bar__label {
  font-variant-numeric: tabular-nums;
}

.lsp-status-bar__error-icon {
  margin-left: 2px;
  font-size: 10px;
  color: color-mix(in srgb, var(--danger) 88%, white);
}
</style>

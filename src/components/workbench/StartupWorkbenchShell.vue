<script setup lang="ts">
import { computed } from 'vue';
import { Skeleton } from '@/components/ui/skeleton';
import type { TStartupShellState } from '@/types/startup-shell';

const props = withDefaults(
  defineProps<{
    state: TStartupShellState;
    showTerminal?: boolean;
    terminalHeight?: number;
  }>(),
  {
    showTerminal: false,
    terminalHeight: 236,
  },
);

// 真实编辑器内容区只有 CodeMirror 代码面（无标签栏 / 无面包屑 / 无右上操作点，
// 窗口按钮在 AppShellLayout 标题栏）。这里仅保留与真实形态一致的部分：
// 依据上次会话激活文件类型决定展示代码骨架或图片骨架，避免骨架→真实切换时跳变。
const activeTab = computed(
  () => props.state.openTabs.find((item) => item.isActive) ?? props.state.openTabs[0] ?? null,
);

const terminalPanelStyle = computed(() => ({
  height: `${Math.max(140, Math.round(props.terminalHeight))}px`,
}));

const editorLineWidths = ['62%', '46%', '72%', '38%', '66%', '54%', '78%', '42%'] as const;
</script>

<template>
  <section class="startup-workbench-shell" aria-hidden="true">
    <div class="startup-workbench-shell__body" :class="{ 'has-terminal': showTerminal }">
      <div class="startup-workbench-shell__editor">
        <template v-if="activeTab?.kind === 'image'">
          <div class="startup-workbench-shell__image-stage">
            <Skeleton class="startup-workbench-shell__image-frame" />
            <Skeleton class="startup-workbench-shell__image-caption" />
          </div>
        </template>

        <template v-else>
          <div class="startup-workbench-shell__gutter">
            <span v-for="line in editorLineWidths.length" :key="line" v-text="line"></span>
          </div>
          <div class="startup-workbench-shell__code">
            <Skeleton
              v-for="(width, index) in editorLineWidths"
              :key="index"
              class="startup-workbench-shell__code-line"
              :style="{ width }"
            />
          </div>
        </template>
      </div>

      <section v-if="showTerminal" class="startup-workbench-shell__terminal" :style="terminalPanelStyle">
        <div class="startup-workbench-shell__terminal-header">
          <Skeleton class="startup-workbench-shell__terminal-title" />
          <Skeleton class="startup-workbench-shell__terminal-chip" />
        </div>
        <div class="startup-workbench-shell__terminal-body">
          <Skeleton class="startup-workbench-shell__terminal-prompt" />
          <Skeleton class="startup-workbench-shell__terminal-line is-wide" />
          <Skeleton class="startup-workbench-shell__terminal-line" />
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.startup-workbench-shell {
  display: flex;
  height: 100%;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  background: var(--editor-bg);
}

.startup-workbench-shell__body {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.startup-workbench-shell__editor {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: 52px minmax(0, 1fr);
  overflow: hidden;
  background: var(--editor-bg);
}

.startup-workbench-shell__gutter {
  display: grid;
  align-content: start;
  gap: 14px;
  border-right: 1px solid color-mix(in srgb, var(--shell-divider) 48%, transparent);
  padding: 18px 12px 0 0;
  color: color-mix(in srgb, var(--text-quaternary) 78%, transparent);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  text-align: right;
}

.startup-workbench-shell__code {
  display: grid;
  align-content: start;
  gap: 15px;
  padding: 18px 22px;
}

.startup-workbench-shell__code-line {
  height: 10px;
  border-radius: 999px;
}

.startup-workbench-shell__image-stage {
  grid-column: 1 / -1;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 14px;
  min-height: 0;
  padding: 24px;
}

.startup-workbench-shell__image-frame {
  width: min(72%, 520px);
  aspect-ratio: 16 / 10;
  border-radius: 8px;
}

.startup-workbench-shell__image-caption {
  width: min(42%, 280px);
  height: 10px;
  border-radius: 999px;
}

.startup-workbench-shell__terminal {
  flex: 0 0 auto;
  min-height: 140px;
  overflow: hidden;
  border-top: 1px solid var(--shell-divider);
  background: var(--panel-bg);
}

.startup-workbench-shell__terminal-header {
  display: flex;
  height: 36px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid color-mix(in srgb, var(--shell-divider) 70%, transparent);
  padding: 0 14px;
}

.startup-workbench-shell__terminal-title {
  width: 128px;
  height: 10px;
  border-radius: 999px;
}

.startup-workbench-shell__terminal-chip {
  width: 72px;
  height: 20px;
  border-radius: 999px;
}

.startup-workbench-shell__terminal-body {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 12px;
  padding: 16px 18px;
}

.startup-workbench-shell__terminal-prompt {
  width: 12px;
  height: 12px;
  border-radius: 999px;
}

.startup-workbench-shell__terminal-line {
  grid-column: 2;
  width: 48%;
  height: 10px;
  border-radius: 999px;
}

.startup-workbench-shell__terminal-line.is-wide {
  width: 76%;
}

@media (max-width: 720px) {
  .startup-workbench-shell__editor {
    grid-template-columns: 42px minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .startup-workbench-shell :deep(.animate-pulse) {
    animation: none;
  }
}
</style>

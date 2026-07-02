<script setup lang="ts">
// AI 面板外壳：头部 provider 标记 + 操作按钮 + 内容区 + 底部 composer 的通用结构与尺寸，
// 供 AiAssistantPanel 复用。刻意保持轻量、不依赖任何 AI 子系统（useAiAssistant / CopilotKit 等），
// 会话线程、建议气泡、输入框等重内核全部通过插槽注入。
withDefaults(
  defineProps<{
    /** 装饰性（骨架）用途时设为 true：对辅助技术隐藏，不暴露 aria-label。 */
    decorative?: boolean;
    ariaLabel?: string;
  }>(),
  {
    decorative: false,
    ariaLabel: 'AI 助手面板',
  },
);
</script>

<template>
  <section
    class="ai-panel-frame"
    :aria-label="decorative ? undefined : ariaLabel"
    :aria-hidden="decorative ? 'true' : undefined"
  >
    <header class="ai-panel-frame__header">
      <div class="ai-panel-frame__mark">
        <slot name="mark" />
      </div>
      <div class="ai-panel-frame__actions">
        <slot name="actions" />
      </div>
    </header>

    <div class="ai-panel-frame__body">
      <slot name="body" />
    </div>

    <div class="ai-panel-frame__composer">
      <slot name="composer" />
    </div>
  </section>
</template>

<style scoped>
.ai-panel-frame {
  display: flex;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow-x: hidden;
  background: var(--ai-panel-frame-bg, var(--sidebar-bg));
  color: var(--text-primary);
}

.ai-panel-frame__header {
  position: relative;
  z-index: 3;
  display: flex;
  flex: 0 0 auto;
  min-width: 0;
  min-height: 52px;
  align-items: center;
  gap: 8px;
  overflow: visible;
  padding: 12px 18px 10px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.ai-panel-frame__mark {
  display: inline-flex;
  min-width: 0;
  max-width: min(48%, 320px);
  flex: 0 1 auto;
  align-items: center;
  gap: 10px;
  overflow: hidden;
  color: var(--text-primary);
}

.ai-panel-frame__actions {
  display: inline-flex;
  min-width: 0;
  height: 30px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-left: auto;
  overflow: visible;
}

.ai-panel-frame__body {
  display: flex;
  min-height: 0;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.ai-panel-frame__composer {
  position: relative;
  z-index: 1;
  min-width: 0;
  flex: 0 0 auto;
}

:global(html.is-resizing) .ai-panel-frame__header,
:global(html.is-resizing) .ai-panel-frame__mark,
:global(html.is-resizing) .ai-panel-frame__actions {
  animation: none !important;
  transition: none !important;
}
</style>

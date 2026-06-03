<script setup lang="ts">
// AI 主界面启动骨架屏。
// 背景：默认启动模式为 AI，而原 StartupWorkbenchShell 是编辑器形态(标签栏 + 代码行)，
// 且被放在编辑器 Card(v-show="!isAiMode") 内，导致 AI 模式启动时没有骨架、只剩空白帧，
// 直到异步的 AiWorkspaceSurface 挂载完成。此组件提供 AI 对话形态的骨架，消除该空白。
import { Skeleton } from '@/components/ui/skeleton';
</script>

<template>
  <section class="startup-ai-shell" aria-hidden="true">
    <header class="startup-ai-shell__header">
      <Skeleton class="startup-ai-shell__avatar" />
      <div class="startup-ai-shell__heading">
        <Skeleton class="startup-ai-shell__title" />
        <Skeleton class="startup-ai-shell__subtitle" />
      </div>
    </header>

    <div class="startup-ai-shell__conversation">
      <div class="startup-ai-shell__message is-assistant">
        <Skeleton class="startup-ai-shell__line is-w70" />
        <Skeleton class="startup-ai-shell__line is-w90" />
        <Skeleton class="startup-ai-shell__line is-w55" />
      </div>

      <div class="startup-ai-shell__message is-user">
        <Skeleton class="startup-ai-shell__line is-w60" />
        <Skeleton class="startup-ai-shell__line is-w40" />
      </div>

      <div class="startup-ai-shell__message is-assistant">
        <Skeleton class="startup-ai-shell__line is-w80" />
        <Skeleton class="startup-ai-shell__line is-w65" />
        <Skeleton class="startup-ai-shell__line is-w45" />
      </div>
    </div>

    <div class="startup-ai-shell__composer">
      <Skeleton class="startup-ai-shell__input" />
      <Skeleton class="startup-ai-shell__send" />
    </div>
  </section>
</template>

<style scoped>
.startup-ai-shell {
  display: flex;
  height: 100%;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 16px;
  overflow: hidden;
  padding: 18px 20px 16px;
  background: var(--workbench-content-bg);
}

.startup-ai-shell__header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 12px;
}

.startup-ai-shell__avatar {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: 10px;
}

.startup-ai-shell__heading {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 8px;
}

.startup-ai-shell__title {
  width: min(60%, 200px);
  height: 12px;
  border-radius: 999px;
}

.startup-ai-shell__subtitle {
  width: min(40%, 140px);
  height: 9px;
  border-radius: 999px;
}

.startup-ai-shell__conversation {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 18px;
  overflow: hidden;
  padding: 4px 0;
}

.startup-ai-shell__message {
  display: grid;
  gap: 10px;
  max-width: min(560px, 82%);
  padding: 14px 16px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 60%, transparent);
  border-radius: 14px;
}

.startup-ai-shell__message.is-assistant {
  align-self: flex-start;
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
}

.startup-ai-shell__message.is-user {
  align-self: flex-end;
  background: color-mix(in srgb, var(--accent-strong) 8%, transparent);
}

.startup-ai-shell__line {
  height: 10px;
  border-radius: 999px;
}

.startup-ai-shell__line.is-w40 {
  width: 40%;
}

.startup-ai-shell__line.is-w45 {
  width: 45%;
}

.startup-ai-shell__line.is-w55 {
  width: 55%;
}

.startup-ai-shell__line.is-w60 {
  width: 60%;
}

.startup-ai-shell__line.is-w65 {
  width: 65%;
}

.startup-ai-shell__line.is-w70 {
  width: 70%;
}

.startup-ai-shell__line.is-w80 {
  width: 80%;
}

.startup-ai-shell__line.is-w90 {
  width: 90%;
}

.startup-ai-shell__composer {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 12px;
  padding-top: 4px;
}

.startup-ai-shell__input {
  height: 52px;
  flex: 1;
  border-radius: 14px;
}

.startup-ai-shell__send {
  width: 52px;
  height: 52px;
  flex-shrink: 0;
  border-radius: 14px;
}

@media (prefers-reduced-motion: reduce) {
  .startup-ai-shell :deep(.animate-pulse) {
    animation: none;
  }
}
</style>

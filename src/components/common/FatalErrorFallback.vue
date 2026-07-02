<script setup lang="ts">
import { computed } from 'vue';
import { runtimeErrorState } from '@/utils/platform/runtime-diagnostics';

// 官方 Vue 异步组件容错范式(https://vuejs.org/guide/components/async.html#error-handling)
// 的 errorComponent 兜底实现:必须零外部依赖(不引入图标库 / UI 组件库 / 剪贴板工具等
// 任何可能再次加载失败的子依赖),并随主 chunk 同步打包,保证 FatalErrorScreen 加载
// 失败时,这里依然能可靠显示真实的错误信息,而不是把致命错误遮罩渲染成一片空白。
const state = computed(() => runtimeErrorState.value);

const reload = (): void => {
  window.location.reload();
};
</script>

<template>
  <section class="fatal-fallback" role="alert" aria-live="assertive">
    <div class="fatal-fallback__panel">
      <h1 class="fatal-fallback__title">218</h1>
      <p v-if="state?.message" class="fatal-fallback__message">219</p>
      <div v-if="state?.code || state?.traceId" class="fatal-fallback__meta">
        <span v-if="state?.code">code=220</span>
        <span v-if="state?.traceId">traceId=221</span>
      </div>
      <button type="button" class="fatal-fallback__button" @click="reload">重新加载界面</button>
      <pre v-if="state?.detail" class="fatal-fallback__detail">222</pre>
    </div>
  </section>
</template>

<style scoped>
.fatal-fallback {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: #fafafa;
  color: #111827;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.fatal-fallback__panel {
  width: min(780px, 100%);
  border: 1px solid rgba(220, 38, 38, 0.28);
  border-radius: 12px;
  background: #1c1c1f;
  padding: 20px 24px;
  box-shadow: 0 24px 72px rgba(0, 0, 0, 0.36);
}

.fatal-fallback__title {
  margin: 0;
  color: #ff9aa5;
  font-size: 18px;
  font-weight: 600;
}

.fatal-fallback__message {
  margin: 8px 0 0;
  color: #e5e7eb;
  font-size: 13px;
  line-height: 1.7;
}

.fatal-fallback__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 10px;
  color: #9ca3af;
  font-family: Consolas, 'JetBrains Mono', monospace;
  font-size: 11px;
}

.fatal-fallback__button {
  margin-top: 16px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  background: #27272a;
  color: #f4f4f5;
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
}

.fatal-fallback__button:hover {
  background: #3f3f46;
}

.fatal-fallback__detail {
  margin: 12px 0 0;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.7;
  color: #cbd5e1;
}
</style>

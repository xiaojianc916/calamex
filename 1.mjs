// fix-fatal-error-foundation.mjs
// 按 Vue 官方 async component 容错范式重构"致命错误遮罩"地基。
// 用法: node fix-fatal-error-foundation.mjs [--apply]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const APPLY = process.argv.includes('--apply');

const readText = (p) => {
  const raw = readFileSync(p, 'utf8');
  return { nl: raw.includes('\r\n') ? '\r\n' : '\n', text: raw.replace(/\r\n/g, '\n') };
};
const toEol = (text, nl) => (nl === '\r\n' ? text.replace(/\n/g, '\r\n') : text);

const countOccurrences = (text, needle) => text.split(needle).length - 1;

function patchFile(path, oldStr, newStr, label) {
  const { nl, text } = readText(path);
  if (text.includes(newStr)) {
    console.log(`[skip] ${label}: 已是目标状态`);
    return;
  }
  const count = countOccurrences(text, oldStr);
  if (count !== 1) {
    throw new Error(`[anchor 失败] ${label}: 期望命中 1 处,实际命中 ${count} 处,请先人工核对文件是否已变化。`);
  }
  const patched = text.replace(oldStr, newStr);
  console.log(`[will patch] ${label}`);
  if (APPLY) {
    writeFileSync(path, toEol(patched, nl), 'utf8');
    console.log(`  -> 已写入 ${path}`);
  }
}

function createFileIfMissing(path, content, label) {
  if (existsSync(path)) {
    console.log(`[skip] ${label}: 文件已存在`);
    return;
  }
  console.log(`[will create] ${label} -> ${path}`);
  if (APPLY) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    console.log(`  -> 已创建 ${path}`);
  }
}

// ---------------------------------------------------------------------------
// 1) 新建零依赖兜底组件 FatalErrorFallback.vue
// ---------------------------------------------------------------------------
const fallbackPath = 'src/components/common/FatalErrorFallback.vue';
const fallbackContent = `<script setup lang="ts">
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
`;

createFileIfMissing(fallbackPath, fallbackContent, 'FatalErrorFallback.vue(零依赖兜底组件)');

// ---------------------------------------------------------------------------
// 2) App.vue: 静态引入兜底组件 + defineAsyncComponent 补齐官方容错选项
// ---------------------------------------------------------------------------
const appVuePath = 'src/app/App.vue';

patchFile(
  appVuePath,
  `import BrowserContextMenuHost from '@/components/common/BrowserContextMenuHost.vue';\nimport { Toaster } from '@/components/ui/sonner';`,
  `import BrowserContextMenuHost from '@/components/common/BrowserContextMenuHost.vue';\nimport FatalErrorFallback from '@/components/common/FatalErrorFallback.vue';\nimport { Toaster } from '@/components/ui/sonner';`,
  'App.vue: 引入 FatalErrorFallback',
);

patchFile(
  appVuePath,
  `// 致命错误界面受 runtimeErrorState 控制,仅在出错时挂载;异步加载让它(及其 lucide\n// 图标、ErrorDetails、Button 等依赖)退出首屏 chunk。出错本就罕见,异步加载的延迟可接受。\nconst FatalErrorScreen = defineAsyncComponent(\n  () => import('@/components/common/FatalErrorScreen.vue'),\n);`,
  `// 致命错误界面受 runtimeErrorState 控制,仅在出错时挂载;异步加载让它(及其 lucide\n// 图标、ErrorDetails、Button 等依赖)退出首屏 chunk。出错本就罕见,异步加载的延迟可接受。\n//\n// 官方 Vue 异步组件容错范式(https://vuejs.org/guide/components/async.html#error-handling):\n// 必须显式提供 errorComponent + onError,否则 loader 失败时组件渲染为空节点——遮罩仍会\n// 挂出(z-index 铺满整个窗口),里面却什么都不显示,表现为"整个工作台/编辑器突然完全\n// 空白"且用户和控制台都拿不到任何错误信息。errorComponent 用零外部依赖、随主 chunk\n// 同步打包的 FatalErrorFallback,保证它不会重蹈同样的加载失败。\nconst FatalErrorScreen = defineAsyncComponent({\n  loader: () => import('@/components/common/FatalErrorScreen.vue'),\n  errorComponent: FatalErrorFallback,\n  timeout: 8000,\n  onError(error, retry, fail, attempts) {\n    console.error(\n      \`[App] FatalErrorScreen chunk 加载失败(第 \${attempts} 次),降级为内置最小错误界面\`,\n      error,\n    );\n    if (attempts <= 2) {\n      retry();\n      return;\n    }\n    fail();\n  },\n});`,
  'App.vue: defineAsyncComponent 补齐 errorComponent/onError/timeout',
);

// ---------------------------------------------------------------------------
// 3) runtime-diagnostics.ts: 生产环境也必须打印报错源头
// ---------------------------------------------------------------------------
const diagPath = 'src/utils/platform/runtime-diagnostics.ts';

patchFile(
  diagPath,
  `  // [round3] DEV guard: skip console.trace in production to avoid main-thread pressure\n  if (import.meta.env.DEV) {\n    console.error(\n      \`[runtime-diagnostics] setRuntimeError 被调用 → 即将置 runtimeErrorState。title=\${title}\`,\n      error,\n    );\n    // eslint-disable-next-line no-console\n    console.trace('[runtime-diagnostics] setRuntimeError 调用栈(谁升级了致命错误界面)');\n  }`,
  `  // 生产环境也必须打印:这是唯一能定位"是谁把应用推进致命错误界面"的诊断信息。\n  // 之前把它整体锁进 DEV guard,导致 release 包里即使修好 F12、打开控制台也看不到\n  // 真正的报错源头。console.trace 的堆栈捕获开销更大,继续只在 DEV 下附加打印;\n  // error 对象与 title 无论生产/开发都必须留痕,否则等价于对用户隐藏了真相。\n  console.error(\n    \`[runtime-diagnostics] setRuntimeError 被调用 → 即将置 runtimeErrorState。title=\${title}\`,\n    error,\n  );\n  if (import.meta.env.DEV) {\n    // eslint-disable-next-line no-console\n    console.trace('[runtime-diagnostics] setRuntimeError 调用栈(谁升级了致命错误界面)');\n  }`,
  'runtime-diagnostics.ts: setRuntimeError 生产环境留痕',
);

console.log(APPLY ? '\n完成。' : '\n以上为预览,加 --apply 才会真正写入文件。');
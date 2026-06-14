import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [
    vue(),
    tailwindcss(),
    visualizer({
      filename: 'dist/stats.html',
      template: 'treemap', // 还可选 'sunburst' / 'network'
      gzipSize: true,
      brotliSize: true,
      open: false,
    }),
  ],
  clearScreen: false,
  // shfmt 在 module worker(new Worker(url, { type: 'module' }))里加载 WASM 版 @wasm-fmt/shfmt。
  // Vite 默认把 worker 产物打成 'iife'：dev 用浏览器原生 ESM worker 正常，但打包后 iife 产物
  // 无法承载该 ESM-only 的 WASM 包，worker 加载即触发 'error' → 主线程永久回退 → 每次保存同步跑
  // WASM 冻结渲染线程 → WebView 合成出纯白窗口底色(整屏白屏)。显式指定 'es' 让 worker 以
  // ES module 形式打包，使其在打包后的应用里也能正确离线加载，从而真正在 worker 线程执行。
  worker: {
    format: 'es',
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Cargo workspace 把编译产物放在仓库根目录的 target/(不是 src-tauri/target/)。
      // Vite 不能监听这里：Windows 上被锁住的 calamex.exe 会触发 EBUSY 并使 dev server 崩溃。
      ignored: ['**/target/**', '**/src-tauri/**'],
    },
  },
  preview: {
    port: 1421,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
    // 关闭每次构建对全部产物的 gzip/brotli 体积计算(开销随产物数线性增长);
    // 压缩体积数据仍由 visualizer 按需产出在 dist/stats.html。
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
      },
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/');

          // ── 核心框架 ───────────────────────────────────
          if (
            normalizedId.includes('/node_modules/vue/') ||
            normalizedId.includes('/node_modules/vue-router/') ||
            normalizedId.includes('/node_modules/pinia/')
          ) {
            return 'vendor-core';
          }

          // ── 编辑器内核(CodeMirror / Lezer)───────────────
          if (
            normalizedId.includes('/node_modules/@codemirror/') ||
            normalizedId.includes('/node_modules/@lezer/') ||
            normalizedId.includes('/node_modules/codemirror/')
          ) {
            return 'vendor-codemirror';
          }

          // ── 语法高亮(Shiki)───────────────────────
          // 只收核心(core/engine/wasm)与主题进 vendor-shiki；放行 @shikijs/langs。
          // langs 走 shiki-shared.ts 里逐语言动态 import('@shikijs/langs/<lang>')，
          // 让每种语言由 Rollup 自然产出独立小 chunk，按需下载——否则 32 种语言的
          // TextMate 语法 JSON 会被合并进单个 vendor-shiki(~3.9MB)，首次高亮 bash
          // 也要整块下载解析。
          if (
            normalizedId.includes('/node_modules/shiki/core') ||
            normalizedId.includes('/node_modules/shiki/engine') ||
            normalizedId.includes('/node_modules/shiki/wasm') ||
            normalizedId.includes('/node_modules/@shikijs/themes/')
          ) {
            return 'vendor-shiki';
          }

          // ── zod(契约校验)──────────────────────
          // zod 是首屏核心路径(tauri.contracts / store / IPC 工厂都用),但 @copilotkit
          // 也引用它,默认会被 Rollup 合进最大消费者 vendor-ai(2MB),导致首屏把整个
          // CopilotKit 也拽进来。这里单独拆出,既避免重复,也让 vendor-ai 退出首屏。
          if (normalizedId.includes('/node_modules/zod/')) {
            return 'vendor-zod';
          }

          // ── AI 运行时(CopilotKit / ai SDK)───────────────
          if (
            normalizedId.includes('/node_modules/@copilotkit/') ||
            normalizedId.includes('/node_modules/ai/')
          ) {
            return 'vendor-ai';
          }

          // ── Markdown / 数学公式渲染 ───────────────────
          if (
            normalizedId.includes('/node_modules/markstream-vue/') ||
            normalizedId.includes('/node_modules/katex/')
          ) {
            return 'vendor-markdown';
          }

          // ── UI 基础库 ─────────────────────────────
          if (
            normalizedId.includes('/node_modules/reka-ui/') ||
            normalizedId.includes('/node_modules/motion-v/') ||
            normalizedId.includes('/node_modules/photoswipe/') ||
            normalizedId.includes('/node_modules/@lucide/')
          ) {
            return 'vendor-ui';
          }

          // ── xterm ───────────────────────────────
          if (normalizedId.includes('/node_modules/@xterm/')) {
            return 'vendor-xterm';
          }

          // ── shell 分析 ──────────────────────────
          if (
            normalizedId.includes('/node_modules/web-tree-sitter/') ||
            normalizedId.includes('/node_modules/tree-sitter-bash/') ||
            normalizedId.includes('/node_modules/@wasm-fmt/shfmt/') ||
            normalizedId.includes('/src/utils/shell-completion.ts') ||
            normalizedId.includes('/src/constants/shell/command-catalog.ts') ||
            normalizedId.includes('/src/generated/fig-shell-command-catalog.ts') ||
            normalizedId.includes('/src/utils/shfmt.ts')
          ) {
            return 'vendor-shell-analysis';
          }
        },
      },
    },
  },
}));

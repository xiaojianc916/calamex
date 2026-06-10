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
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Cargo workspace 把编译产物放在仓库根目录的 target/（不是 src-tauri/target/）。
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

          // ── 编辑器内核（CodeMirror / Lezer）───────────────
          if (
            normalizedId.includes('/node_modules/@codemirror/') ||
            normalizedId.includes('/node_modules/@lezer/') ||
            normalizedId.includes('/node_modules/codemirror/')
          ) {
            return 'vendor-codemirror';
          }

          // ── 语法高亮（Shiki）───────────────────────
          if (
            normalizedId.includes('/node_modules/shiki/') ||
            normalizedId.includes('/node_modules/@shikijs/')
          ) {
            return 'vendor-shiki';
          }

          // ── AI 运行时（CopilotKit / ai SDK）───────────────
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

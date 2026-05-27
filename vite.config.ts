import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { visualizer } from 'rollup-plugin-visualizer'
import Icons from 'unplugin-icons/vite'
import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [
    vue(),
    tailwindcss(),
    Icons({
      compiler: 'vue3',
      autoInstall: true,
      // 让 Tailwind 的 size-* / text-* class 完全接管,不强加默认样式
      defaultStyle: '',
      defaultClass: '',
    }),
    visualizer({
      filename: 'dist/stats.html',
      template: 'treemap',   // 还可选 'sunburst' / 'network'
      gzipSize: true,
      brotliSize: true,
      open: true,
    }),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
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
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
      },
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/')

          // ── unplugin-icons: 把所有 ~icons/* 虚拟模块归到一个 chunk ─────────────
          // 虚拟 id 在 Rollup 这边通常带 \0 前缀或包含 "~icons/"
          if (
            normalizedId.includes('~icons/') ||
            normalizedId.includes('virtual:icons') ||
            normalizedId.includes('unplugin-icons')
          ) {
            return 'vendor-icons'
          }

          // ── 核心框架 ────────────────────────────────────────────────────
          if (
            normalizedId.includes('/node_modules/vue/') ||
            normalizedId.includes('/node_modules/vue-router/') ||
            normalizedId.includes('/node_modules/pinia/')
          ) {
            return 'vendor-core'
          }

          // ── Monaco ─────────────────────────────────────────────────────
          if (normalizedId.includes('/node_modules/monaco-editor/')) {
            const monacoPath =
              normalizedId.split('/node_modules/monaco-editor/esm/')[1] ?? ''
            const monacoContribMatch = monacoPath.match(/^vs\/editor\/contrib\/([^/]+)/)
            const monacoBaseMatch = monacoPath.match(/^vs\/base\/([^/]+)/)
            const monacoStandaloneMatch = monacoPath.match(/^vs\/editor\/standalone\/([^/]+)/)
            const monacoPlatformMatch = monacoPath.match(/^vs\/platform\/([^/]+)/)
            const monacoEditorBrowserMatch = monacoPath.match(/^vs\/editor\/browser\/([^/]+)/)
            const monacoEditorCommonMatch = monacoPath.match(/^vs\/editor\/common\/([^/]+)/)

            if (monacoContribMatch) return `monaco-contrib-${monacoContribMatch[1]}`
            if (monacoBaseMatch) return `monaco-base-${monacoBaseMatch[1]}`
            if (
              normalizedId.includes('/monaco-editor/esm/vs/editor/contrib/') ||
              normalizedId.includes('/monaco-editor/esm/vs/editor/standalone/browser/quickAccess/')
            ) {
              return 'monaco-quickaccess'
            }
            if (
              normalizedId.includes('/monaco-editor/esm/vs/basic-languages/') ||
              normalizedId.includes('/monaco-editor/esm/vs/language/')
            ) {
              return 'monaco-language'
            }
            if (monacoStandaloneMatch) return 'monaco-standalone'
            if (monacoPlatformMatch) return 'monaco-platform'
            if (monacoEditorBrowserMatch) return 'monaco-editor-browser'
            if (monacoEditorCommonMatch) return 'monaco-editor-common'
            return 'monaco-core'
          }

          // ── xterm ──────────────────────────────────────────────────────
          if (normalizedId.includes('/node_modules/@xterm/')) {
            return 'vendor-xterm'
          }

          // ── shell 分析 ─────────────────────────────────────────────────
          if (
            normalizedId.includes('/node_modules/web-tree-sitter/') ||
            normalizedId.includes('/node_modules/tree-sitter-bash/') ||
            normalizedId.includes('/node_modules/@wasm-fmt/shfmt/') ||
            normalizedId.includes('/src/utils/shell-completion.ts') ||
            normalizedId.includes('/src/constants/shell/command-catalog.ts') ||
            normalizedId.includes('/src/generated/fig-shell-command-catalog.ts') ||
            normalizedId.includes('/src/utils/shfmt.ts')
          ) {
            return 'vendor-shell-analysis'
          }
        },
      },
    },
  },
}))

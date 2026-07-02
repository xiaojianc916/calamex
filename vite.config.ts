import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';

/**
 * manualChunks 匹配规则表：chunk 名 → 匹配路径片段数组。
 * id 与每条 pattern 做 includes 匹配，命中第一条即返回。
 * 维护时只需增删数组条目，不再逐个写 if-includes 链。
 */
const CHUNK_RULES: ReadonlyArray<{ name: string; patterns: string[] }> = [
  {
    name: 'vendor-core',
    patterns: ['/node_modules/vue/', '/node_modules/vue-router/', '/node_modules/pinia/'],
  },
  {
    name: 'vendor-codemirror',
    patterns: ['/node_modules/@codemirror/', '/node_modules/@lezer/', '/node_modules/codemirror/'],
  },
  // 只收核心(core/engine/wasm)与主题进 vendor-shiki；放行 @shikijs/langs。
  // langs 走 shiki-shared.ts 里逐语言动态 import('@shikijs/langs/<lang>')，
  // 让每种语言由 Rollup 自然产出独立小 chunk，按需下载——否则 32 种语言的
  // TextMate 语法 JSON 会被合并进单个 vendor-shiki(~3.9MB)，首次高亮 bash
  // 也要整块下载解析。
  {
    name: 'vendor-shiki',
    patterns: [
      '/node_modules/shiki/core',
      '/node_modules/shiki/engine',
      '/node_modules/shiki/wasm',
      '/node_modules/@shikijs/themes/',
    ],
  },
  // zod 是首屏核心路径(tauri.contracts / store / IPC 工厂都用),但 @copilotkit
  // 也引用它,默认会被 Rollup 合进最大消费者 vendor-ai(2MB),导致首屏把整个
  // CopilotKit 也拽进来。这里单独拆出,既避免重复,也让 vendor-ai 退出首屏。
  {
    name: 'vendor-zod',
    patterns: ['/node_modules/zod/'],
  },
  {
    name: 'vendor-ai',
    patterns: ['/node_modules/ai/'],
  },
  {
    name: 'vendor-markdown',
    patterns: ['/node_modules/markstream-vue/', '/node_modules/katex/'],
  },
  // 首帧关键：ShellWorkbenchView 静态 import reka-ui Resizable、侧栏静态用 @lucide 图标。
  {
    name: 'vendor-reka',
    patterns: ['/node_modules/reka-ui/'],
  },
  {
    name: 'vendor-icons',
    patterns: ['/node_modules/@lucide/'],
  },
  // 首帧不需要：动画库与灯箱只在异步组件里用。单独成 chunk，不再被 reka-ui 的
  // 静态关键引用连坐拖进首帧下载。
  {
    name: 'vendor-motion',
    patterns: ['/node_modules/motion-v/'],
  },
  {
    name: 'vendor-lightbox',
    patterns: ['/node_modules/@fancyapps/'],
  },
  {
    name: 'vendor-xterm',
    patterns: ['/node_modules/@xterm/'],
  },
  {
    name: 'vendor-shell-analysis',
    patterns: [
      '/node_modules/web-tree-sitter/',
      '/node_modules/tree-sitter-bash/',
      '/node_modules/@wasm-fmt/shfmt/',
      '/src/domains/terminal/utils/shell-completion.ts',
      '/src/constants/shell/command-catalog.ts',
      '/src/domains/terminal/utils/shfmt.ts',
    ],
  },
];

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
    alias: [
      {
        find: /^vue$/,
        replacement: path.resolve(
          __dirname,
          'node_modules/vue/dist/vue.runtime-with-vapor.esm-browser.js',
        ),
      },
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url)),
      },
    ],
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
          for (const { name, patterns } of CHUNK_RULES) {
            if (patterns.some((p) => normalizedId.includes(p))) {
              return name;
            }
          }
        },
      },
    },
  },
}));

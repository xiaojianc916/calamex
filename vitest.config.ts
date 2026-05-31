import path from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    vue(),
    Icons({
      compiler: 'vue3',
      autoInstall: true,
      defaultStyle: '',
      defaultClass: '',
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.{spec,test}.ts', 'src/**/*.{spec,test}.vue'],
    exclude: ['node_modules', 'dist', 'target'],
    server: {
      deps: {
        inline: [/vue-markdown-design/],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      // 关键模块差分覆盖率 ≥ 90%（R-20.9.1）
      thresholds: {
        global: {
          lines: 80,
          branches: 80,
        },
      },
    },
    // 模拟 Tauri API（IPC 层测试时替换）
    setupFiles: ['src/__tests__/setup.ts'],
  },
});

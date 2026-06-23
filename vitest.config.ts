import path from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    vue(), // 只保留 Vue 插件
  ],
  resolve: {
    alias: [
      {
        find: /^vue$/,
        replacement: path.resolve(__dirname, 'src/__tests__/vue-vapor-vitest-runtime.mjs'),
      },
      {
        find: '@',
        replacement: path.resolve(__dirname, 'src'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.{spec,test}.ts', 'src/**/*.{spec,test}.vue'],
    exclude: ['node_modules', 'dist', 'target'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        global: {
          lines: 80,
          branches: 80,
        },
      },
    },
    setupFiles: ['src/__tests__/setup.ts'],
  },
});

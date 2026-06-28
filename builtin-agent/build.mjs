// 使用 esbuild 逐文件转译 src -> dist（bundle: false，保持与 tsc 一致的目录结构）。
// 类型检查交给 `pnpm typecheck`（tsc --noEmit）；第三方依赖一律不内联，运行时从 node_modules 解析。
import { globSync } from 'node:fs';
import { build } from 'esbuild';

const entryPoints = globSync('src/**/*.ts').filter((file) => !file.endsWith('.spec.ts'));

await build({
    entryPoints,
    outdir: 'dist',
    outbase: 'src',
    platform: 'node',
    format: 'esm',
    target: 'node26',
    sourcemap: true,
    bundle: false,
    logLevel: 'info',
});

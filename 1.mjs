#!/usr/bin/env node
// apply-p2.mjs —— P2 第一步：把 builtin-agent/build.mjs 改为「打包进程内导入图」。运行后可删。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const buildMjsPath = join(repoRoot, 'builtin-agent', 'build.mjs');

const buildMjs = String.raw`// builtin-agent/build.mjs
//
// P2：用 esbuild 把「进程内」导入图打成单文件 dist/acp/stdio-entry.js。
// 目的：从随包 node_modules 中剔除纯进程内依赖，缩小安装包 / 加速 NSIS 压缩。
//
// 外置（不可/不应打包）：
//   - 原生插件（.node）：@ast-grep/napi、@libsql/client（及依赖它的 @mastra/libsql）
//   - 以子进程/bin 启动的包：typescript-language-server、各 MCP server
//     （运行时要执行它们的 bin，必须以真实 node_modules 形式随包）
// 说明：类型检查仍由 pnpm typecheck 负责；单测仍从 src 经 tsx 运行，不受影响。

import { build } from 'esbuild';

const external = [
  '@ast-grep/napi',
  '@libsql/client',
  '@mastra/libsql',
  'typescript-language-server',
  '@modelcontextprotocol/server-memory',
  '@modelcontextprotocol/server-sequential-thinking',
  '@upstash/context7-mcp',
  'tavily-mcp',
];

// ESM 输出里补齐 require/__dirname/__filename：不少 CJS 依赖被打包后仍会在运行时用到。
const banner = [
  "import { createRequire as __createRequire } from 'node:module';",
  "import { fileURLToPath as __fileURLToPath } from 'node:url';",
  "import { dirname as __pathDirname } from 'node:path';",
  'const require = __createRequire(import.meta.url);',
  'const __filename = __fileURLToPath(import.meta.url);',
  'const __dirname = __pathDirname(__filename);',
].join('\n');

await build({
  entryPoints: ['src/acp/stdio-entry.ts'],
  outfile: 'dist/acp/stdio-entry.js',
  platform: 'node',
  format: 'esm',
  target: 'node26',
  bundle: true,
  sourcemap: true,
  external,
  banner: { js: banner },
  logLevel: 'info',
});
`;

if (!existsSync(buildMjsPath)) {
  console.error('[apply-p2] 未找到 ' + buildMjsPath);
  process.exit(1);
}
if (!existsSync(buildMjsPath + '.bak')) {
  writeFileSync(buildMjsPath + '.bak', readFileSync(buildMjsPath));
}
writeFileSync(buildMjsPath, buildMjs);
console.log('[apply-p2] 已改写 builtin-agent/build.mjs（旧文件备份 build.mjs.bak）');
console.log('[apply-p2] 下一步：cd builtin-agent && node build.mjs   把输出贴回');
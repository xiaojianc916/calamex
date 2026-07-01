// apply-p2.mjs —— P2 第二轮：补全 external（浏览器/playwright 栈）
// 仅本地打补丁工具（.mjs）；长期运行脚本仍是 .ts / build.mjs
import { writeFileSync, existsSync, copyFileSync } from 'node:fs';

const target = 'builtin-agent/build.mjs';
const backup = 'builtin-agent/build.mjs.bak';

// 关键：只在备份不存在时创建，避免把已改过的文件当成“原始”覆盖掉
if (existsSync(target) && !existsSync(backup)) {
  copyFileSync(target, backup);
  console.log('[apply-p2] 已备份原始 build.mjs -> build.mjs.bak');
} else {
  console.log('[apply-p2] 备份已存在，保留原始 build.mjs.bak（不覆盖）');
}

const content = String.raw`import { build } from 'esbuild';

// external 分三类，全部保持为真实 node_modules 包，不进 bundle：
//  1) 原生 .node 插件
//  2) 拉起子进程 / bin 的包
//  3) 浏览器自动化栈（playwright 预打包，含条件可选 require，不可打包）
const external = [
  // 原生插件
  '@ast-grep/napi',
  '@libsql/client',
  '@mastra/libsql',
  // 子进程 / bin
  'typescript-language-server',
  '@modelcontextprotocol/server-memory',
  '@modelcontextprotocol/server-sequential-thinking',
  '@upstash/context7-mcp',
  'tavily-mcp',
  // 浏览器栈（本轮新增）
  '@mastra/agent-browser',
  'playwright',
  'playwright-core',
  'chromium-bidi',
];

// ESM 输出下补齐 require/__filename/__dirname（被打进来的 CJS 依赖会用到）
const bannerLines = [
  "import { createRequire as __cr } from 'node:module';",
  "import { fileURLToPath as __fu } from 'node:url';",
  "import { dirname as __dn } from 'node:path';",
  "const require = __cr(import.meta.url);",
  "const __filename = __fu(import.meta.url);",
  "const __dirname = __dn(__filename);",
];

await build({
  entryPoints: ['src/acp/stdio-entry.ts'],
  outfile: 'dist/acp/stdio-entry.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  sourcemap: true,
  external,
  banner: { js: bannerLines.join('\n') },
  logLevel: 'info',
});

console.log('[build] done -> dist/acp/stdio-entry.js');
`;

writeFileSync(target, content);
console.log('[apply-p2] 已写入 builtin-agent/build.mjs（external 已补齐浏览器栈）');
console.log('[apply-p2] 下一步：cd builtin-agent && node build.mjs  把输出贴回');
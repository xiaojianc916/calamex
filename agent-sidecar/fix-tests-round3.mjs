// fix-tests-round3.mjs —— 在 agent-sidecar/ 目录运行：node fix-tests-round3.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const edits = [
  {
    file: 'src/tools/mcp/client.spec.ts',
    desc: '① context-wrapper：mock 改抛 TypeError（忠实真实运行时）',
    from: `throw new Error("Cannot read properties of undefined (reading 'context')");`,
    to:   `throw new TypeError("Cannot read properties of undefined (reading 'context')");`,
  },
  {
    file: 'src/tools/mcp/client.spec.ts',
    desc: '② readonly：把 git_commit 标为写操作（destructiveHint），让 readonly 过滤剃除它',
    from: `          git_commit: createTool({\n            id: 'git_commit',\n            description: '创建 Git commit',\n            inputSchema: z.object({\n              message: z.string(),\n            }),\n            execute: async () => ({ ok: true }),\n          }),`,
    to:   `          git_commit: {\n            description: '创建 Git commit',\n            annotations: { destructiveHint: true },\n            execute: async () => ({ ok: true }),\n          },`,
  },
  {
    file: 'src/tools/mcp/gateway/warm-pool.ts',
    desc: '③ shutdown 竞态：移除 evictExpired 后的二次 isDisposed 早退（在途创建交给 .then 处置守卫清理 → disconnectCalls=1）',
    from: `    await this.evictExpired();\n    if (this.isDisposed) {\n      throw new Error('MCP gateway warm pool 已关闭。');\n    }\n    const key = createPoolKey(input.workspaceRootPath, input.serverName, this.pinnedServersIgnoreWorkspace);`,
    to:   `    await this.evictExpired();\n    const key = createPoolKey(input.workspaceRootPath, input.serverName, this.pinnedServersIgnoreWorkspace);`,
  },
];

let ok = true;
const cache = new Map();
for (const e of edits) {
  const src = cache.has(e.file) ? cache.get(e.file) : readFileSync(e.file, 'utf8');
  const hits = src.split(e.from).length - 1;
  if (hits !== 1) {
    console.error(`✗ ${e.desc}\n  命中 ${hits} 次（期望 1），跳过：${e.file}`);
    ok = false;
    continue;
  }
  cache.set(e.file, src.split(e.from).join(e.to));
  console.log(`✓ ${e.desc}`);
}
if (!ok) { console.error('有补丁未命中，全部未写盘。把未命中文件原文发我即可。'); process.exit(1); }
for (const [file, content] of cache) { writeFileSync(file, content, 'utf8'); console.log(`written: ${file}`); }
console.log('done.');
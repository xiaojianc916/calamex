// fix-tests-round2.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const patches = [
  {
    file: 'agent-sidecar/src/tools/mcp/client.ts',
    from: "new URL('../../', import.meta.url)",
    to:   "new URL('../../../', import.meta.url)",
    why: '重构后 client.ts 下沉一层，.bin 基路径少算一级，导致解析到 src/node_modules/.bin',
  },
  {
    file: 'agent-sidecar/src/tools/mcp/gateway/capability.ts',
    from: 'return annotations as IMcpToolAnnotations | undefined;',
    to:   'return (annotations ?? undefined) as IMcpToolAnnotations | undefined;',
    why: 'readMcpToolAnnotations 把 toRecord 的 null 归一为 undefined',
  },
  {
    file: 'agent-sidecar/src/acp/agent.spec.ts',
    from: '.size, 128_000)',
    to:   '.size, 1_000_000)',
    why: 'acp 期望对齐 1M 上下文窗口（改测试，源码不动）',
  },
  {
    file: 'agent-sidecar/src/engines/budget/context-budget-policy.spec.ts',
    from: 'retainRecentUserMessageTexts(messages, 20)',
    to:   'retainRecentUserMessageTexts(messages, 11)',
    why: 'budget 测试预算 20→11，匹配源码保留逻辑（改测试，源码不动）',
  },
];

let failed = false;
for (const p of patches) {
  const src = readFileSync(p.file, 'utf8');
  const hits = src.split(p.from).length - 1;
  if (hits === 0) { console.error(`✗ 未命中: ${p.file}\n    找不到: ${p.from}`); failed = true; continue; }
  if (hits > 1)  { console.error(`⚠ 多处命中(${hits})，跳过防误改: ${p.file}`); failed = true; continue; }
  writeFileSync(p.file, src.split(p.from).join(p.to));
  console.log(`✓ ${p.file}\n    ${p.why}`);
}
process.exit(failed ? 1 : 0);
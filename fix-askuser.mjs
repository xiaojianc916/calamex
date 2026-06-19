// fix-askuser.mjs —— 在 agent-sidecar 目录下运行 node fix-askuser.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const REL = 'src/tools/interaction/ask-user.ts';
if (!existsSync(REL)) { console.error('✗ 请在 agent-sidecar 目录下运行'); process.exit(1); }

const find = 'suspend?: (payload: TAskUserRequest) => Promise<unknown>;';
const replace = 'suspend?: (payload: TAskUserRequest) => Promise<z.infer<typeof askUserOutputSchema>>;';

const before = readFileSync(REL, 'utf8');
const n = before.split(find).length - 1;
if (n !== 1) { console.error(`✗ 预期 1 处，实际 ${n} 处，已中止`); process.exit(1); }
writeFileSync(REL, before.split(find).join(replace), 'utf8');
console.log('✓ ' + REL);
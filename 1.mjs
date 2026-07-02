// scripts/point-sidecar-to-acp.mjs — 在仓库根运行
import { readFileSync, writeFileSync } from 'node:fs';
const FILE = 'src/services/tauri/sidecar.ts';
const RENAMES = [
  ['commands.builtinAgentHealth()', 'commands.acpHostHealth()'],
  ['commands.builtinAgentRestart()', 'commands.acpHostRestart()'],
  ['commands.builtinAgentWarmup()', 'commands.acpHostWarmup()'],
  [
    'commands.builtinAgentExternalChat(payload as unknown as AgentExternalChatRequest_Deserialize)',
    'commands.acpPrompt(payload as unknown as AgentExternalChatRequest_Deserialize)',
  ],
  ['commands.builtinAgentRestoreCheckpoint(', 'commands.acpRestoreCheckpoint('],
];
let src = readFileSync(FILE, 'utf8');
let n = 0;
for (const [from, to] of RENAMES) {
  if (!src.includes(from)) {
    console.error(`[FAIL] 未命中，已停止（文件可能又变了，先重新贴内容）: ${from}`);
    process.exit(1);
  }
  src = src.split(from).join(to);
  n += 1;
}
writeFileSync(FILE, src);
console.log(`[done] ${FILE}: ${n}/${RENAMES.length} 处已对齐 commands.acp*`);
console.log('收尾：pnpm typecheck && pnpm lint --fix && pnpm test。');
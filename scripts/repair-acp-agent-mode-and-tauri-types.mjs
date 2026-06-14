import { readFileSync, writeFileSync } from 'node:fs';

const agentPath = 'agent-sidecar/src/acp/agent.ts';
let agent = readFileSync(agentPath, 'utf8');
const originalAgent = agent;

const runtimeMapMatch = agent.match(/const RUNTIME_METHOD_BY_MODE = \{[\s\S]*?\n\} as const satisfies Record<TAgentMode, "chat" \| "plan" \| "execute">/);
if (!runtimeMapMatch) {
  throw new Error(`${agentPath}: cannot locate RUNTIME_METHOD_BY_MODE`);
}

const runtimeMap = runtimeMapMatch[0];
if (/^\s*task:\s*["']chat["'],/m.test(runtimeMap)) {
  agent = agent.replace(/^(\s*)task:\s*(["'])chat\2,/m, '$1ask: "chat",');
} else if (!/^\s*ask:\s*["']chat["'],/m.test(runtimeMap)) {
  throw new Error(`${agentPath}: neither stale task route nor repaired ask route was found`);
}

const repairedMap = agent.match(/const RUNTIME_METHOD_BY_MODE = \{[\s\S]*?\n\} as const satisfies Record<TAgentMode, "chat" \| "plan" \| "execute">/)?.[0] ?? '';
if (!/^\s*ask:\s*["']chat["'],/m.test(repairedMap)) {
  throw new Error(`${agentPath}: ask mode route was not repaired`);
}
if (/^\s*task:\s*["']chat["'],/m.test(repairedMap)) {
  throw new Error(`${agentPath}: stale task mode route still exists`);
}

if (agent !== originalAgent) {
  writeFileSync(agentPath, agent);
}

const tauriTypesPath = 'src/types/tauri/index.ts';
let tauriTypes = readFileSync(tauriTypesPath, 'utf8');
const originalTauriTypes = tauriTypes;
const badRestoreSignature = '  agentSidecarRestoreCheckpoint(\n    payload: IAgentSidecarCheckpointRestoreRequest): Promise<IAgentSidecarResponsePayload>;';
const goodRestoreSignature = '  agentSidecarRestoreCheckpoint(\n    payload: IAgentSidecarCheckpointRestoreRequest,\n  ): Promise<IAgentSidecarResponsePayload>;';

if (tauriTypes.includes(badRestoreSignature)) {
  tauriTypes = tauriTypes.replace(badRestoreSignature, goodRestoreSignature);
} else if (!tauriTypes.includes(goodRestoreSignature)) {
  throw new Error(`${tauriTypesPath}: cannot locate agentSidecarRestoreCheckpoint signature`);
}

if (tauriTypes !== originalTauriTypes) {
  writeFileSync(tauriTypesPath, tauriTypes);
}

console.log('已修复 ACP ask 模式路由残留与 tauri 类型格式；若本地已经修过则保持不变。');

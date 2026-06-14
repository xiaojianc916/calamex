import { readFileSync, writeFileSync } from 'node:fs';

const replaceOnce = (content, from, to, path) => {
  const count = content.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`${path}: expected exactly one match for ${JSON.stringify(from)}, got ${count}`);
  }
  return content.replace(from, to);
};

const agentPath = 'agent-sidecar/src/acp/agent.ts';
let agent = readFileSync(agentPath, 'utf8');
agent = replaceOnce(
  agent,
  '\ttask: "chat",\n\tplan: "plan",',
  '\task: "chat",\n\tplan: "plan",',
  agentPath,
);
if (!agent.includes('ask: "chat"')) {
  throw new Error(`${agentPath}: ask mode route was not repaired`);
}
if (agent.includes('\ttask: "chat",')) {
  throw new Error(`${agentPath}: stale task mode route still exists`);
}
writeFileSync(agentPath, agent);

const tauriTypesPath = 'src/types/tauri/index.ts';
let tauriTypes = readFileSync(tauriTypesPath, 'utf8');
tauriTypes = replaceOnce(
  tauriTypes,
  '  agentSidecarRestoreCheckpoint(\n    payload: IAgentSidecarCheckpointRestoreRequest): Promise<IAgentSidecarResponsePayload>;',
  '  agentSidecarRestoreCheckpoint(\n    payload: IAgentSidecarCheckpointRestoreRequest,\n  ): Promise<IAgentSidecarResponsePayload>;',
  tauriTypesPath,
);
writeFileSync(tauriTypesPath, tauriTypes);

console.log('已修复 ACP ask 模式路由残留与 tauri 类型格式。');

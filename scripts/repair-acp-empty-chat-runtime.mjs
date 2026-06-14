import { readFileSync, writeFileSync } from 'node:fs';

const agentPath = 'agent-sidecar/src/acp/agent.ts';
let agent = readFileSync(agentPath, 'utf8');
const originalAgent = agent;

const mapPattern = /const RUNTIME_METHOD_BY_MODE = \{[\s\S]*?\n\} as const satisfies Record<TAgentMode, "chat" \| "plan" \| "execute">/;
const mapMatch = agent.match(mapPattern);

if (!mapMatch) {
  throw new Error(`${agentPath}: cannot locate RUNTIME_METHOD_BY_MODE`);
}

const currentMap = mapMatch[0];
let nextMap = currentMap;

if (/^\s*task:\s*["']chat["'],?\s*$/m.test(nextMap)) {
  nextMap = nextMap.replace(/^(\s*)task:\s*["']chat["'],?\s*$/m, '$1ask: "chat",');
}

if (!/^\s*ask:\s*["']chat["'],?\s*$/m.test(nextMap)) {
  throw new Error(`${agentPath}: ask route is missing from RUNTIME_METHOD_BY_MODE`);
}

if (/^\s*task:\s*["']chat["'],?\s*$/m.test(nextMap)) {
  throw new Error(`${agentPath}: stale task route still exists in RUNTIME_METHOD_BY_MODE`);
}

agent = agent.replace(currentMap, nextMap);

if (agent !== originalAgent) {
  writeFileSync(agentPath, agent);
  console.log('已修复 agent-sidecar ACP ask 路由: task -> ask。');
} else {
  console.log('agent-sidecar ACP ask 路由已经是正确状态，无需修改。');
}

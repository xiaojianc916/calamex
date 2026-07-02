// scripts/point-frontend-to-acp.mjs — 在仓库根运行
import { readFileSync, writeFileSync } from 'node:fs';

// 1) sidecar.ts：删 3 个幽灵方法（对应 Rust 命令从未注册）+ META 条目 + Pick 成员 + 死 import
const SIDECAR = 'src/services/tauri/sidecar.ts';
let s = readFileSync(SIDECAR, 'utf8');
const deadBlocks = [
  `  agentSidecarChat(payload, options?: IIpcCallOptions) {\n    return runCommand(SIDECAR_COMMAND_META.agentSidecarChat, payload, options, () =>\n      commands.agentSidecarChat(payload as unknown as AgentSidecarChatRequest_Deserialize),\n    ) as Promise<IAgentSidecarResponsePayload>;\n  },\n\n`,
  `  agentSidecarResolveApproval(payload, options?: IIpcCallOptions) {\n    return runCommand(SIDECAR_COMMAND_META.agentSidecarResolveApproval, payload, options, () =>\n      commands.agentSidecarResolveApproval(\n        payload as unknown as AgentSidecarApprovalResolveRequest_Deserialize,\n      ),\n    ) as Promise<IAgentSidecarResponsePayload>;\n  },\n\n`,
  `  agentSidecarResolveAskUser(payload, options?: IIpcCallOptions) {\n    return runCommand(SIDECAR_COMMAND_META.agentSidecarResolveAskUser, payload, options, () =>\n      commands.agentSidecarResolveAskUser(\n        payload as unknown as AgentSidecarAskUserResumeRequest_Deserialize,\n      ),\n    ) as Promise<IAgentSidecarResponsePayload>;\n  },\n\n`,
  `  agentSidecarChat: {\n    command: 'builtin_agent_chat',\n    guardHint: '通过 Node sidecar 执行 Agent Ask',\n    audit: 'sensitive',\n    timeoutMs: BUILTIN_AGENT_TASK_TIMEOUT_MS,\n    measureInput: measureAiChatInput,\n  },\n`,
  `  agentSidecarResolveApproval: {\n    command: 'builtin_agent_resolve_approval',\n    guardHint: '处理 Agent sidecar 工具审批',\n    audit: 'sensitive',\n    timeoutMs: BUILTIN_AGENT_TASK_TIMEOUT_MS,\n  },\n`,
  `  agentSidecarResolveAskUser: {\n    command: 'builtin_agent_resolve_ask_user',\n    guardHint: '处理 Agent sidecar 询问用户回合恢复',\n    audit: 'sensitive',\n    timeoutMs: BUILTIN_AGENT_TASK_TIMEOUT_MS,\n  },\n`,
  `  | 'agentSidecarChat'\n`,
  `  | 'agentSidecarResolveApproval'\n`,
  `  | 'agentSidecarResolveAskUser'\n`,
  `  type AgentSidecarApprovalResolveRequest_Deserialize,\n`,
  `  type AgentSidecarAskUserResumeRequest_Deserialize,\n`,
  `  type AgentSidecarChatRequest_Deserialize,\n`,
];
for (const b of deadBlocks) {
  if (s.includes(b)) s = s.replace(b, '');
  else console.warn(`[skip] sidecar.ts 未命中块: ${b.split('\n')[0].trim()}`);
}

// 2) 5 个存活命令：调用目标 + 审计字符串对齐重生成后的 acp_* 绑定
const MAP = [
  ['commands.agentSidecarExternalChat', 'commands.acpPrompt'],
  ['commands.agentSidecarHealth', 'commands.acpHostHealth'],
  ['commands.agentSidecarRestart', 'commands.acpHostRestart'],
  ['commands.agentSidecarWarmup', 'commands.acpHostWarmup'],
  ['commands.agentSidecarRestoreCheckpoint', 'commands.acpRestoreCheckpoint'],
  ["command: 'builtin_agent_external_chat'", "command: 'acp_prompt'"],
  ["command: 'builtin_agent_health'", "command: 'acp_host_health'"],
  ["command: 'builtin_agent_restart'", "command: 'acp_host_restart'"],
  ["command: 'builtin_agent_warmup'", "command: 'acp_host_warmup'"],
  ["command: 'builtin_agent_restore_checkpoint'", "command: 'acp_restore_checkpoint'"],
];
for (const [from, to] of MAP) {
  if (s.includes(from)) s = s.split(from).join(to);
  else console.warn(`[skip] sidecar.ts 未命中: ${from}`);
}
writeFileSync(SIDECAR, s);
console.log(`[done] ${SIDECAR}`);

// 3) ITauriService 删 3 条幽灵签名 + 死 import
const TYPES = 'src/types/tauri/index.ts';
let t = readFileSync(TYPES, 'utf8');
const typeBlocks = [
  `  agentSidecarChat(payload: IAgentSidecarChatRequest): Promise<IAgentSidecarResponsePayload>;\n`,
  `  agentSidecarResolveApproval(\n    payload: IAgentSidecarApprovalResolveRequest,\n  ): Promise<IAgentSidecarResponsePayload>;\n`,
  `  agentSidecarResolveAskUser(\n    payload: IAgentSidecarAskUserResumeRequest,\n  ): Promise<IAgentSidecarResponsePayload>;\n`,
  `  IAgentSidecarApprovalResolveRequest,\n`,
  `  IAgentSidecarAskUserResumeRequest,\n`,
  `  IAgentSidecarChatRequest,\n`,
];
for (const b of typeBlocks) {
  if (t.includes(b)) t = t.replace(b, '');
  else console.warn(`[skip] types/tauri/index.ts 未命中块: ${b.split('\n')[0].trim()}`);
}
writeFileSync(TYPES, t);
console.log(`[done] ${TYPES}`);
console.log('收尾：pnpm typecheck → pnpm lint --fix && pnpm test。');
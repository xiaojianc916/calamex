#!/usr/bin/env node
// fix-ai-service-ts.mjs
// 修复 ai.service.ts 三处 TS 报错：
//   1) ts6133 删除未使用的 dotenv 导入
//   2) ts2345 saveScript 补齐必填 workspaceRootPath
//   3) ts2339 接线已存在的 agent_sidecar_resolve_ask_user 命令（ITauriService + sidecarTauriService）
// 幂等：已改过的文件再次运行会跳过；任一锚点缺失/不唯一则整体中止、不写盘。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const L = (...lines) => lines.join('\n');

/** @type {Record<string, Array<{find:string, replace:string, marker?:string, skipIfMissing?:boolean, note:string}>>} */
const EDITS = {
  'src/services/ipc/ai.service.ts': [
    {
      note: 'ts6133: 删除未使用的 dotenv 导入',
      find: "import dotenv from 'dotenv';\n",
      replace: '',
      skipIfMissing: true,
    },
    {
      note: 'ts2345: saveScript 补齐 workspaceRootPath',
      find: L(
        '      path: sidecarDotenvPath,',
        '      content: updateDotenvAssignment(',
      ),
      replace: L(
        '      path: sidecarDotenvPath,',
        '      workspaceRootPath,',
        '      content: updateDotenvAssignment(',
      ),
      marker: L(
        '      workspaceRootPath,',
        '      content: updateDotenvAssignment(',
      ),
    },
  ],

  'src/types/tauri/index.ts': [
    {
      note: 'ts2339: 导入 IAgentSidecarAskUserResumeRequest',
      find: L(
        '  IAgentSidecarApprovalResolveRequest,',
        '  IAgentSidecarChatRequest,',
      ),
      replace: L(
        '  IAgentSidecarApprovalResolveRequest,',
        '  IAgentSidecarAskUserResumeRequest,',
        '  IAgentSidecarChatRequest,',
      ),
      marker: L(
        '  IAgentSidecarAskUserResumeRequest,',
        '  IAgentSidecarChatRequest,',
      ),
    },
    {
      note: 'ts2339: ITauriService 声明 agentSidecarResolveAskUser',
      find: L(
        '  agentSidecarResolveApproval(',
        '    payload: IAgentSidecarApprovalResolveRequest,',
        '  ): Promise<IAgentSidecarResponsePayload>;',
        '  agentSidecarRestoreCheckpoint(',
      ),
      replace: L(
        '  agentSidecarResolveApproval(',
        '    payload: IAgentSidecarApprovalResolveRequest,',
        '  ): Promise<IAgentSidecarResponsePayload>;',
        '  agentSidecarResolveAskUser(',
        '    payload: IAgentSidecarAskUserResumeRequest,',
        '  ): Promise<IAgentSidecarResponsePayload>;',
        '  agentSidecarRestoreCheckpoint(',
      ),
      marker: L(
        '  agentSidecarResolveAskUser(',
        '    payload: IAgentSidecarAskUserResumeRequest,',
      ),
    },
  ],

  'src/services/tauri.sidecar.ts': [
    {
      note: 'ts2339: 导入 AgentSidecarAskUserResumeRequest_Deserialize',
      find: L(
        '  type AgentSidecarApprovalResolveRequest_Deserialize,',
        '  type AgentSidecarChatRequest_Deserialize,',
      ),
      replace: L(
        '  type AgentSidecarApprovalResolveRequest_Deserialize,',
        '  type AgentSidecarAskUserResumeRequest_Deserialize,',
        '  type AgentSidecarChatRequest_Deserialize,',
      ),
      marker: '  type AgentSidecarAskUserResumeRequest_Deserialize,',
    },
    {
      note: 'ts2339: SIDECAR_COMMAND_META 增加 agentSidecarResolveAskUser',
      find: L(
        '  agentSidecarResolveApproval: {',
        "    command: 'agent_sidecar_resolve_approval',",
        "    guardHint: '处理 Agent sidecar 工具审批',",
        "    audit: 'sensitive',",
        '    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,',
        '  },',
        '  agentSidecarRestoreCheckpoint: {',
      ),
      replace: L(
        '  agentSidecarResolveApproval: {',
        "    command: 'agent_sidecar_resolve_approval',",
        "    guardHint: '处理 Agent sidecar 工具审批',",
        "    audit: 'sensitive',",
        '    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,',
        '  },',
        '  agentSidecarResolveAskUser: {',
        "    command: 'agent_sidecar_resolve_ask_user',",
        "    guardHint: '处理 Agent sidecar 询问用户回合恢复',",
        "    audit: 'sensitive',",
        '    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,',
        '  },',
        '  agentSidecarRestoreCheckpoint: {',
      ),
      marker: "    command: 'agent_sidecar_resolve_ask_user',",
    },
    {
      note: 'ts2339: TSidecarTauriService Pick 增加 agentSidecarResolveAskUser',
      find: L(
        "  | 'agentSidecarResolveApproval'",
        "  | 'agentSidecarRestoreCheckpoint'",
      ),
      replace: L(
        "  | 'agentSidecarResolveApproval'",
        "  | 'agentSidecarResolveAskUser'",
        "  | 'agentSidecarRestoreCheckpoint'",
      ),
      marker: "  | 'agentSidecarResolveAskUser'",
    },
    {
      note: 'ts2339: sidecarTauriService 实现 agentSidecarResolveAskUser',
      find: L(
        '  agentSidecarResolveApproval(payload, options?: IIpcCallOptions) {',
        '    return runCommand(SIDECAR_COMMAND_META.agentSidecarResolveApproval, payload, options, () =>',
        '      commands.agentSidecarResolveApproval(',
        '        payload as unknown as AgentSidecarApprovalResolveRequest_Deserialize,',
        '      ),',
        '    ) as Promise<IAgentSidecarResponsePayload>;',
        '  },',
        '',
        '  agentSidecarRestoreCheckpoint(payload, options?: IIpcCallOptions) {',
      ),
      replace: L(
        '  agentSidecarResolveApproval(payload, options?: IIpcCallOptions) {',
        '    return runCommand(SIDECAR_COMMAND_META.agentSidecarResolveApproval, payload, options, () =>',
        '      commands.agentSidecarResolveApproval(',
        '        payload as unknown as AgentSidecarApprovalResolveRequest_Deserialize,',
        '      ),',
        '    ) as Promise<IAgentSidecarResponsePayload>;',
        '  },',
        '',
        '  agentSidecarResolveAskUser(payload, options?: IIpcCallOptions) {',
        '    return runCommand(SIDECAR_COMMAND_META.agentSidecarResolveAskUser, payload, options, () =>',
        '      commands.agentSidecarResolveAskUser(',
        '        payload as unknown as AgentSidecarAskUserResumeRequest_Deserialize,',
        '      ),',
        '    ) as Promise<IAgentSidecarResponsePayload>;',
        '  },',
        '',
        '  agentSidecarRestoreCheckpoint(payload, options?: IIpcCallOptions) {',
      ),
      marker: '      commands.agentSidecarResolveAskUser(',
    },
  ],
};

function applyEdit(content, edit, file) {
  if (edit.marker && content.includes(edit.marker)) {
    return { content, status: 'skip' }; // 已应用
  }
  const first = content.indexOf(edit.find);
  if (first === -1) {
    if (edit.skipIfMissing) return { content, status: 'skip' };
    throw new Error(`[${file}] 未找到锚点（${edit.note}）`);
  }
  if (content.indexOf(edit.find, first + edit.find.length) !== -1) {
    throw new Error(`[${file}] 锚点不唯一（${edit.note}）`);
  }
  return {
    content: content.slice(0, first) + edit.replace + content.slice(first + edit.find.length),
    status: 'apply',
  };
}

let changedFiles = 0;
for (const [rel, edits] of Object.entries(EDITS)) {
  const abs = resolve(process.cwd(), rel);
  let content = readFileSync(abs, 'utf8');
  let dirty = false;
  for (const edit of edits) {
    const r = applyEdit(content, edit, rel);
    content = r.content;
    console.log(`  [${r.status === 'apply' ? '改' : '跳过'}] ${rel} :: ${edit.note}`);
    if (r.status === 'apply') dirty = true;
  }
  if (dirty) {
    writeFileSync(abs, content, 'utf8');
    changedFiles += 1;
  }
}

console.log(changedFiles > 0 ? `\n完成，已修改 ${changedFiles} 个文件。` : '\n无需改动（已是修复后状态）。');
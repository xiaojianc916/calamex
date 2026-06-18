#!/usr/bin/env node
// 接收侧宿主接线（ADR-20260617 · D7 接收侧）：把 useAiAssistant 唯一 onSidecarStream 路由到的
// ACP UI 事件（mode_update / available_commands_update / usage_update）分发到对应 ACP composable
// VM；并实例化、随会话生命周期 reset、对外暴露只读 VM。终端（客户端方法）与审批（pendingConfirmation）
// 不经本事件流，不在此接线。单文件 5 处编辑，ASCII anchor，原子写：任一 anchor 未命中即抛错、不落盘。
// 幂等：marker=applyAcpReceiveSideEvents。LF 归一、原 EOL 还原。

import { readFileSync, writeFileSync } from 'node:fs';

const patchFile = (file, marker, edits) => {
  const original = readFileSync(file, 'utf8');
  if (original.includes(marker)) {
    console.log(`[skip] ${file} 已含 ${marker}`);
    return;
  }
  const hadCrlf = original.includes('\r\n');
  let text = original.replace(/\r\n/g, '\n');
  for (const [anchor, replacement, keyword] of edits) {
    const count = text.split(anchor).length - 1;
    if (count !== 1) {
      console.error(`--- ${file} 上下文 "${keyword}" ---`);
      text.split('\n').forEach((line, idx) => {
        if (line.includes(keyword)) {
          console.error(`${idx + 1}: ${line}`);
        }
      });
      console.error('--- end ---');
      throw new Error(`[${file}] anchor "${keyword}": expected 1 match but found ${count}`);
    }
    text = text.replace(anchor, () => replacement);
  }
  writeFileSync(file, hadCrlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  console.log(`[done] patched ${file}`);
};

const FILE = 'src/composables/ai/useAiAssistant.ts';

patchFile(FILE, 'applyAcpReceiveSideEvents', [
  // E1: imports
  [
    `import { useAiAgentPlan } from '@/composables/ai/useAiAgentPlan';`,
    `import { useAcpAvailableCommands } from '@/composables/ai/useAcpAvailableCommands';
import { useAcpSessionModes } from '@/composables/ai/useAcpSessionModes';
import { useAcpUsage } from '@/composables/ai/useAcpUsage';
import { useAiAgentPlan } from '@/composables/ai/useAiAgentPlan';`,
    'useAiAgentPlan',
  ],
  // E2: instantiate
  [
    `  const agentPlan = useAiAgentPlan();`,
    `  const agentPlan = useAiAgentPlan();
  const acpSessionModes = useAcpSessionModes();
  const acpAvailableCommands = useAcpAvailableCommands();
  const acpUsage = useAcpUsage();`,
    'agentPlan = useAiAgentPlan',
  ],
  // E3: receive-side router + call site
  [
    `  const applySidecarLiveEventsToAgentMessage = (
    assistantMessageId: string,
    threadId: string | null,
    fallbackContent: string,
    events: readonly TAgentUiEvent[],
  ): void => {
    const currentMessage = findMessageById(assistantMessageId);`,
    `  const applyAcpReceiveSideEvents = (events: readonly TAgentUiEvent[]): void => {
    // 接收侧宿主接线（ADR-20260617 · D7 接收侧）：把宿主唯一 onSidecarStream 路由到的
    // ACP session/update UI 事件分发到各 ACP composable VM。终端走客户端方法、审批走
    // finalizeSidecarTurn 的 pendingConfirmation，均不经本事件流，故不在此路由。
    // 累计事件每 tick 整份重扫，与既有 reduceAcpUiEventsToToolCalls / projectSidecarEventsToToolState
    // 同构；各 applier 均「整份替换、后者胜」，故重扫幂等。非穷尽 switch（default 兜底），
    // 新增 TAgentUiEvent 成员不会在此触发编译错误。
    for (const event of events) {
      switch (event.type) {
        case 'mode_update':
          acpSessionModes.applyModeUpdate(event.modeId);
          break;
        case 'available_commands_update':
          acpAvailableCommands.applyCommandsUpdate(event.availableCommands);
          break;
        case 'usage_update':
          acpUsage.applyUsageUpdate(event.usage);
          break;
        default:
          break;
      }
    }
  };

  const applySidecarLiveEventsToAgentMessage = (
    assistantMessageId: string,
    threadId: string | null,
    fallbackContent: string,
    events: readonly TAgentUiEvent[],
  ): void => {
    applyAcpReceiveSideEvents(events);
    const currentMessage = findMessageById(assistantMessageId);`,
    'applySidecarLiveEventsToAgentMessage',
  ],
  // E4: lifecycle reset
  [
    `    disposeSidecarAnswerStream();
    isClearDialogOpen.value = false;`,
    `    disposeSidecarAnswerStream();
    acpSessionModes.reset();
    acpAvailableCommands.reset();
    acpUsage.reset();
    isClearDialogOpen.value = false;`,
    'isClearDialogOpen.value = false',
  ],
  // E5: public surface
  [
    `  return {
    agentPlan,
    config,`,
    `  return {
    agentPlan,
    acpSessionModes,
    acpAvailableCommands,
    acpUsage,
    config,`,
    'agentPlan,',
  ],
]);

console.log('[all done] D7 接收侧宿主接线已应用。');

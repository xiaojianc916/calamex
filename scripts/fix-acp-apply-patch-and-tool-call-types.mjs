#!/usr/bin/env node
// 修复 vue-tsc 报错（D7 接收侧落地后的级联类型错误），单文件 6 处编辑：
// 1) acpToolCalls 误写进 ISidecarAnswerStreamMetadata 字面量（该类型无此字段，且
//    assignSidecarAnswerStreamMetadata 从不读它，是死赋值）——移到 updateAgentExecutionMessage
//    入参（IUpdateAgentExecutionMessageInput.acpToolCalls 本就支持），真正写到消息上。
//    涵盖实时路径与 finalizeSidecarTurn 两处。
// 2) AiApplyPatchMetadataRequest 现要求 agentRunId/agentStepId: string | null（必填）——
//    applySidecarPatchSets 用显式 ?? null 取代可选展开；rollbackChangedFilesSummary 补 null。
// 纯 ASCII anchor、原子写：任一 anchor != 1 命中即抛错不落盘。幂等 marker。LF 归一、原 EOL 还原。

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

patchFile(FILE, 'patchMetadata?.agentRunId ?? null', [
  // A1: 实时路径 streamMetadata 移除 acpToolCalls
  [
    `      toolCalls: toolProjection.toolCalls,
      acpToolCalls: reduceAcpUiEventsToToolCalls(events),
      streamStatus,
`,
    `      toolCalls: toolProjection.toolCalls,
      streamStatus,
`,
    'reduceAcpUiEventsToToolCalls(events)',
  ],
  // A2: 实时路径 updateAgentExecutionMessage 加上 acpToolCalls
  [
    `      messageId: assistantMessageId,
      content: displayContent,
      toolCalls: toolProjection.toolCalls,
      streamStatus: resolveSidecarAnswerDisplayStatus(streamMetadata),
`,
    `      messageId: assistantMessageId,
      content: displayContent,
      toolCalls: toolProjection.toolCalls,
      acpToolCalls: reduceAcpUiEventsToToolCalls(events),
      streamStatus: resolveSidecarAnswerDisplayStatus(streamMetadata),
`,
    'content: displayContent,',
  ],
  // A3: finalizeSidecarTurn streamMetadata 移除 acpToolCalls
  [
    `      toolCalls: toolProjection.toolCalls,
      acpToolCalls: reduceAcpUiEventsToToolCalls(payload.events),
      streamStatus: sidecarStreamStatus,
`,
    `      toolCalls: toolProjection.toolCalls,
      streamStatus: sidecarStreamStatus,
`,
    'reduceAcpUiEventsToToolCalls(payload.events)',
  ],
  // A4: finalizeSidecarTurn updateAgentExecutionMessage 加上 acpToolCalls
  [
    `      messageId: ctx.assistantMessageId,
      content: displayContent,
      toolCalls: toolProjection.toolCalls,
      streamStatus: projection.errorMessage
`,
    `      messageId: ctx.assistantMessageId,
      content: displayContent,
      toolCalls: toolProjection.toolCalls,
      acpToolCalls: reduceAcpUiEventsToToolCalls(payload.events),
      streamStatus: projection.errorMessage
`,
    'ctx.assistantMessageId,',
  ],
  // B1: applySidecarPatchSets metadata — 显式 agentRunId/agentStepId（去 undefined）
  [
    `              workspaceRootPath: options.workspaceRootPath.value,
              ...patchMetadata,
            },
`,
    `              workspaceRootPath: options.workspaceRootPath.value,
              agentRunId: patchMetadata?.agentRunId ?? null,
              agentStepId: patchMetadata?.agentStepId ?? null,
            },
`,
    '...patchMetadata,',
  ],
  // B2: rollbackChangedFilesSummary metadata — 补 agentRunId/agentStepId
  [
    `            toolCallId: 'rollback_changed_files_summary',
            confirmedByUser: true,
            workspaceRootPath: options.workspaceRootPath.value,
          },
`,
    `            toolCallId: 'rollback_changed_files_summary',
            confirmedByUser: true,
            workspaceRootPath: options.workspaceRootPath.value,
            agentRunId: null,
            agentStepId: null,
          },
`,
    'rollback_changed_files_summary',
  ],
]);

console.log('[all done] acpToolCalls 位置与 applyPatch metadata 类型修复已应用。');

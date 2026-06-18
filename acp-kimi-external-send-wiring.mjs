import { readFileSync, writeFileSync } from 'node:fs';

function patchFile(file, marker, edits) {
  const raw = readFileSync(file, 'utf8');
  if (raw.includes(marker)) {
    console.log(`= skip ${file} (marker present)`);
    return;
  }
  const hadCrlf = raw.includes('\r\n');
  let text = hadCrlf ? raw.replace(/\r\n/g, '\n') : raw;
  for (const [anchor, replacement, keyword] of edits) {
    const count = text.split(anchor).length - 1;
    if (count !== 1) {
      const probe = keyword ?? anchor.slice(0, 40);
      const ctx = text
        .split('\n')
        .filter((l) => l.includes(probe))
        .slice(0, 8)
        .join('\n');
      throw new Error(
        `[${file}] anchor expected 1 match but found ${count}\n--- probe "${probe}" ---\n${ctx}`,
      );
    }
    text = text.replace(anchor, () => replacement);
  }
  writeFileSync(file, hadCrlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  console.log(`✓ patched ${file}`);
}

/* 1) src/types/ai/sidecar.ts —— 外部发送契约（镜像 Rust contracts，camelCase） */
patchFile(
  'src/types/ai/sidecar.ts',
  'IAgentExternalChatRequest',
  [
    [
      `export interface IAgentSidecarOrchestratePayload {
  runId: string;
  result: TJsonValue | null;
}`,
      `export interface IAgentSidecarOrchestratePayload {
  runId: string;
  result: TJsonValue | null;
}

/* ============================================================================
 * 外部 ACP 编码 agent（Kimi / Codex，ADR-0015）发送契约
 *
 * 镜像 Rust 契约 src-tauri/src/commands/contracts/agent_sidecar.rs 的
 * AgentBackendKind / AgentExternalChatRequest / AgentExternalChatResultPayload
 * （serde rename_all = "camelCase"）。外部 agent 只实现标准 session/prompt，不接收
 * 逐请求 model_config（凭据由其自身 CLI 自管）；过程增量经 session/update 帧走既有
 * sidecar 流投影，本结果仅承载会话标识 + 回合终止原因。
 * ========================================================================== */

export type TAgentBackendKind = 'builtin' | 'kimi' | 'codex';

export interface IAgentExternalChatRequest {
  backend: TAgentBackendKind;
  text: string;
  threadId?: string;
  workspaceRootPath?: string | null;
}

export interface IAgentExternalChatResultPayload {
  sessionId: string;
  stopReason: string;
}`,
      'IAgentSidecarOrchestratePayload',
    ],
  ],
);

/* 2) src/services/ipc/ai.service.ts —— 包装 tauri 绑定 */
patchFile(
  'src/services/ipc/ai.service.ts',
  'sidecarExternalChat',
  [
    [
      `import type {
  IAgentSidecarApprovalResolveRequest,
  IAgentSidecarAskUserResumeRequest,`,
      `import type {
  IAgentExternalChatRequest,
  IAgentExternalChatResultPayload,
  IAgentSidecarApprovalResolveRequest,
  IAgentSidecarAskUserResumeRequest,`,
      'IAgentSidecarApprovalResolveRequest',
    ],
    [
      `  sidecarChat(payload: IAgentSidecarChatRequest): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarChat(payload);
  },`,
      `  sidecarChat(payload: IAgentSidecarChatRequest): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarChat(payload);
  },
  sidecarExternalChat(
    payload: IAgentExternalChatRequest,
  ): Promise<IAgentExternalChatResultPayload> {
    return tauriService.agentSidecarExternalChat(payload);
  },`,
      'sidecarChat(payload',
    ],
  ],
);

/* 3) src/composables/ai/useAiAssistant.ts —— 外部发送链路 + sendMessage 分流 */
patchFile(
  'src/composables/ai/useAiAssistant.ts',
  'executeExternalAgentRequest',
  [
    [
      `import type {
  IAgentSidecarMessage,
  IAskUserResult,
  TAgentRuntimeEvent,
  TAgentUiEvent,
} from '@/types/ai/sidecar';`,
      `import type {
  IAgentSidecarMessage,
  IAskUserResult,
  TAgentBackendKind,
  TAgentRuntimeEvent,
  TAgentUiEvent,
} from '@/types/ai/sidecar';`,
      "from '@/types/ai/sidecar'",
    ],
    [
      `  const executeAiRequest = async (`,
      `  // 外部 ACP 编码 agent（Kimi / Codex，ADR-0015）发送链路：经 agent_sidecar_external_chat
  // 驱动一轮标准 session/prompt。外部 agent 无富信封，过程增量经 session/update 帧走既有
  // sidecar 流（subscribeSidecarStreamWithPrebuffer + applySidecarLiveEventsToAgentMessage）；
  // prompt 返回即整轮结束，绑定会话并 flush 后把消息状态收口为 completed。
  const executeExternalAgentRequest = async (
    backend: TAgentBackendKind,
    visibleMessages: IAiChatMessage[],
    messageContent: string,
    threadId: string | null,
  ): Promise<void> => {
    errorMessage.value = '';
    isSending.value = true;
    runtimeTimelineEvents.value = [];
    activeBufferedThreadId.value = threadId;

    const assistantMessageId = createMessageId('assistant');
    const targetThreadId = threadId;
    const initialActivityText = buildInitialAgentActivityText();
    const placeholderMessage: IAiChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      references: [],
      toolCalls: [],
      stream: {
        status: 'streaming',
        activityText: initialActivityText,
        runtimeEvents: [],
      },
    };

    messages.value = [...visibleMessages, placeholderMessage];
    commitDisplayMessagesToStore(targetThreadId);
    activeAgentMessageId.value = assistantMessageId;
    activeAbortController.value = new AbortController();
    const requestAbortController = activeAbortController.value;

    const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {
      if (requestAbortController.signal.aborted) {
        return;
      }
      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));
      applySidecarLiveEventsToAgentMessage(
        assistantMessageId,
        targetThreadId,
        initialActivityText,
        events,
      );
    });
    let sidecarStream: Awaited<ReturnType<typeof subscribeSidecarStreamWithPrebuffer>> | null =
      null;

    try {
      sidecarStream = await subscribeSidecarStreamWithPrebuffer((event) => {
        if (requestAbortController.signal.aborted) {
          return;
        }
        liveEventBuffer.push(event);
      });

      const result = await aiService.sidecarExternalChat({
        backend,
        text: messageContent,
        workspaceRootPath: options.workspaceRootPath.value,
        ...(targetThreadId ? { threadId: targetThreadId } : {}),
      });

      sidecarStream.bind(result.sessionId);
      liveEventBuffer.flush();

      if (!requestAbortController.signal.aborted) {
        const currentMessage = findMessageById(assistantMessageId);
        updateAgentExecutionMessage({
          messageId: assistantMessageId,
          content: currentMessage?.content ?? '',
          toolCalls: currentMessage?.toolCalls ?? [],
          streamStatus: 'completed',
          finalAnswerStarted: hasMeaningfulAssistantText(currentMessage?.content),
        });
        commitDisplayMessagesToStore(targetThreadId);
      }

      if (!errorMessage.value) {
        clearAttachedFiles({ revokePreviews: false });
      }
    } catch (error) {
      if (requestAbortController.signal.aborted) {
        disposeSidecarAnswerStream(assistantMessageId);
      } else {
        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));
      }
    } finally {
      liveEventBuffer.dispose();
      sidecarStream?.dispose();
      activeAbortController.value = null;
      activeAgentMessageId.value = null;
      commitDisplayMessagesToStore(targetThreadId);
      clearActiveBufferedThread(targetThreadId);
      isSending.value = false;
      syncDisplayMessagesFromActiveThread();
    }
  };

  const executeAiRequest = async (`,
      'const executeAiRequest = async (',
    ],
    [
      `  const sendMessage = async (): Promise<void> => {
    const content = draft.value.trim();`,
      `  const sendMessage = async (sendOptions?: {
    agentBackend?: TAgentBackendKind;
  }): Promise<void> => {
    const content = draft.value.trim();`,
      'const sendMessage = async (',
    ],
    [
      `    messages.value = nextMessages;
    clearAttachedFiles({ revokePreviews: false });

    if (activeMode.value === 'agent') {`,
      `    messages.value = nextMessages;
    clearAttachedFiles({ revokePreviews: false });

    // 外部 ACP 编码 agent（Kimi / Codex）走独立发送链路，与 activeMode（chat/agent/plan）无关：
    // 外部 agent 自管会话与运行循环，不复用自研边车的 mode 分流。
    const externalBackend = sendOptions?.agentBackend;
    if (externalBackend && externalBackend !== 'builtin') {
      await executeExternalAgentRequest(
        externalBackend,
        nextMessages,
        messageContent,
        titleThreadId,
      );

      if (!errorMessage.value) {
        void maybeGenerateConversationTitle(titleThreadId);
      }

      return;
    }

    if (activeMode.value === 'agent') {`,
      "if (activeMode.value === 'agent') {",
    ],
  ],
);

/* 4) src/components/business/ai/shell/AiAssistantPanel.vue —— 拆闸 + 传 backend */
patchFile(
  'src/components/business/ai/shell/AiAssistantPanel.vue',
  'sendMessage({ agentBackend',
  [
    [
      `// 当前会话使用的 Agent 后端（自研 / Kimi）。会话级单选，一个会话只用一种 Agent。
// 注意：Kimi 等外部 Agent 的实际发送链路依赖自动生成的 Tauri 绑定
// agentSidecarExternalChat（由 tauri-specta 在本地构建时重新导出后才可用），
// 打通前此处先接住选择态。
type TSessionAgentBackend = 'builtin' | 'kimi';`,
      `// 当前会话使用的 Agent 后端（自研 / Kimi）。会话级单选，一个会话只用一种 Agent。
// Kimi 等外部 Agent 经 agent_sidecar_external_chat（标准 session/prompt）发送，由
// useAiAssistant.sendMessage 据此 backend 分流到外部 ACP 发送链路。
type TSessionAgentBackend = 'builtin' | 'kimi';`,
      'type TSessionAgentBackend',
    ],
    [
      `const handleSuggestionSelect = async (suggestion: string): Promise<void> => {
  if (assistant.isSending.value) {
    return;
  }

  // Kimi 等外部 Agent 尚未接入发送链路，不静默走自研 Agent。
  if (sessionAgentBackend.value !== 'builtin') {
    assistant.error.value = 'Kimi Agent 接入开发中，当前请切换回「自研 Agent」后再发送。';
    return;
  }

  assistant.draft.value = suggestion;
  await assistant.sendMessage();
};`,
      `const handleSuggestionSelect = async (suggestion: string): Promise<void> => {
  if (assistant.isSending.value) {
    return;
  }

  assistant.draft.value = suggestion;
  await assistant.sendMessage({ agentBackend: sessionAgentBackend.value });
};`,
      'handleSuggestionSelect',
    ],
    [
      `const handleSubmitMessage = async (): Promise<void> => {
  if (!assistant.draft.value.trim() || assistant.isSending.value) {
    return;
  }

  // Kimi 等外部 Agent CLI 的发送链路尚未接入（依赖自动生成的
  // agentSidecarExternalChat 绑定与发送管线集成）；在打通前不静默走自研
  // Agent，而是明确提示用户切回自研 Agent。
  if (sessionAgentBackend.value !== 'builtin') {
    assistant.error.value = 'Kimi Agent 接入开发中，当前请切换回「自研 Agent」后再发送。';
    return;
  }

  await assistant.sendMessage();
};`,
      `const handleSubmitMessage = async (): Promise<void> => {
  if (!assistant.draft.value.trim() || assistant.isSending.value) {
    return;
  }

  await assistant.sendMessage({ agentBackend: sessionAgentBackend.value });
};`,
      'handleSubmitMessage',
    ],
  ],
);

/* 5) src/components/business/ai/chat/AiPromptInput.vue —— 渲染 errorMessage */
patchFile(
  'src/components/business/ai/chat/AiPromptInput.vue',
  'ai-prompt-error',
  [
    [
      `      <InputGroup class="ai-prompt-shell">`,
      `      <p v-if="errorMessage" class="ai-prompt-error" role="alert" v-text="errorMessage"></p>
      <InputGroup class="ai-prompt-shell">`,
      'ai-prompt-shell',
    ],
    [
      `.ai-attachments {
  min-width: 0;
  padding: 0 2px;
}`,
      `.ai-attachments {
  min-width: 0;
  padding: 0 2px;
}

.ai-prompt-error {
  margin: 0 2px;
  padding: 6px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
  font-size: 12px;
  line-height: 1.5;
}`,
      '.ai-attachments',
    ],
  ],
);
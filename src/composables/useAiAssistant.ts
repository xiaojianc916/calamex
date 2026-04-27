import { useAiStream } from '@/composables/useAiStream';
import { aiService } from '@/services/modules/ai';
import {
  buildActiveRunReference,
  buildCurrentFileReference,
  buildDiagnosticsReference,
  buildGitDiffReference,
  buildSelectionReference,
} from '@/services/modules/ai-context';
import type {
  IAiChatMessage,
  IAiConfigPayload,
  IAiContextReference,
  IAiPatchSet,
  IAiTaskPlanStep,
  IAiToolDefinitionPayload,
} from '@/types/ai';
import type {
  IAiCodeBlock,
} from '@/types/ai-code';
import type {
  IActiveRunSummary,
  IAnalyzeScriptPayload,
  IEditorDocument,
  IEditorSelectionSummary,
} from '@/types/editor';
import type { IGitRepositoryStatusPayload } from '@/types/git';
import { toErrorMessage } from '@/utils/error';
import { computed, ref, type Ref } from 'vue';

type TAiQuickActionId = 'explain' | 'fix' | 'review';
type TAiAssistantMode = 'chat' | 'agent';

export interface IAiAttachedFile {
  id: string;
  name: string;
  sizeLabel: string;
  reference: IAiContextReference;
}

export interface IAiQuickAction {
  id: TAiQuickActionId;
  label: string;
}

export interface IUseAiAssistantOptions {
  document: Ref<IEditorDocument>;
  activeRun: Ref<IActiveRunSummary | null>;
  analysis: Ref<IAnalyzeScriptPayload>;
  selection: Ref<IEditorSelectionSummary | null>;
  gitStatus: Ref<IGitRepositoryStatusPayload>;
  workspaceRootPath: Ref<string | null>;
}

const MAX_CONTEXT_CHARS = 12_000;
const MAX_ATTACHMENT_BYTES = 128 * 1024;
const TEXT_ATTACHMENT_PATTERN =
  /^(application\/(json|xml|x-sh|x-shellscript|javascript|typescript)|text\/)/i;
const TEXT_ATTACHMENT_EXTENSION_PATTERN =
  /\.(bash|cjs|conf|css|csv|env|js|json|jsx|log|md|mjs|ps1|py|rs|sh|sql|toml|ts|tsx|txt|vue|xml|yaml|yml|zsh)$/i;
const CONTEXT_TOKEN_PATTERN =
  /(^|\s)@(file|current-file|selection|terminal|log|diagnostics|shellcheck|git-diff|git|project|folder|search|symbol)(?=\s|$)/gi;

const createMessageId = (role: IAiChatMessage['role']): string =>
  `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const clipText = (value: string, limit: number): string => {
  const chars = [...value];
  if (chars.length <= limit) return value;
  return `${chars.slice(0, limit).join('')}\n\n[内容已截断，仅发送前 ${limit} 个字符]`;
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const isTextAttachment = (file: File): boolean =>
  TEXT_ATTACHMENT_PATTERN.test(file.type) || TEXT_ATTACHMENT_EXTENSION_PATTERN.test(file.name);

export const AI_QUICK_ACTIONS: IAiQuickAction[] = [
  { id: 'explain', label: '解释当前脚本' },
  { id: 'fix', label: '修复报错' },
  { id: 'review', label: '代码审查' },
];

export const useAiAssistant = (options: IUseAiAssistantOptions) => {
  const config = ref<IAiConfigPayload>({
    providerType: 'mock',
    selectedModel: 'mock-ide-assistant',
    baseUrl: null,
    isBaseUrlConfigured: false,
    hasCredentials: false,
    isConfigured: true,
    inlineCompletionEnabled: false,
    chatEnabled: true,
    agentEnabled: false,
  });
  const messages = ref<IAiChatMessage[]>([]);
  const draft = ref('');
  const isSending = ref(false);
  const errorMessage = ref('');
  const isSettingsOpen = ref(false);
  const isClearDialogOpen = ref(false);
  const currentReferences = ref<IAiContextReference[]>([]);
  const proposedPatch = ref<IAiPatchSet | null>(null);
  const isApplyingPatch = ref(false);
  const activeMode = ref<TAiAssistantMode>('chat');
  const agentSteps = ref<IAiTaskPlanStep[]>([]);
  const toolDefinitions = ref<IAiToolDefinitionPayload[]>([]);
  const attachedFiles = ref<IAiAttachedFile[]>([]);
  const activeAbortController = ref<AbortController | null>(null);
  const activeStreamId = ref<string | null>(null);
  const activeStreamResolve = ref<(() => void) | null>(null);
  const activeAssistantMessage = ref<IAiChatMessage | null>(null);
  const activeAssistantBaseMessages = ref<IAiChatMessage[]>([]);
  const aiStream = useAiStream();

  const providerLabel = computed(() =>
    config.value.chatEnabled
      ? `${config.value.providerType} · ${config.value.selectedModel ?? 'mock-ide-assistant'}`
      : '未启用 Chat',
  );
  const sendButtonLabel = computed(() => (isSending.value ? '发送中…' : '发送'));
  const latestAssistantCodeBlock = computed(() => {
    const message = [...messages.value].reverse().find((item) => item.role === 'assistant');
    const match = message?.content.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
    return match?.[1] ?? '';
  });
  const canPreviewPatch = computed(() => {
    const document = options.document.value;
    return Boolean(document.path && document.kind === 'text' && latestAssistantCodeBlock.value.trim());
  });

  const buildDocumentContext = (): string => {
    const document = options.document.value;
    if (!document.id || document.kind !== 'text') {
      return '当前没有可用的文本脚本文档。';
    }

    return [
      `文件名：${document.name}`,
      `路径：${document.path ?? '未保存'}`,
      `状态：${document.isDirty ? '有未保存修改' : '已保存'}`,
      '脚本内容：',
      '```sh',
      clipText(document.content, MAX_CONTEXT_CHARS),
      '```',
    ].join('\n');
  };

  const buildRunContext = (): string => {
    const activeRun = options.activeRun.value;
    if (!activeRun) return '当前没有正在运行或最近触发的运行记录。';
    return [
      `运行文件：${activeRun.documentName}`,
      `命令：${activeRun.commandLine}`,
      `执行器：${activeRun.executorLabel}`,
      `开始时间：${activeRun.startedAt}`,
      `临时文件：${activeRun.usedTempFile ? '是' : '否'}`,
    ].join('\n');
  };

  const buildQuickPrompt = (actionId: TAiQuickActionId): string => {
    const documentContext = buildDocumentContext();
    if (actionId === 'explain') {
      return `请解释当前脚本的执行流程、关键变量、外部依赖和潜在风险。\n\n${documentContext}`;
    }
    if (actionId === 'fix') {
      return `请根据当前脚本和运行上下文定位问题根因，并给出最小修改方案。如果上下文不足，请列出还需要哪些信息。\n\n${documentContext}\n\n运行上下文：\n${buildRunContext()}`;
    }
    return `请按安全、参数可靠性、可维护性、边界条件和可验证性审查当前脚本。请只给出基于代码能确认的问题。\n\n${documentContext}`;
  };

  const resolveContextTokens = (prompt: string): Set<string> => {
    const tokens = new Set<string>();
    for (const match of prompt.matchAll(CONTEXT_TOKEN_PATTERN)) {
      const token = match[2]?.toLowerCase();
      if (token) {
        tokens.add(token);
      }
    }
    return tokens;
  };

  const shouldIncludeReference = (
    tokens: Set<string>,
    aliases: readonly string[],
  ): boolean => tokens.size === 0 || aliases.some((alias) => tokens.has(alias));

  const buildProjectSearchReference = async (prompt: string): Promise<IAiContextReference | null> => {
    const tokens = resolveContextTokens(prompt);
    const shouldSearchProject = ['project', 'folder', 'search', 'symbol'].some((item) =>
      tokens.has(item),
    );
    const workspaceRootPath = options.workspaceRootPath.value;
    if (!shouldSearchProject || !workspaceRootPath) {
      return null;
    }

    const query = prompt
      .replace(CONTEXT_TOKEN_PATTERN, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (!query) {
      return null;
    }

    const payload = await aiService.queryIndex({
      workspaceRootPath,
      query,
      limit: 8,
    });
    if (payload.results.length === 0) {
      return null;
    }

    return {
      id: `search-result:${workspaceRootPath}:${query}`,
      kind: 'search-result',
      label: `项目搜索 · ${query}`,
      path: workspaceRootPath,
      range: null,
      contentPreview: payload.results
        .map((item) => `${item.path}${item.lineNumber ? `:${item.lineNumber}` : ''}\n${item.preview}`)
        .join('\n---\n'),
      redacted: false,
    };
  };

  const buildReferences = async (prompt = ''): Promise<IAiContextReference[]> => {
    const tokens = resolveContextTokens(prompt);
    const currentFile = buildCurrentFileReference(options.document.value);
    const selection = buildSelectionReference(options.selection.value, options.document.value);
    const activeRun = buildActiveRunReference(options.activeRun.value);
    const diagnostics = buildDiagnosticsReference(options.analysis.value, options.document.value);
    const gitDiff = buildGitDiffReference(options.gitStatus.value);
    const projectSearch = await buildProjectSearchReference(prompt).catch(() => null);
    const candidates: Array<[IAiContextReference | null, readonly string[]]> = [
      [currentFile, ['file', 'current-file']],
      [selection, ['selection']],
      [activeRun, ['terminal', 'log']],
      [diagnostics, ['diagnostics', 'shellcheck']],
      [gitDiff, ['git-diff', 'git']],
      [projectSearch, ['project', 'folder', 'search', 'symbol']],
    ];

    const references = candidates
      .filter(([, aliases]) => shouldIncludeReference(tokens, aliases))
      .map(([reference]) => reference)
      .filter((item): item is IAiContextReference => item !== null);
    return [...references, ...attachedFiles.value.map((file) => file.reference)];
  };

  const loadConfig = async (): Promise<void> => {
    config.value = await aiService.getConfig();
  };

  const loadTools = async (): Promise<void> => {
    toolDefinitions.value = await aiService.listTools();
  };

  const saveConfig = async (nextConfig: IAiConfigPayload): Promise<void> => {
    config.value = await aiService.saveConfig({
      providerType: nextConfig.providerType,
      selectedModel: nextConfig.selectedModel,
      baseUrl: nextConfig.baseUrl,
      inlineCompletionEnabled: nextConfig.inlineCompletionEnabled,
      chatEnabled: nextConfig.chatEnabled,
      agentEnabled: nextConfig.agentEnabled,
    });
    isSettingsOpen.value = false;
  };

  const saveCredentials = async (
    apiKey: string,
    providerType = config.value.providerType,
  ): Promise<void> => {
    config.value = await aiService.saveCredentials({
      providerType,
      apiKey,
    });
  };

  const testProvider = async (): Promise<string> => {
    const result = await aiService.testProvider();
    if (!result.ok) {
      errorMessage.value = result.message;
    }
    return result.message;
  };

  const applyQuickAction = (action: IAiQuickAction): void => {
    draft.value = buildQuickPrompt(action.id);
    void buildReferences(draft.value).then((references) => {
      currentReferences.value = references;
    });
    errorMessage.value = '';
  };

  const attachFile = async (file: File): Promise<void> => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      errorMessage.value = `附件超过 ${formatBytes(MAX_ATTACHMENT_BYTES)}，请先拆分或只粘贴关键片段。`;
      return;
    }
    if (!isTextAttachment(file)) {
      errorMessage.value = '当前只支持把文本类文件作为 AI 上下文附件。';
      return;
    }

    const content = await file.text().catch((): null => null);
    if (content === null) {
      errorMessage.value = '读取附件失败，请确认文件可访问后重试。';
      return;
    }
    const id = `attachment:${file.name}:${file.lastModified}:${file.size}`;
    const reference: IAiContextReference = {
      id,
      kind: 'search-result',
      label: `附件 · ${file.name}`,
      path: file.name,
      range: null,
      contentPreview: [
        `文件名：${file.name}`,
        `大小：${formatBytes(file.size)}`,
        '内容：',
        clipText(content, MAX_CONTEXT_CHARS),
      ].join('\n'),
      redacted: false,
    };
    attachedFiles.value = [
      ...attachedFiles.value.filter((item) => item.id !== id),
      {
        id,
        name: file.name,
        sizeLabel: formatBytes(file.size),
        reference,
      },
    ];
    currentReferences.value = await buildReferences(draft.value);
    errorMessage.value = '';
  };

  const removeAttachedFile = (id: string): void => {
    attachedFiles.value = attachedFiles.value.filter((item) => item.id !== id);
    void buildReferences(draft.value).then((references) => {
      currentReferences.value = references;
    });
  };

  const sendMessage = async (): Promise<void> => {
    const content = draft.value.trim();
    if ((!content && attachedFiles.value.length === 0) || isSending.value) return;
    if (!config.value.chatEnabled) {
      errorMessage.value = '请先启用 AI Chat。';
      isSettingsOpen.value = true;
      return;
    }
    if (!config.value.isConfigured) {
      errorMessage.value = 'AI Provider 还没配置完整，请先保存当前厂商配置和 API Key。';
      isSettingsOpen.value = true;
      return;
    }

    const messageContent = content || '请分析我添加的附件内容。';
    const references = await buildReferences(messageContent);
    currentReferences.value = references;

    if (activeMode.value === 'agent') {
      await planAgentTask(messageContent, references);
      return;
    }

    const userMessage: IAiChatMessage = {
      id: createMessageId('user'),
      role: 'user',
      content: messageContent,
      createdAt: new Date().toISOString(),
      references,
    };
    const nextMessages = [...messages.value, userMessage];
    messages.value = nextMessages;
    draft.value = '';
    errorMessage.value = '';
    isSending.value = true;
    const assistantMessage: IAiChatMessage = {
      id: createMessageId('assistant'),
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      references: [],
      stream: {
        stableContent: '',
        openBlock: null,
        status: 'streaming',
      },
    };
    activeAssistantMessage.value = assistantMessage;
    activeAssistantBaseMessages.value = nextMessages;
    messages.value = [...nextMessages, assistantMessage];

    let unlisten: (() => void) | null = null;
    let pendingDelta = '';
    let animationFrameId: number | null = null;
    let isStreamClosed = false;
    let hasStartedStream = false;
    let hasSettledStream = false;

    const settleAssistantStream = (): void => {
      hasSettledStream = true;
      activeStreamResolve.value?.();
    };

    const startAssistantStream = (streamId: string, assistantMessageId: string): void => {
      if (hasStartedStream) return;
      hasStartedStream = true;
      activeStreamId.value = streamId;
      assistantMessage.id = assistantMessageId;
      aiStream.start({ messageId: assistantMessageId });
      syncAssistantMessage();
    };

    const syncAssistantMessage = (): void => {
      const currentAssistantMessage = activeAssistantMessage.value;
      if (!currentAssistantMessage) return;
      currentAssistantMessage.content = aiStream.content.value;
      currentAssistantMessage.stream = {
        stableContent: aiStream.stableContent.value,
        openBlock: aiStream.openCodeBlock.value,
        status: aiStream.status.value === 'cancelled'
          ? 'cancelled'
          : aiStream.status.value === 'completed'
            ? 'completed'
            : 'streaming',
      };
      messages.value = [...activeAssistantBaseMessages.value, { ...currentAssistantMessage }];
    };

    const flushPendingDelta = (): void => {
      animationFrameId = null;
      if (!pendingDelta || isStreamClosed) return;
      const chunk = pendingDelta;
      pendingDelta = '';
      aiStream.append(chunk);
      syncAssistantMessage();
    };

    const scheduleDelta = (delta: string): void => {
      if (isStreamClosed) return;
      pendingDelta += delta;
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(flushPendingDelta);
    };

    try {
      unlisten = await aiService.onChatStream((event) => {
        if (!activeStreamId.value && event.kind === 'start') {
          startAssistantStream(event.streamId, event.assistantMessageId);
          return;
        }
        if (event.streamId !== activeStreamId.value) return;
        if (event.kind === 'delta' && event.delta) {
          scheduleDelta(event.delta);
          return;
        }
        if (animationFrameId !== null) {
          window.cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
        flushPendingDelta();
        isStreamClosed = true;
        if (event.kind === 'done') {
          aiStream.complete();
          syncAssistantMessage();
          attachedFiles.value = [];
          settleAssistantStream();
          return;
        }
        if (event.kind === 'cancelled') {
          aiStream.stop();
          syncAssistantMessage();
          errorMessage.value = event.message ?? 'AI ??????';
          settleAssistantStream();
          return;
        }
        if (event.kind === 'error') {
          aiStream.stop();
          syncAssistantMessage();
          errorMessage.value = event.message ?? 'AI ?????';
          draft.value = messageContent;
          settleAssistantStream();
        }
      });

      const stream = await aiService.chatStream({ threadId: null, messages: nextMessages, references });
      startAssistantStream(stream.streamId, stream.assistantMessageId);

      await new Promise<void>((resolve) => {
        if (hasSettledStream) {
          resolve();
          return;
        }
        activeStreamResolve.value = resolve;
      });
    } catch (error) {
      errorMessage.value = toErrorMessage(error, 'AI ????');
      draft.value = messageContent;
    } finally {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      unlisten?.();
      activeStreamResolve.value = null;
      activeStreamId.value = null;
      activeAbortController.value = null;
      activeAssistantMessage.value = null;
      activeAssistantBaseMessages.value = [];
      isSending.value = false;
    }
  };

  const planAgentTask = async (
    goal: string,
    references: IAiContextReference[],
  ): Promise<void> => {
    if (!config.value.agentEnabled) {
      errorMessage.value = '请先在 AI 设置中启用 Agent。';
      isSettingsOpen.value = true;
      return;
    }

    const userMessage: IAiChatMessage = {
      id: createMessageId('user'),
      role: 'user',
      content: goal,
      createdAt: new Date().toISOString(),
      references,
    };
    messages.value = [...messages.value, userMessage];
    draft.value = '';
    errorMessage.value = '';
    isSending.value = true;

    try {
      const payload = await aiService.planTask({ goal, context: references });
      agentSteps.value = payload.steps;
      const summary = payload.steps
        .map((step, index) => `${index + 1}. ${step.title}（${step.status}）`)
        .join('\n');
      messages.value = [
        ...messages.value,
        {
          id: createMessageId('assistant'),
          role: 'assistant',
          content: `Agent 已生成受控执行计划。写文件、运行命令、Git 操作都需要你确认。\n\n${summary}`,
          createdAt: new Date().toISOString(),
          references: [],
        },
      ];
      attachedFiles.value = [];
    } catch (error) {
      errorMessage.value = toErrorMessage(error, 'Agent 规划失败');
      draft.value = goal;
    } finally {
      isSending.value = false;
    }
  };

  const clearConversation = (): void => {
    messages.value = [];
    currentReferences.value = [];
    proposedPatch.value = null;
    agentSteps.value = [];
    attachedFiles.value = [];
    errorMessage.value = '';
    activeAssistantMessage.value = null;
    activeAssistantBaseMessages.value = [];
    isClearDialogOpen.value = false;
  };

  const previewPatchFromLastAnswer = async (): Promise<void> => {
    const document = options.document.value;
    const updatedContent = latestAssistantCodeBlock.value;
    if (!document.path || document.kind !== 'text' || !updatedContent.trim()) {
      errorMessage.value = '没有可预览的代码块，或当前文件尚未保存。';
      return;
    }
    const payload = await aiService.proposePatch({
      path: document.path,
      originalContent: document.content,
      updatedContent,
      summary: '应用 AI 回复中的代码块',
    });
    proposedPatch.value = payload.patch;
    errorMessage.value = '';
  };

  const previewPatchFromCodeBlock = async (block: IAiCodeBlock): Promise<void> => {
    const document = options.document.value;
    if (!document.path || document.kind !== 'text') {
      errorMessage.value = '当前文件尚未保存，无法生成 Patch 预览。';
      return;
    }
    if (block.fence.meta.filePath && block.fence.meta.filePath !== document.path) {
      errorMessage.value = '代码块目标文件不是当前文件，暂不能直接生成 Patch 预览。';
      return;
    }
    if (!block.content.trim()) {
      errorMessage.value = '代码块内容为空，无法生成 Patch 预览。';
      return;
    }

    try {
      const payload = await aiService.proposePatch({
        path: document.path,
        originalContent: document.content,
        updatedContent: block.content,
        summary: '应用 AI 代码块',
      });
      proposedPatch.value = payload.patch;
      errorMessage.value = '';
    } catch (error) {
      errorMessage.value = toErrorMessage(error, 'Patch 预览失败');
    }
  };

  const applyProposedPatch = async (): Promise<void> => {
    if (!proposedPatch.value || isApplyingPatch.value) return;
    isApplyingPatch.value = true;
    try {
      const result = await aiService.applyPatch({ patch: proposedPatch.value });
      messages.value = [
        ...messages.value,
        {
          id: createMessageId('assistant'),
          role: 'assistant',
          content: `Patch 已应用：${result.appliedFiles.map((file) => file.path).join('、')}`,
          createdAt: new Date().toISOString(),
          references: [],
        },
      ];
      proposedPatch.value = null;
      errorMessage.value = '';
    } catch (error) {
      errorMessage.value = toErrorMessage(error, 'Patch 应用失败');
    } finally {
      isApplyingPatch.value = false;
    }
  };

  const stopCurrentRequest = (): void => {
    const streamId = activeStreamId.value;
    if (streamId) {
      void aiService.cancel({ streamId });
    }
    activeAbortController.value?.abort();
    activeAbortController.value = null;
    activeStreamId.value = null;
    activeStreamResolve.value?.();
    activeStreamResolve.value = null;
    aiStream.stop();
    if (activeAssistantMessage.value) {
      activeAssistantMessage.value.stream = {
        stableContent: aiStream.stableContent.value,
        openBlock: aiStream.openCodeBlock.value,
        status: 'cancelled',
      };
      activeAssistantMessage.value.content = aiStream.content.value;
      messages.value = [...activeAssistantBaseMessages.value, { ...activeAssistantMessage.value }];
    }
    isSending.value = false;
    errorMessage.value = 'AI ??????';
  };

  return {
    config,
    messages,
    draft,
    isSending,
    errorMessage,
    isSettingsOpen,
    isClearDialogOpen,
    currentReferences,
    proposedPatch,
    isApplyingPatch,
    activeMode,
    agentSteps,
    toolDefinitions,
    attachedFiles,
    providerLabel,
    sendButtonLabel,
    canPreviewPatch,
    loadConfig,
    loadTools,
    saveConfig,
    saveCredentials,
    testProvider,
    applyQuickAction,
    attachFile,
    removeAttachedFile,
    sendMessage,
    stopCurrentRequest,
    previewPatchFromLastAnswer,
    previewPatchFromCodeBlock,
    applyProposedPatch,
    clearConversation,
  };
};

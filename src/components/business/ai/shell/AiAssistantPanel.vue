<script setup lang="ts">
import { useFrontendTool } from '@copilotkit/vue';
import { Bot, SquarePen, Trash2 } from '@lucide/vue';
import { AnimatePresence, Motion } from 'motion-v';
import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
import { z } from 'zod';
import QuestionPrompt from '@/components/ai-elements/question/QuestionPrompt.vue';
import AiChatThread from '@/components/business/ai/chat/AiChatThread.vue';
import AiErrorNotice from '@/components/business/ai/chat/AiErrorNotice.vue';
import AiPromptInput from '@/components/business/ai/chat/AiPromptInput.vue';
import AiProviderIcon from '@/components/business/ai/provider/AiProviderIcon.vue';
import AiAssistantCheckpointEntry from '@/components/business/ai/shell/AiAssistantCheckpointEntry.vue';
import AiAssistantSuggestionEmpty from '@/components/business/ai/shell/AiAssistantSuggestionEmpty.vue';
import AiPanelFrame from '@/components/business/ai/shell/AiPanelFrame.vue';
import { splitSuggestionsIntoRows } from '@/components/business/ai/shell/split-suggestions';
import AiThreadRunStatusBar from '@/components/business/ai/thread/AiThreadRunStatusBar.vue';
import {
  buildPlanControlMessage,
  deriveThreadPlanDetails,
} from '@/components/business/ai/thread/projection';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { useAiAgentNetwork } from '@/composables/ai/useAiAgentNetwork';
import { useAiAgentRun } from '@/composables/ai/useAiAgentRun';
import { useAiAssistant } from '@/composables/ai/useAiAssistant';
import { useAiConversationCheckpoints } from '@/composables/ai/useAiConversationCheckpoints';
import { useAiConversationHistory } from '@/composables/ai/useAiConversationHistory';
import { useAiTokenContext } from '@/composables/ai/useAiTokenContext';
import { useAiWebSources } from '@/composables/ai/useAiWebSources';
import { useCopilotContext } from '@/composables/ai/useCopilotContext';
import { useCopilotSuggestions } from '@/composables/ai/useCopilotSuggestions';
import { findAiServicePlatformByModel } from '@/constants/ai/providers';
import { aiService } from '@/services/ipc/ai.service';
import { cloneAiConfigPayload, resolveDefaultAiBaseUrl } from '@/services/ipc/ai-config.service';
import { useAiThreadStore } from '@/store/aiThread';
import type {
  IAiAgentRun,
  IAiAgentStepFinalAnswer,
  IAiChatMessage,
  IAiConfigPayload,
  IAiProviderSettingsActionFeedback,
  IAiTaskPlanStep,
  IAiToolActivityInline,
  IAiToolCall,
  TAiAgentNetworkPermission,
  TAiModelRole,
  TAiToolConfirmationDecision,
} from '@/types/ai';
import type { TAiExecutionMode } from '@/types/ai/execution-mode';
import type { IAskUserResult } from '@/types/ai/sidecar';
import type {
  IActiveRunSummary,
  IAnalyzeScriptPayload,
  IEditorDocument,
  IEditorSelectionSummary,
} from '@/types/editor';
import type { IGitDiffPreviewPayload, IGitRepositoryStatusPayload } from '@/types/git';
import { toErrorMessage } from '@/utils/error/error';
import { markStartup } from '@/utils/platform/startup-profiler';

const props = defineProps<{
  document: IEditorDocument;
  activeRun: IActiveRunSummary | null;
  analysis: IAnalyzeScriptPayload;
  selection: IEditorSelectionSummary | null;
  gitStatus: IGitRepositoryStatusPayload;
  workspaceRootPath: string | null;
}>();

defineEmits<{
  'open-patch-diff': [payload: IGitDiffPreviewPayload];
}>();

const DeferredAiProviderSettings = defineAsyncComponent({
  loader: () => import('@/components/business/ai/provider/AiProviderSettings.vue'),
  suspensible: false,
});

const DeferredAiWebSourcesPanel = defineAsyncComponent({
  loader: () => import('@/components/business/ai/web/AiWebSourcesPanel.vue'),
  suspensible: false,
});

// 启动打点（阶段0·量化）：AI 面板真身 setup 起点，用于定位首屏耗时分布。
markStartup('ai-assistant-panel-setup-start');
const documentRef = computed(() => props.document);
const activeRunRef = computed(() => props.activeRun);
const analysisRef = computed(() => props.analysis);
const selectionRef = computed(() => props.selection);
const gitStatusRef = computed(() => props.gitStatus);
const workspaceRootPathRef = computed(() => props.workspaceRootPath);
const assistant = useAiAssistant({
  document: documentRef,
  activeRun: activeRunRef,
  analysis: analysisRef,
  selection: selectionRef,
  gitStatus: gitStatusRef,
  workspaceRootPath: workspaceRootPathRef,
});
const agentRun = useAiAgentRun();
const agentNetwork = useAiAgentNetwork();
const webSources = useAiWebSources();
const aiThreadStore = useAiThreadStore();
const renderThreadEntries = computed(() => aiThreadStore.activeEntries);
const suggestionPool = useCopilotSuggestions();
const suggestionRows = computed(() =>
  splitSuggestionsIntoRows(suggestionPool.suggestions.value, 3),
);

useCopilotContext({
  document: documentRef,
  activeRun: activeRunRef,
  analysis: analysisRef,
  selection: selectionRef,
  gitStatus: gitStatusRef,
  workspaceRootPath: workspaceRootPathRef,
});

try {
  useFrontendTool({ name: '*', parameters: z.looseObject({}), handler: async () => 'ok' });
} catch {
  /* provider not ready */
}

const settingsDraft = ref<IAiConfigPayload>(cloneAiConfigPayload(assistant.config.value));
const settingsApiKey = ref('');
const settingsTavilyApiKey = ref('');
const isAgentRunActionPending = ref(false);
const isPromptModelSaving = ref(false);

// 当前会话使用的 Agent 后端（自研 / Kimi）。会话级单选，一个会话只用一种 Agent。
// Kimi 等外部 Agent 经 agent_sidecar_external_chat（标准 session/prompt）发送，由
// useAiAssistant.sendMessage 据此 backend 分流到外部 ACP 发送链路。
type TSessionAgentBackend = 'builtin' | 'kimi';

interface ISessionAgentOption {
  key: TSessionAgentBackend;
  label: string;
}

const agentOptions: ISessionAgentOption[] = [
  { key: 'builtin', label: 'Calamex Agent' },
  { key: 'kimi', label: 'Kimi Code' },
];

const sessionAgentBackend = ref<TSessionAgentBackend>('kimi');

// 各 Agent 的会话级模型记忆：
// - builtin 直接复用 ai.json 的全局 selectedModel（保留既有持久化与 mastra 运行时语义）。
// - 其它 Agent（如 kimi）在此各记一份，互不影响；切它们的模型不会触碰 builtin 的全局模型。
// - 未记忆过的 Agent 回退到当前选中模型（config.selectedModel），即「默认用当前模型」。
// - 按 key 存的 Record：未来接入新 Agent 自动获得隔离 + 默认回退，无需改这里。
const agentModelOverrides = ref<Record<string, string>>({});

const activeAgentModelId = computed<string>(() => {
  const globalModel = assistant.config.value.selectedModel?.trim() ?? '';
  const agent = sessionAgentBackend.value;
  if (agent === 'builtin') {
    return globalModel;
  }
  const remembered = agentModelOverrides.value[agent]?.trim();
  return remembered || globalModel;
});

const selectedAgentOption = computed(
  () => agentOptions.find((option) => option.key === sessionAgentBackend.value) ?? agentOptions[0],
);

const isSessionAgentBackend = (value: unknown): value is TSessionAgentBackend =>
  value === 'builtin' || value === 'kimi';

const {
  isHistoryOpen,
  historyAnchorRef,
  historyPopoverRef,
  historyThreads,
  hasMoreHistoryThreads,
  activeHistoryThread,
  getHistoryMessageCountLabel,
  getHistoryTimestampLabel,
  deleteDialogTitle,
  deleteDialogDescription,
  toggleHistoryPopover,
  closeHistory,
  handleHistoryScroll,
  startNewConversation,
  openHistoryThread,
  openDeleteConversationDialog,
  cancelClearConversation,
  confirmClearConversation,
} = useAiConversationHistory(assistant);
const {
  isConversationCheckpointDisabled,
  getConversationCheckpoint,
  isConversationCheckpointRestoring,
  getConversationCheckpointLabel,
  handleRestoreConversationCheckpoint,
} = useAiConversationCheckpoints(assistant);

// 启动打点（阶段0·量化）：核心 composable 初始化完成。
markStartup('ai-assistant-panel-composables-ready');

const currentServicePlatform = computed(() =>
  findAiServicePlatformByModel(assistant.config.value.selectedModel),
);
const aiIconPlatformId = computed(() => currentServicePlatform.value.id);
const aiIconTitle = computed(() => currentServicePlatform.value.label);
const planStore = computed(() => assistant.agentPlan.store);

const planHasPlan = computed(() => planStore.value.hasPlan);
const planIsClassifying = computed(() => planStore.value.isClassifying);
const planIsPlanning = computed(() => planStore.value.isPlanning);
const planErrorMessage = computed(() => planStore.value.errorMessage);
const planIsApproving = computed(() => planStore.value.isApproving);
const planApprovedAt = computed(() => planStore.value.approvedAt);
const planSummary = computed(() => planStore.value.planSummary);
const planStatus = computed(() => planStore.value.planStatus);
const planId = computed(() => planStore.value.planId);
const planCreatedAt = computed(() => planStore.value.planCreatedAt);
const planActiveRun = computed<IAiAgentRun | null>(() => planStore.value.activeRun);
const planActiveToolActivity = computed<IAiToolActivityInline | null>(
  () => planStore.value.activeToolActivity,
);
const planPendingToolConfirmation = computed(() => planStore.value.pendingToolConfirmation);
const planPendingSidecarSession = computed(() => planStore.value.pendingSidecarAgentSession);
const visibleDirectToolConfirmation = computed(() => {
  const confirmation = planPendingToolConfirmation.value;

  if (!confirmation) {
    return null;
  }

  const session = planPendingSidecarSession.value;

  if (session?.threadId && session.threadId !== assistant.activeConversationId.value) {
    return null;
  }

  return confirmation;
});
const planPendingUserQuestion = computed(() => planStore.value.pendingUserQuestion);
const visibleUserQuestion = computed(() => {
  const question = planPendingUserQuestion.value;

  if (!question) {
    return null;
  }

  const session = planPendingSidecarSession.value;

  if (session?.threadId && session.threadId !== assistant.activeConversationId.value) {
    return null;
  }

  return question;
});
const isResolvingUserQuestion = ref(false);
const planSteps = computed<IAiTaskPlanStep[]>(() => planStore.value.steps);
const planActiveGoal = computed(() => planStore.value.activeGoal);
const planActiveRunId = computed<string | null>(() => planStore.value.activeRunId);
const networkPermission = computed(() => agentNetwork.store.networkPermission);
const executionMode = computed(() => planStore.value.executionMode);
const setPlanErrorMessage = (message: string): void => {
  planStore.value.errorMessage = message;
};
const hasPlannedAgentState = computed(
  () =>
    planHasPlan.value ||
    planIsClassifying.value ||
    planIsPlanning.value ||
    Boolean(planErrorMessage.value) ||
    Boolean(planId.value) ||
    Boolean(planStatus.value) ||
    Boolean(planActiveRun.value),
);
const isPlanConfirmationStatus = computed(
  () =>
    planStatus.value === 'pending_approval' ||
    planStatus.value === 'draft' ||
    planStatus.value === 'rejected' ||
    !planStatus.value,
);
const planConfirmationVisible = computed(() => {
  if (assistant.activeMode.value !== 'plan') {
    return false;
  }

  return (
    planSteps.value.length > 0 &&
    !planActiveRun.value &&
    !planApprovedAt.value &&
    isPlanConfirmationStatus.value
  );
});
// Plan 审批不再是输入框上方的独立面板，而是平铺时间线里的一条 plan-control 条目：
// 这里把它合成成一条 assistant 消息追加进可见时间线，运行态明细由投影层派生。
const planControlMessage = computed(() =>
  buildPlanControlMessage({
    goal: planActiveGoal.value,
    references: [],
    isAwaitingApproval: planConfirmationVisible.value,
    createdAt: planCreatedAt.value ?? new Date().toISOString(),
  }),
);
const threadPlanDetails = computed(() =>
  deriveThreadPlanDetails({
    summary: planSummary.value,
    status: planStatus.value,
    steps: planSteps.value,
    isPlanning: planIsPlanning.value,
    isApproving: planIsApproving.value,
    isClassifying: planIsClassifying.value,
    approvedAt: planApprovedAt.value,
    hasActiveRun: Boolean(planActiveRun.value),
  }),
);
// 运行进度/工具确认收敛到输入框上方的 Codex 风格细条；只在计划真正执行（有 run）或
// 出现工具确认时显示，用于抑制 Web 来源面板里重复的活动指示。
const planProgressVisible = computed(() => {
  if (assistant.activeMode.value !== 'plan') {
    return false;
  }

  return (
    Boolean(planActiveRun.value) ||
    Boolean(planActiveToolActivity.value) ||
    Boolean(planPendingToolConfirmation.value && planActiveRun.value) ||
    Boolean(planApprovedAt.value) ||
    planStatus.value === 'approved' ||
    planStatus.value === 'executing' ||
    planStatus.value === 'completed' ||
    planStatus.value === 'failed'
  );
});
const composerDisabled = computed(
  () =>
    assistant.isSending.value ||
    Boolean(visibleDirectToolConfirmation.value) ||
    Boolean(visibleUserQuestion.value),
);
const activePlanStep = computed(() => {
  const currentStepId = planActiveRun.value?.currentStepId;

  if (currentStepId) {
    return planSteps.value.find((step) => step.id === currentStepId) ?? null;
  }

  return planSteps.value.find((step) => step.isActive) ?? null;
});
const webSourcesVisible = computed(() => {
  if (assistant.activeMode.value === 'chat') {
    return false;
  }

  return (
    webSources.sources.value.length > 0 ||
    Boolean(webSources.activity.value) ||
    Boolean(webSources.errorMessage.value)
  );
});

const mapActivityToToolCallStatus = (
  state: IAiToolActivityInline['state'],
): IAiToolCall['status'] => {
  switch (state) {
    case 'starting':
    case 'running':
    case 'waiting-confirmation':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'denied';
    default:
      return 'running';
  }
};

const isLiveToolActivity = (activity: IAiToolActivityInline): boolean =>
  activity.state === 'starting' ||
  activity.state === 'running' ||
  activity.state === 'waiting-confirmation';

const normalizeToolActivitySummary = (activity: IAiToolActivityInline): string => {
  const source = activity.targetPreview?.trim() || activity.label.trim();
  const withoutEllipsis = source.replace(/…+$/u, '').trim();
  const withoutPrefix = withoutEllipsis
    .replace(/^正在(?:读取|搜索|加载|使用|应用|生成|验证|执行)\s*[：:：]?\s*/u, '')
    .replace(/^已(?:读取|搜索|加载|使用|应用|生成|验证|执行)\s*[：:：]?\s*/u, '')
    .trim();

  return withoutPrefix || withoutEllipsis || activity.toolName;
};

const buildAgentFlowToolCalls = (run: IAiAgentRun | null): IAiToolCall[] => {
  if (!run) {
    return [];
  }

  return planStore.value
    .getToolActivities(run.id)
    .filter(
      (activity: IAiToolActivityInline) => run.status !== 'paused' || !isLiveToolActivity(activity),
    )
    .map((activity: IAiToolActivityInline) => ({
      id: activity.id,
      name: activity.toolName,
      status: mapActivityToToolCallStatus(activity.state),
      summary: activity.label,
      targetPreview: normalizeToolActivitySummary(activity),
    }));
};

const buildPlanRunFinalAnswer = (
  run: IAiAgentRun,
  stepFinalAnswers: IAiAgentStepFinalAnswer[],
): string => {
  if (run.status === 'failed') {
    return `计划执行失败：${run.errorMessage ?? '执行过程中出现错误。'}`;
  }

  if (run.status === 'cancelled') {
    return '计划执行已取消。';
  }

  const answerByStepId = new Map(
    stepFinalAnswers.map((answer) => [answer.stepId, answer.content.trim()]),
  );
  const resultLines = run.steps
    .filter((step) => step.status === 'done')
    .map((step) => {
      const answer = answerByStepId.get(step.id);
      return answer ? `- ${step.title}：${answer}` : `- ${step.title}：已完成。`;
    });

  return [
    '已完成这轮计划执行。',
    ...(resultLines.length ? ['', '执行结果：', ...resultLines] : []),
  ].join('\n');
};

const isAgentTokenMessage = (message: IAiChatMessage): boolean =>
  message.role !== 'assistant' ||
  Boolean(message.toolCalls?.length) ||
  Boolean(message.stream?.runtimeEvents?.length);

const resolvePlanTokenStep = (run: IAiAgentRun | null): IAiTaskPlanStep | null => {
  if (!run) {
    return null;
  }

  if (run.currentStepId) {
    return run.steps.find((step) => step.id === run.currentStepId) ?? null;
  }

  return (
    run.steps.find((step) => step.status === 'running') ??
    run.steps.find((step) => step.status === 'pending') ??
    null
  );
};

const buildPlanTokenEstimationMessages = (
  goal: string,
  step: IAiTaskPlanStep,
  createdAt: string,
): IAiChatMessage[] => {
  const toolList = step.tools.length ? step.tools.join(', ') : '未限定，按任务需要选择可用工具';

  return [
    {
      id: `plan-token-system:${step.id}`,
      role: 'system',
      content: [
        '你正在执行 IDE Agent Plan 的单个步骤。',
        '必须围绕当前步骤目标调用可用工具；不要执行与当前步骤无关的操作。',
        '如果需要高风险工具，请通过 sidecar approval 事件等待用户确认。',
        '写盘、删除、命令、安装依赖和 Git 操作都必须保留可回滚语义。',
      ].join('\n'),
      createdAt,
      references: [],
    },
    {
      id: `plan-token-user:${step.id}`,
      role: 'user',
      content: [
        `任务目标：${goal}`,
        `当前步骤：${step.title}`,
        `步骤目标：${step.goal}`,
        `预期产物：${step.expectedOutput}`,
        `建议工具：${toolList}`,
        '请执行这个步骤，并在完成后给出简短结论。',
      ].join('\n'),
      createdAt,
      references: [],
    },
  ];
};

const activeAgentFlowMessage = computed<IAiChatMessage | null>(() => {
  if (assistant.activeMode.value !== 'plan') {
    return null;
  }

  const run = planActiveRun.value;
  const toolCalls = buildAgentFlowToolCalls(run);

  if (!run && toolCalls.length === 0) {
    return null;
  }

  const latestToolCall = toolCalls.at(-1);
  const stepFinalAnswers = run ? planStore.value.getStepFinalAnswers(run.id) : [];
  const latestAnswer = stepFinalAnswers.at(-1) ?? null;
  const createdAt = latestAnswer?.createdAt ?? run?.updatedAt ?? new Date().toISOString();
  const isTerminalRun = run
    ? run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
    : false;
  let content = 'Agent 正在执行计划。';

  if (run?.status === 'paused') {
    content = '计划已暂停，点击继续后会从未完成步骤恢复执行。';
  } else if (run && isTerminalRun) {
    content = buildPlanRunFinalAnswer(run, stepFinalAnswers);
  } else if (latestToolCall) {
    content = `AI 正在自动使用工具：${latestToolCall.summary}`;
  }

  return {
    id: run ? `agent-flow:${run.id}` : `agent-flow:${latestToolCall?.id ?? 'activity'}`,
    role: 'assistant',
    content,
    createdAt,
    references: [],
    toolCalls,
  };
});

// 旧的 agent-flow synthetic message 仅用于 token usage 估算，不再进入可见时间线；
// AiChatThread 会按 `agent-flow:` 前缀将其过滤掉。
const threadMessages = computed<IAiChatMessage[]>(() => {
  const flowMessage = activeAgentFlowMessage.value;

  if (!flowMessage) {
    return assistant.messages.value;
  }

  return [
    ...assistant.messages.value.filter((message) => message.id !== flowMessage.id),
    flowMessage,
  ];
});
// 真正喂给平铺时间线的消息：真实会话消息 + 可选的 plan-control 审批条目。
const visibleThreadMessages = computed<IAiChatMessage[]>(() => {
  const controlMessage = planControlMessage.value;

  if (!controlMessage) {
    return assistant.messages.value;
  }

  return [...assistant.messages.value, controlMessage];
});
const tokenUsageMessages = computed<IAiChatMessage[]>(() => {
  if (assistant.activeMode.value === 'plan') {
    return activeAgentFlowMessage.value ? [activeAgentFlowMessage.value] : [];
  }

  if (assistant.activeMode.value === 'agent') {
    return assistant.messages.value.filter(isAgentTokenMessage);
  }

  return threadMessages.value;
});
const tokenEstimationMessages = computed<IAiChatMessage[]>(() => {
  if (assistant.activeMode.value === 'chat') {
    return threadMessages.value;
  }

  if (assistant.activeMode.value !== 'plan') {
    return [];
  }

  const hasManualInput =
    assistant.draft.value.trim().length > 0 || assistant.attachedFiles.value.length > 0;

  if (hasManualInput) {
    return [];
  }

  const step = resolvePlanTokenStep(planActiveRun.value);

  if (!step) {
    return [];
  }

  return buildPlanTokenEstimationMessages(
    planActiveGoal.value,
    step,
    planActiveRun.value?.updatedAt ?? new Date().toISOString(),
  );
});
const tokenContextReferences = computed(() => {
  const attachmentReferences = assistant.attachedFiles.value.map((file) => file.reference);

  if (assistant.activeMode.value === 'chat') {
    return attachmentReferences;
  }

  const hasManualInput = assistant.draft.value.trim().length > 0 || attachmentReferences.length > 0;
  const hasPlanExecutionEstimate =
    assistant.activeMode.value === 'plan' && tokenEstimationMessages.value.length > 0;

  if (!hasManualInput && !hasPlanExecutionEstimate) {
    return [];
  }

  return assistant.buildSidecarContextReferences(attachmentReferences);
});
const hasPendingTokenRequest = computed(
  () =>
    assistant.draft.value.trim().length > 0 ||
    assistant.attachedFiles.value.length > 0 ||
    (assistant.activeMode.value === 'plan' && tokenEstimationMessages.value.length > 0),
);
const tokenOfficialUsage = computed(() => {
  // 接收侧 ACP usage_update 闭环（ADR-20260617 · D7-⑦）：嬿主已把 usage_update 投影为
  // 共享 IAiLanguageModelUsage VM。任一模式只要本回合有 ACP 用量就优先采用（chat / agent
  // 经 ACP host 上报）；其形状与外部 LanguageModelUsage 赋值兼容，可直接作为官方用量来源。
  const acpTurnUsage = assistant.acpUsage.usage.value;
  if (acpTurnUsage) {
    return acpTurnUsage;
  }

  if (assistant.activeMode.value !== 'plan') {
    return null;
  }

  return planStore.value.totalOfficialUsageResolved ? planStore.value.totalOfficialUsage : null;
});
const { contextProps: tokenContextProps } = useAiTokenContext({
  mode: computed(() => assistant.activeMode.value),
  modelId: computed(() => assistant.config.value.selectedModel),
  runtimeEvents: computed(() => assistant.runtimeTimelineEvents.value),
  messages: tokenUsageMessages,
  estimationMessages: tokenEstimationMessages,
  contextReferences: tokenContextReferences,
  hasPendingRequest: hasPendingTokenRequest,
  draft: computed(() => assistant.draft.value),
  officialUsage: tokenOfficialUsage,
});
const submitLabel = computed(() => {
  if (assistant.activeMode.value === 'plan') {
    return '生成计划';
  }

  if (assistant.activeMode.value === 'agent') {
    return '开始执行';
  }

  return assistant.sendButtonLabel.value;
});
const assistantTypingLabel = computed(() => {
  if (assistant.activeMode.value === 'plan' && (planIsPlanning.value || planIsClassifying.value)) {
    return '正在生成计划';
  }

  return '正在准备回复';
});

if (planStore.value.mode === 'plan' || planId.value || planActiveRun.value) {
  assistant.activeMode.value = 'plan';
}

const fileRollbackPrompt = computed(() => assistant.fileRollbackPrompt.value);
const fileRollbackLabel = computed(() => {
  const prompt = fileRollbackPrompt.value;

  if (!prompt) {
    return '';
  }

  if (prompt.status === 'reverting') {
    return '正在回滚 AI 文件修改';
  }

  if (prompt.status === 'reverted') {
    return '已回滚 AI 最近一次文件修改';
  }

  return 'AI 已修改文件，可回滚最近一次';
});
const isFileRollbackDisabled = computed(() => fileRollbackPrompt.value?.status !== 'ready');

const openSettings = (): void => {
  settingsDraft.value = cloneAiConfigPayload(assistant.config.value);
  settingsApiKey.value = '';
  settingsTavilyApiKey.value = '';
  closeHistory();
  assistant.isSettingsOpen.value = true;
  assistant
    .loadTavilyApiKey()
    .then((apiKey) => {
      if (assistant.isSettingsOpen.value) {
        settingsTavilyApiKey.value = apiKey;
      }
    })
    .catch(() => undefined);
};

const handleSuggestionSelect = async (suggestion: string): Promise<void> => {
  if (assistant.isSending.value) {
    return;
  }

  assistant.draft.value = suggestion;
  await assistant.sendMessage({ agentBackend: sessionAgentBackend.value });
};

// 切换会话 Agent 后端后，清掉上一条（可能是 Kimi 未接入）的错误提示。
const handleAgentBackendChange = (agent: unknown): void => {
  if (!isSessionAgentBackend(agent)) {
    return;
  }

  sessionAgentBackend.value = agent;
  assistant.error.value = '';

  if (agent === 'kimi') {
    const threadId = assistant.activeConversationId.value;

    if (threadId) {
      void assistant.acpSessionConfigOptions.loadConfigOptions(threadId).catch(() => undefined);
    }
  }
};

// ACP 会话配置项切换（config_options 全量迁移发送侧）：选择器回投透传给
// useAcpSessionConfigOptions.selectConfigOption（乐观更新 + setSessionConfigOption 回投，
// 失败回滚并提示）。
const handleSessionConfigOptionChange = async (
  configId: string,
  valueId: string,
): Promise<void> => {
  const threadId = assistant.activeConversationId.value;
  if (!threadId) {
    return;
  }
  try {
    await assistant.acpSessionConfigOptions.selectConfigOption(threadId, configId, valueId);
  } catch (error) {
    assistant.error.value = toErrorMessage(error, '切换会话配置失败。');
  }
};

const handleSubmitMessage = async (): Promise<void> => {
  if (!assistant.draft.value.trim() || assistant.isSending.value) {
    return;
  }

  await assistant.sendMessage({ agentBackend: sessionAgentBackend.value });
};

const handleConversationScrollStateChange = (state: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
}): void => {
  assistant.updateConversationScrollState({
    ...state,
    updatedAt: new Date().toISOString(),
  });
};

const setPlanError = (error: unknown, fallback: string): void => {
  setPlanErrorMessage(toErrorMessage(error, fallback));
};

const handleSearchWebSources = async (query: string): Promise<void> => {
  const step = activePlanStep.value;

  try {
    await webSources.search(
      {
        query,
        intent: 'general',
        maxResults: 5,
        recency: 'any',
      },
      step ? { stepId: step.id, stepTitle: step.title } : {},
    );
  } catch (error) {
    setPlanError(error, '网络搜索失败。');
  }
};
const handleFetchWebSource = async (sourceId: string): Promise<void> => {
  try {
    await webSources.fetchSource(sourceId);
  } catch (error) {
    setPlanError(error, '网页读取失败。');
  }
};

const handlePromptModelChange = async (modelId: string): Promise<void> => {
  const normalizedModelId = modelId.trim();
  const agent = sessionAgentBackend.value;

  // 与「当前 Agent 实际生效的模型」比较（而非全局 selectedModel），避免其它 Agent
  // 切到与 builtin 相同的模型时被误判为 no-op。
  if (!normalizedModelId || normalizedModelId === activeAgentModelId.value) {
    return;
  }

  // 非 builtin Agent：只更新该 Agent 的会话级模型记忆，绝不写回 ai.json，
  // 因此不影响 builtin（mastra 运行时）或其它 Agent 已选的模型。
  if (agent !== 'builtin') {
    agentModelOverrides.value = {
      ...agentModelOverrides.value,
      [agent]: normalizedModelId,
    };
    return;
  }

  // builtin：沿用既有行为，把全局 selectedModel 持久化到 ai.json（mastra 运行时模型）。
  isPromptModelSaving.value = true;
  try {
    await assistant.saveConfig({
      ...cloneAiConfigPayload(assistant.config.value),
      providerType: 'mastra',
      selectedModel: normalizedModelId,
      baseUrl: resolveDefaultAiBaseUrl(normalizedModelId),
    });
    settingsDraft.value = cloneAiConfigPayload(assistant.config.value);
  } catch (error) {
    assistant.error.value = toErrorMessage(error, '模型切换失败');
  } finally {
    isPromptModelSaving.value = false;
  }
};

const handlePromptNetworkPermissionChange = async (
  permission: TAiAgentNetworkPermission,
): Promise<void> => {
  try {
    await agentNetwork.setNetworkPermission(permission);
  } catch (error) {
    setPlanError(error, '设置网络访问权限失败。');
  }
};

const openPromptInformationSources = (): void => {
  openSettings();
};

const openPromptPersonalization = (): void => {
  openSettings();
};

const handlePromptExecutionModeChange = (mode: TAiExecutionMode): void => {
  planStore.value.setExecutionMode(mode);
};

let aiConnectionPrewarmStarted = false;

const handlePromptPrewarm = (): void => {
  if (aiConnectionPrewarmStarted) {
    return;
  }

  aiConnectionPrewarmStarted = true;
  void aiService.sidecarWarmup().catch((error) => {
    console.info(
      JSON.stringify({
        level: 'info',
        scope: 'ai',
        event: 'agent_sidecar_warmup.skipped',
        reason: toErrorMessage(error, '预热连接失败'),
      }),
    );
  });
};

const getActiveAgentRunId = (): string | null =>
  planActiveRunId.value ?? planActiveRun.value?.id ?? null;

const withAgentRunAction = async <T>(
  action: (runId: string) => Promise<T>,
  fallback: string,
): Promise<T | null> => {
  const runId = getActiveAgentRunId();

  if (!runId) {
    setPlanErrorMessage('当前没有可执行的 Agent run。');
    return null;
  }

  isAgentRunActionPending.value = true;
  setPlanErrorMessage('');

  try {
    return await action(runId);
  } catch (error) {
    setPlanError(error, fallback);
    return null;
  } finally {
    isAgentRunActionPending.value = false;
  }
};
const handleUpdatePlanStepTitle = (stepId: string, title: string): void => {
  assistant.agentPlan.updateStep(stepId, { title });
};

const handleRemovePlanStep = (stepId: string): void => {
  try {
    assistant.agentPlan.removeStep(stepId);
  } catch (error) {
    setPlanError(error, '删除计划步骤失败。');
  }
};

const handleRegeneratePlan = async (): Promise<void> => {
  try {
    await assistant.agentPlan.regeneratePlan();
  } catch (error) {
    setPlanError(error, '重生成计划失败。');
  }
};

const handleApprovePlan = async (): Promise<void> => {
  try {
    await assistant.agentPlan.approvePlan();
    await agentRun.runPlanToCompletion(planActiveGoal.value, planSteps.value, {
      context: assistant.buildSidecarContextReferences(),
      workspaceRootPath: props.workspaceRootPath,
    });
  } catch (error) {
    setPlanError(error, '批准或启动计划失败。');
  }
};

const handleRejectPlan = async (): Promise<void> => {
  try {
    await assistant.agentPlan.rejectPlan('用户拒绝当前计划。');
  } catch (error) {
    setPlanError(error, '拒绝计划失败。');
  }
};

const handlePauseRun = async (): Promise<void> => {
  await withAgentRunAction((runId) => agentRun.pauseRun(runId), '暂停 Agent run 失败。');
};

const handleResumeRun = async (): Promise<void> => {
  const resumedRun = await withAgentRunAction(
    (runId) => agentRun.resumeRun(runId),
    '继续 Agent run 失败。',
  );

  if (!resumedRun) {
    return;
  }

  try {
    await agentRun.continueRunToCompletion(resumedRun.id, {
      goal: planActiveGoal.value,
      context: assistant.buildSidecarContextReferences(),
      workspaceRootPath: props.workspaceRootPath,
    });
  } catch (error) {
    setPlanError(error, '继续执行计划失败。');
  }
};

const handleCancelRun = async (): Promise<void> => {
  await withAgentRunAction((runId) => agentRun.cancelRun(runId), '取消 Agent run 失败。');
};

const handleResolveToolConfirmation = async (
  decision: TAiToolConfirmationDecision,
): Promise<void> => {
  const confirmation = planPendingToolConfirmation.value;

  if (!confirmation) {
    setPlanErrorMessage('当前没有待处理的工具确认。');
    return;
  }

  if (!planActiveRun.value) {
    isAgentRunActionPending.value = true;
    setPlanErrorMessage('');

    try {
      await assistant.resolveSidecarToolConfirmation(decision);
    } catch (error) {
      setPlanError(error, '处理 Provider 工具确认失败。');
    } finally {
      isAgentRunActionPending.value = false;
    }

    return;
  }

  if (agentRun.hasSidecarStepToolConfirmation(confirmation.id)) {
    isAgentRunActionPending.value = true;
    setPlanErrorMessage('');
    let resolvedRun: IAiAgentRun | null = null;

    try {
      resolvedRun = await agentRun.resolveSidecarStepToolConfirmation(confirmation.id, decision);
    } catch (error) {
      setPlanError(error, '处理 Sidecar step 工具确认失败。');
    } finally {
      isAgentRunActionPending.value = false;
    }

    if (resolvedRun?.status === 'running-plan') {
      try {
        await agentRun.continueRunToCompletion(resolvedRun.id, {
          goal: planActiveGoal.value,
          context: assistant.buildSidecarContextReferences(),
          workspaceRootPath: props.workspaceRootPath,
        });
      } catch (error) {
        setPlanError(error, '继续执行计划失败。');
      }
    }

    return;
  }

  setPlanErrorMessage('Legacy Agent 工具确认链已移除，请使用官方 sidecar 审批链。');
};

const handleResolveUserQuestion = async (result: IAskUserResult): Promise<void> => {
  if (!visibleUserQuestion.value) {
    return;
  }

  isResolvingUserQuestion.value = true;
  setPlanErrorMessage('');

  try {
    await assistant.resolveSidecarUserQuestion(result);
  } catch (error) {
    setPlanError(error, '处理反向提问失败。');
  } finally {
    isResolvingUserQuestion.value = false;
  }
};

const handleCancelUserQuestion = async (): Promise<void> => {
  await handleResolveUserQuestion({ outcome: 'cancelled' });
};

const saveSettings = async (
  config: IAiConfigPayload,
  apiKey: string,
  role: TAiModelRole,
  feedback: IAiProviderSettingsActionFeedback,
): Promise<void> => {
  try {
    const message = await assistant.connectProvider(config, apiKey, role);
    settingsApiKey.value = '';
    settingsDraft.value = cloneAiConfigPayload(assistant.config.value);
    feedback.onSuccess(message);
  } catch (error) {
    feedback.onError(toErrorMessage(error, 'AI 连接失败'));
  }
};

const testProvider = async (
  config: IAiConfigPayload,
  apiKey: string,
  role: TAiModelRole,
  feedback: IAiProviderSettingsActionFeedback,
): Promise<void> => {
  try {
    feedback.onSuccess(await assistant.testProviderConfig(config, apiKey, role));
  } catch (error) {
    feedback.onError(toErrorMessage(error, '连接测试失败'));
  }
};

const saveTavilyKey = async (
  apiKey: string,
  feedback: IAiProviderSettingsActionFeedback,
): Promise<void> => {
  try {
    const message = await assistant.saveTavilyApiKey(apiKey);
    settingsTavilyApiKey.value = apiKey.trim();
    feedback.onSuccess(message);
  } catch (error) {
    feedback.onError(toErrorMessage(error, 'Tavily API Key 保存失败'));
  }
};

const restorePersistedPlanUiState = async (): Promise<void> => {
  if (!hasPlannedAgentState.value && planStore.value.mode !== 'plan') {
    return;
  }

  assistant.activeMode.value = 'plan';
  await assistant.agentPlan.restorePersistedPlanState();
};

// 启动打点（阶段0·量化）：同步 setup（含派生计算）全部完成。
markStartup('ai-assistant-panel-setup-done');

onMounted(() => {
  // 启动打点（阶段0·量化）：子组件渲染挂载完成（首帧）。
  markStartup('ai-assistant-panel-mounted');
  restorePersistedPlanUiState().catch((error) => {
    setPlanError(error, '恢复计划状态失败。');
  });
  assistant
    .loadConfig()
    .then(() => {
      settingsDraft.value = cloneAiConfigPayload(assistant.config.value);
    })
    .catch(() => undefined);
});
</script>

<template>
  <AiPanelFrame class="ai-assistant-panel" aria-label="AI 助手面板">
    <template #mark>
      <Select :model-value="sessionAgentBackend" @update:model-value="handleAgentBackendChange">
        <SelectTrigger aria-label="选择 Agent" class="ai-agent-mark">
          <AiProviderIcon
            v-if="sessionAgentBackend === 'kimi'"
            class="ai-agent-mark__icon"
            platform-id="moonshotai"
            decorative
          />
          <Bot v-else class="ai-agent-mark__icon" :stroke-width="1.6" />
          <span class="ai-agent-mark__copy">
            <span class="ai-agent-mark__label" v-text="selectedAgentOption.label"></span>
          </span>
        </SelectTrigger>
        <SelectContent side="bottom" align="start" :side-offset="8" class="ai-agent-mark-content">
          <SelectGroup>
            <SelectItem
              v-for="agent in agentOptions"
              :key="agent.key"
              class="ai-agent-mark-item"
              :value="agent.key"
            >
              <AiProviderIcon
                v-if="agent.key === 'kimi'"
                class="ai-agent-mark-item__icon"
                platform-id="moonshotai"
                decorative
              />
              <Bot v-else class="ai-agent-mark-item__icon" :stroke-width="1.6" />
              <span class="ai-agent-mark-item__label" v-text="agent.label"></span>
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </template>

    <template #actions>
      <button type="button" class="ai-icon-button" aria-label="新建对话" @click="startNewConversation">
        <SquarePen aria-hidden="true" />
      </button>
      <button type="button" class="ai-icon-button" aria-label="AI 设置" @click="openSettings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M20 7h-7" />
          <path d="M14 17H4" />
          <circle cx="17" cy="17" r="3" />
          <circle cx="7" cy="7" r="3" />
        </svg>
      </button>
      <div ref="historyAnchorRef" class="ai-history-anchor">
        <button type="button" class="ai-icon-button" aria-label="对话记录" aria-haspopup="dialog"
          :aria-expanded="isHistoryOpen" @click="toggleHistoryPopover">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M3 3v5h5" />
            <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
            <path d="M12 7v5l4 2" />
          </svg>
        </button>
        <AnimatePresence>
          <Motion v-if="isHistoryOpen" as-child :initial="{ opacity: 0, scale: 0.96, y: -6 }"
            :animate="{ opacity: 1, scale: 1, y: 0 }" :exit="{ opacity: 0, scale: 0.96, y: -6 }"
            :transition="{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }">
            <section ref="historyPopoverRef" class="ai-history-popover" role="dialog"
              aria-label="对话记录">
              <header class="ai-history-header">
                <div class="ai-history-title-group">
                  <strong>对话记录</strong>
                </div>
                <button v-if="activeHistoryThread" type="button" class="ai-history-clear-icon" aria-label="删除当前对话记录"
                  @click="openDeleteConversationDialog(activeHistoryThread.id)">
                  <Trash2 aria-hidden="true" />
                </button>
              </header>
              <div v-if="historyThreads.length" class="ai-history-scroll-area" @scroll="handleHistoryScroll">
                <div class="ai-history-list">
                  <article v-for="thread in historyThreads" :key="thread.id" class="ai-history-item"
                    :class="{ 'is-active': thread.id === assistant.activeConversationId.value }">
                    <button type="button" class="ai-history-button" @click="openHistoryThread(thread.id)">
                      <div class="ai-history-meta">
                        <strong class="ai-history-title" v-text="thread.title"></strong>
                        <time v-text="getHistoryTimestampLabel(thread.updatedAt)"></time>
                      </div>
                      <div class="ai-history-subtitle" v-text="getHistoryMessageCountLabel(thread.messages)"></div>
                    </button>
                    <button type="button" class="ai-history-delete-button" aria-label="删除这条对话记录"
                      @click.stop="openDeleteConversationDialog(thread.id)">
                      <Trash2 aria-hidden="true" />
                    </button>
                  </article>
                </div>
                <div v-if="hasMoreHistoryThreads" class="ai-history-load-sentinel" aria-hidden="true"></div>
              </div>
              <div v-else class="ai-history-empty">暂无对话记录</div>
            </section>
          </Motion>
        </AnimatePresence>
      </div>
      <slot name="header-actions-after" />
    </template>

    <template #body>
      <AiChatThread :messages="visibleThreadMessages" :is-typing="assistant.isSending.value"
        :thread-entries="renderThreadEntries"
        :platform-id="aiIconPlatformId" :provider-label="aiIconTitle"
        :conversation-id="assistant.activeConversationId.value" :workspace-root-path="workspaceRootPath"
        :scroll-state="assistant.activeConversationScrollState.value" :typing-label="assistantTypingLabel"
        :plan-details="threadPlanDetails"
        :reverting-changed-files-summary-id="assistant.revertingChangedFilesSummaryId.value"
        :pinning-changed-files-summary-id="assistant.pinningChangedFilesSummaryId.value"
        @scroll-state-change="handleConversationScrollStateChange"
        @changed-files-rollback="assistant.rollbackChangedFilesSummary"
        @changed-files-pin="assistant.setChangedFilesSummaryPin" @plan-approve="handleApprovePlan"
        @plan-reject="handleRejectPlan" @plan-regenerate="handleRegeneratePlan"
        @plan-update-step-title="handleUpdatePlanStepTitle" @plan-remove-step="handleRemovePlanStep">
        <template #empty>
          <AiAssistantSuggestionEmpty :suggestion-rows="suggestionRows" :disabled="composerDisabled"
            @select="handleSuggestionSelect" />
        </template>
        <template #after-message="{ message }">
          <AiAssistantCheckpointEntry v-if="getConversationCheckpoint(message.id)"
            :label="getConversationCheckpointLabel(message.id)" :disabled="isConversationCheckpointDisabled"
            :restoring="isConversationCheckpointRestoring(message.id)"
            @restore="handleRestoreConversationCheckpoint(message.id)" />
        </template>
        <template #after-messages>
          <AiErrorNotice :message="assistant.error.value" />
        </template>
      </AiChatThread>
    </template>

    <template #composer>
      <div v-if="fileRollbackPrompt" class="ai-file-rollback-entry" :class="`is-${fileRollbackPrompt.status}`">
        <span class="ai-file-rollback-entry__line" aria-hidden="true"></span>
        <button type="button" class="ai-file-rollback-entry__button" :disabled="isFileRollbackDisabled"
          :aria-label="fileRollbackLabel" @click="assistant.rollbackLatestFileChange">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M3 7v5h5" />
            <path d="M21 17a8 8 0 0 0-13.66-5.66L3 16" />
          </svg>
          <span v-text="fileRollbackLabel"></span>
        </button>
        <span class="ai-file-rollback-entry__line" aria-hidden="true"></span>
      </div>
      <DeferredAiWebSourcesPanel v-if="webSourcesVisible" :sources="webSources.sources.value"
        :activity="planProgressVisible ? null : webSources.activity.value" :error-message="webSources.errorMessage.value"
        :is-searching="webSources.isSearching.value" :network-permission="networkPermission"
        @search="handleSearchWebSources" @fetch-source="handleFetchWebSource" @clear="webSources.clear" />
      <div class="ai-composer-shell">
        <AiThreadRunStatusBar :run="planActiveRun" :confirmation="visibleDirectToolConfirmation"
          :busy="isAgentRunActionPending" @pause="handlePauseRun" @resume="handleResumeRun" @cancel="handleCancelRun"
          @resolve="handleResolveToolConfirmation" />
        <QuestionPrompt v-if="visibleUserQuestion" :questions="visibleUserQuestion.questions"
          :disabled="isResolvingUserQuestion" @submit="handleResolveUserQuestion"
          @cancel="handleCancelUserQuestion" />
        <AiPromptInput v-else v-model="assistant.draft.value" v-model:active-mode="assistant.activeMode.value"
          v-model:agent-backend="sessionAgentBackend"
          :session-config-options="assistant.acpSessionConfigOptions.state.value"
          :is-session-config-option-switching="assistant.acpSessionConfigOptions.isSwitching.value"
          :disabled="composerDisabled" :stop-visible="assistant.isSending.value"
          :submit-label="submitLabel" :config="assistant.config.value"
          :is-model-saving="isPromptModelSaving" :selected-model-override="activeAgentModelId"
          :network-permission="networkPermission"
          :execution-mode="executionMode"
          :is-network-permission-saving="agentNetwork.pending.value" :attachments="assistant.attachedFiles.value"
          :has-attachments="assistant.attachedFiles.value.length > 0" :token-context="tokenContextProps"
          @submit="handleSubmitMessage" @stop="assistant.stopCurrentRequest" :resolve-attachment="assistant.attachFile"
          @remove-file="assistant.removeAttachedFile" @model-change="handlePromptModelChange"
          @network-permission-change="handlePromptNetworkPermissionChange"
          @execution-mode-change="handlePromptExecutionModeChange"
          @session-config-option-change="handleSessionConfigOptionChange"
          @information-sources-open="openPromptInformationSources" @personalization-open="openPromptPersonalization"
          @prewarm="handlePromptPrewarm" />
      </div>

      <DeferredAiProviderSettings v-if="assistant.isSettingsOpen.value" v-model:draft="settingsDraft" v-model:api-key="settingsApiKey"
        v-model:tavily-api-key="settingsTavilyApiKey" :open="assistant.isSettingsOpen.value"
        :config="assistant.config.value" @close="assistant.isSettingsOpen.value = false" @save="saveSettings"
        @test-provider="testProvider" @save-tavily-key="saveTavilyKey" />

      <Teleport to="body">
        <div v-if="assistant.isClearDialogOpen.value" class="ai-dialog-backdrop" @click.self="cancelClearConversation">
          <section class="ai-dialog is-compact" role="alertdialog" aria-modal="true">
            <div class="ai-dialog-copy">
              <h3 v-text="deleteDialogTitle"></h3>
              <p v-text="deleteDialogDescription"></p>
            </div>
            <div class="ai-dialog-actions">
              <button type="button" class="ai-button is-ghost" @click="cancelClearConversation">取消</button>
              <button type="button" class="ai-button is-danger" @click="confirmClearConversation">删除</button>
            </div>
          </section>
        </div>
      </Teleport>
    </template>
  </AiPanelFrame>
</template>

<style scoped>
.ai-agent-mark {
  display: inline-flex;
  min-width: 0;
  height: 30px;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  padding: 0 8px;
  box-shadow: none;
}

.ai-agent-mark:hover,
.ai-agent-mark[data-state='open'] {
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
}

.ai-agent-mark > :deep(svg:last-child) {
  display: none;
}

.ai-agent-mark__icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
}

.ai-agent-mark__copy {
  min-width: 0;
  display: inline-flex;
  align-items: center;
}

.ai-agent-mark__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
}

.ai-agent-mark-content {
  width: min(240px, calc(100vw - 24px));
  padding: 8px;
  border: 1px solid #f0f0f2;
  border-radius: 10px;
  background: #ffffff;
  color: #1f2328;
  box-shadow: 0 8px 24px rgb(15 23 42 / 8%);
}

.ai-agent-mark-content [data-slot='select-scroll-up-button'],
.ai-agent-mark-content [data-slot='select-scroll-down-button'] {
  display: none;
}


.ai-agent-mark-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  border-radius: 7px;
  color: #1f2328;
  font-size: 14px;
  padding: 0 28px 0 7px;
}

.ai-agent-mark-item[data-highlighted],
.ai-agent-mark-item[data-state='checked'] {
  background: #818b981f;
}

.ai-agent-mark-item__icon {
  width: 17px;
  height: 17px;
  flex: 0 0 auto;
}

.ai-agent-mark-item__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-icon-button {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 6px;
  color: var(--text-tertiary);
  transition:
    color 120ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-icon-button:hover {
  color: var(--text-primary);
}

.ai-icon-button:active {
  transform: scale(0.97);
}

.ai-icon-button svg {
  width: 15px;
  height: 15px;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ai-history-anchor {
  position: relative;
  display: grid;
  place-items: center;
}

.ai-history-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 1301;
  display: flex;
  flex-direction: column;
  width: 332px;
  max-width: min(332px, calc(100vw - 24px));
  max-height: min(560px, calc(100vh - 24px));
  overflow: hidden;
  border: 1px solid #F0F0F2 !important;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.06) !important;
  transform-origin: top right;
}

.ai-history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 40px;
  padding: 0 12px;
}

.ai-history-title-group {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.ai-history-title-group strong {
  color: #0f172a;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.ai-history-clear-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  background: transparent;
  color: #64748b;
  padding: 0;
}

.ai-history-clear-icon:hover {
  color: #0f172a;
}

.ai-history-clear-icon svg {
  width: 14px;
  height: 14px;
  stroke-width: 1.9;
}

.ai-history-scroll-area {
  max-height: calc((6 * 60px) + (5 * 8px) + 16px);
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.ai-history-scroll-area::-webkit-scrollbar {
  display: none;
}

.ai-history-list {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
}

.ai-history-load-sentinel {
  width: 100%;
  height: 1px;
  flex: 0 0 auto;
}

.ai-history-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 30px;
  align-items: stretch;
  flex: 0 0 auto;
  min-width: 0;
  border: 0;
  border-radius: 10px;
  background: #ffffff;
  box-shadow: none;
  overflow: hidden;
}

.ai-history-item:hover {
  background: #f8fafc;
  box-shadow: none;
}

.ai-history-item.is-active {
  background: color-mix(in srgb, var(--accent-strong) 12%, #ffffff);
  box-shadow: none;
}

.ai-history-button {
  display: grid;
  width: 100%;
  gap: 6px;
  color: inherit;
  text-align: left;
  padding: 10px;
}

.ai-history-delete-button {
  display: grid;
  width: 30px;
  min-width: 30px;
  place-items: center;
  border: 0;
  padding: 0;
  color: var(--text-quaternary);
}

.ai-history-delete-button:hover {
  color: var(--danger);
}

.ai-history-delete-button svg {
  width: 13px;
  height: 13px;
  stroke-width: 1.9;
}

.ai-history-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  line-height: 16px;
}

.ai-history-title {
  min-width: 0;
  overflow: hidden;
  color: #0f172a;
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-history-meta time {
  color: #64748b;
}

.ai-history-subtitle {
  color: #64748b;
  font-size: 11px;
  line-height: 16px;
}

.ai-history-empty {
  color: #64748b;
  font-size: 12px;
  line-height: 18px;
  padding: 20px 16px;
  text-align: center;
}

.ai-file-rollback-entry {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 0;
}

.ai-file-rollback-entry__line {
  height: 1px;
  flex: 1 1 auto;
  min-width: 18px;
  background: color-mix(in srgb, var(--shell-divider) 86%, transparent);
}

.ai-file-rollback-entry__button,
.ai-button {
  height: 28px;
  border-radius: 6px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 500;
}

.ai-file-rollback-entry__button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: auto;
  flex: 0 0 auto;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}

.ai-file-rollback-entry__button:not(:disabled):hover {
  color: var(--text-primary);
}

.ai-file-rollback-entry__button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong) 60%, transparent);
  outline-offset: 4px;
}

.ai-file-rollback-entry__button svg {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ai-file-rollback-entry__button:disabled {
  cursor: default;
  opacity: 0.72;
}

.ai-file-rollback-entry.is-reverted .ai-file-rollback-entry__button {
  color: color-mix(in srgb, var(--success) 68%, var(--text-tertiary));
}

.ai-composer-shell {
  --ai-composer-surface: var(--panel-bg);
  --ai-composer-fade-height: calc(var(--app-density-scale) * 3rem);
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  background: var(--ai-composer-surface);
}

.ai-composer-shell::before {
  position: absolute;
  right: 0;
  bottom: calc(100% - 1px);
  left: 0;
  height: var(--ai-composer-fade-height);
  pointer-events: none;
  background: linear-gradient(to top,
      var(--ai-composer-surface) 0%,
      color-mix(in srgb, var(--ai-composer-surface) 74%, transparent) 24%,
      color-mix(in srgb, var(--ai-composer-surface) 34%, transparent) 58%,
      color-mix(in srgb, var(--ai-composer-surface) 10%, transparent) 82%,
      transparent 100%);
  content: '';
}

.ai-composer-shell :global(.ai-composer) {
  background: var(--ai-composer-surface);
  padding: 0 10px 10px;
}

.ai-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1300;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.28);
}

.ai-dialog {
  display: grid;
  inline-size: fit-content;
  min-inline-size: min(380px, calc(100vw - 32px));
  max-inline-size: min(460px, calc(100vw - 32px));
  gap: 12px;
  border: 1px solid #e5e5e5;
  border-radius: 12px;
  background: #ffffff;
  padding: 16px;
}

.ai-dialog-copy h3 {
  margin: 0;
  color: #000000;
  font-size: 13px;
  font-weight: 600;
}

.ai-dialog-copy p {
  margin: 4px 0 0;
  color: #737373;
  font-size: 12px;
  line-height: 1.55;
}

.ai-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.ai-button.is-ghost {
  border: 1px solid #d4d4d4;
  background: #ffffff;
  color: #000000;
}

.ai-button.is-danger {
  border: 0;
  background: #ea1a24;
  color: #ffffff;
}
</style>

<style id="ai-agent-mark-global-overrides">
/* 左上角 Agent 下拉：SelectContent 会 teleport 到 body，必须用全局样式覆盖 */
.ai-agent-mark-content {
  border: 1px solid #f0f0f2 !important;
  background: #ffffff !important;
  background-color: #ffffff !important;
  color: #1f2328 !important;
  box-shadow: 0 8px 24px rgb(15 23 42 / 8%) !important;
  border-radius: 10px !important;
  padding: 8px !important;
}

/* 覆盖内部可能继承的弹窗/菜单背景 */
.ai-agent-mark-content *,
.ai-agent-mark-content [data-radix-select-viewport],
.ai-agent-mark-content [role='listbox'] {
  background-color: transparent;
}

/* 删除/隐藏“选择 Agent”标题，双保险 */
.ai-agent-mark-content .ai-agent-mark-section-label,
.ai-agent-mark-content [data-slot='select-label'] {
  display: none !important;
}

.ai-agent-mark-item {
  background: transparent !important;
}

.ai-agent-mark-item[data-highlighted],
.ai-agent-mark-item[data-state='checked'] {
  background: #f4f4f5 !important;
}

.ai-agent-mark-item__label {
  color: #1f2328 !important;
}
</style>

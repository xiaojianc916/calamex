<script setup lang="ts">
import Checkpoint from '@/components/ai-elements/checkpoint/Checkpoint.vue';
import CheckpointIcon from '@/components/ai-elements/checkpoint/CheckpointIcon.vue';
import CheckpointTrigger from '@/components/ai-elements/checkpoint/CheckpointTrigger.vue';
import { Loader } from '@/components/ai-elements/loader';
import AiChatThread from '@/components/business/ai/AiChatThread.vue';
import AiFloatingSuggestions from '@/components/business/ai/AiFloatingSuggestions.vue';
import AiPatchPreview from '@/components/business/ai/AiPatchPreview.vue';
import AiPlanConfirmationMessage from '@/components/business/ai/AiPlanConfirmationMessage.vue';
import AiPlanModePanel from '@/components/business/ai/AiPlanModePanel.vue';
import AiPromptInput from '@/components/business/ai/AiPromptInput.vue';
import AiProviderIcon from '@/components/business/ai/AiProviderIcon.vue';
import AiProviderSettings from '@/components/business/ai/AiProviderSettings.vue';
import AiToolConfirmationCard from '@/components/business/ai/AiToolConfirmationCard.vue';
import AiWebSourcesPanel from '@/components/business/ai/AiWebSourcesPanel.vue';
import { useAiAgentNetwork } from '@/composables/useAiAgentNetwork';
import { useAiAgentRun } from '@/composables/useAiAgentRun';
import { useAiAssistant, type IAiConversationCheckpoint } from '@/composables/useAiAssistant';
import { useAiSuggestionPool } from '@/composables/useAiSuggestionPool';
import { useAiTokenContext } from '@/composables/useAiTokenContext';
import { useAiWebSources } from '@/composables/useAiWebSources';
import { findAiServicePlatformByModel } from '@/constants/ai-providers';
import type {
  IAiAgentRun,
  IAiAgentStepFinalAnswer,
  IAiChatMessage,
  IAiConfigPayload,
  IAiProviderSettingsActionFeedback,
  IAiTaskPlanStep,
  IAiToolActivityInline,
  IAiToolCall,
  TAiModelRole,
  TAiToolConfirmationDecision,
} from '@/types/ai';
import type {
  IActiveRunSummary,
  IAnalyzeScriptPayload,
  IEditorDocument,
  IEditorSelectionSummary,
} from '@/types/editor';
import type { IGitDiffPreviewPayload, IGitRepositoryStatusPayload } from '@/types/git';
import { cloneAiConfigPayload } from '@/utils/ai-config';
import { toErrorMessage } from '@/utils/error';
import { SquarePen, Trash2 } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const MAX_HISTORY_MESSAGES = 20;
const props = defineProps<{
  document: IEditorDocument;
  activeRun: IActiveRunSummary | null;
  analysis: IAnalyzeScriptPayload;
  selection: IEditorSelectionSummary | null;
  gitStatus: IGitRepositoryStatusPayload;
  workspaceRootPath: string | null;
}>();

const emit = defineEmits<{
  'open-patch-diff': [payload: IGitDiffPreviewPayload];
}>();

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
const suggestionPool = useAiSuggestionPool({
  isRefreshEnabled: computed(() => assistant.config.value.narrator.isConfigured),
});
const settingsDraft = ref<IAiConfigPayload>(cloneAiConfigPayload(assistant.config.value));
const settingsApiKey = ref('');
const isAgentRunActionPending = ref(false);
const isHistoryOpen = ref(false);
const pendingDeleteThreadId = ref<string | null>(null);
const historyAnchorRef = ref<HTMLElement | null>(null);
const historyPopoverRef = ref<HTMLElement | null>(null);
const currentServicePlatform = computed(() =>
  findAiServicePlatformByModel(assistant.config.value.selectedModel),
);
const aiIconPlatformId = computed(() => currentServicePlatform.value.id);
const aiIconTitle = computed(() => currentServicePlatform.value.label);
const aiModelName = computed(() => {
  const selectedModel = assistant.config.value.selectedModel?.trim();

  if (!selectedModel) {
    return '未选择模型';
  }

  return selectedModel.split('/').filter(Boolean).at(-1) ?? selectedModel;
});
const providerMarkTitle = computed(() => {
  const selectedModel = assistant.config.value.selectedModel?.trim();
  if (!selectedModel) {
    return aiIconTitle.value;
  }

  return `${aiIconTitle.value} · ${selectedModel}`;
});
const historyThreads = computed(() => assistant.historyThreads.value.slice(-MAX_HISTORY_MESSAGES).reverse());
const activeHistoryThread = computed(() =>
  assistant.historyThreads.value.find((thread) => thread.id === assistant.activeConversationId.value) ?? null,
);
const pendingDeleteThread = computed(() =>
  assistant.historyThreads.value.find((thread) => thread.id === pendingDeleteThreadId.value) ?? null,
);
const conversationCheckpointByMessageId = computed<Record<string, IAiConversationCheckpoint>>(() => {
  const checkpointMap: Record<string, IAiConversationCheckpoint> = {};

  assistant.conversationCheckpoints.value.forEach((checkpoint) => {
    checkpointMap[checkpoint.messageId] = checkpoint;
  });

  return checkpointMap;
});
const isCheckpointRestorePending = computed(() => assistant.restoringCheckpointId.value !== null);
const isConversationCheckpointDisabled = computed(
  () => assistant.isSending.value || isCheckpointRestorePending.value,
);
const planStore = computed(() => assistant.agentPlan.store);
const readPlanStoreValue = <T,>(value: T | { value: T }): T => {
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return value.value;
  }

  return value;
};
const planHasPlan = computed(() => readPlanStoreValue(planStore.value.hasPlan));
const planIsClassifying = computed(() => readPlanStoreValue(planStore.value.isClassifying));
const planIsPlanning = computed(() => readPlanStoreValue(planStore.value.isPlanning));
const planClassificationReason = computed(() => readPlanStoreValue(planStore.value.classificationReason));
const planErrorMessage = computed(() => readPlanStoreValue(planStore.value.errorMessage));
const planIsApproving = computed(() => readPlanStoreValue(planStore.value.isApproving));
const planApprovedAt = computed(() => readPlanStoreValue(planStore.value.approvedAt));
const planSummary = computed(() => readPlanStoreValue(planStore.value.planSummary));
const planStatus = computed(() => readPlanStoreValue(planStore.value.planStatus));
const planId = computed(() => readPlanStoreValue(planStore.value.planId));
const planVersion = computed(() => readPlanStoreValue(planStore.value.planVersion));
const planThreadId = computed(() => readPlanStoreValue(planStore.value.planThreadId));
const planCreatedAt = computed(() => readPlanStoreValue(planStore.value.planCreatedAt));
const planUpdatedAt = computed(() => readPlanStoreValue(planStore.value.planUpdatedAt));
const planExecutedAt = computed(() => readPlanStoreValue(planStore.value.planExecutedAt));
const planRejectionReason = computed(() => readPlanStoreValue(planStore.value.planRejectionReason));
const planExecutionErrorMessage = computed(() => readPlanStoreValue(planStore.value.planErrorMessage));
const planVersions = computed(() => readPlanStoreValue(planStore.value.planVersions));
const planActiveRun = computed<IAiAgentRun | null>(() => readPlanStoreValue(planStore.value.activeRun));
const planActiveToolActivity = computed<IAiToolActivityInline | null>(() =>
  readPlanStoreValue(planStore.value.activeToolActivity),
);
const planPendingToolConfirmation = computed(() => readPlanStoreValue(planStore.value.pendingToolConfirmation));
const planSteps = computed<IAiTaskPlanStep[]>(() => readPlanStoreValue(planStore.value.steps));
const planActiveGoal = computed(() => readPlanStoreValue(planStore.value.activeGoal));
const planActiveRunId = computed<string | null>(() => readPlanStoreValue(planStore.value.activeRunId));
const networkPermission = computed(() => readPlanStoreValue(agentNetwork.store.networkPermission));
const setPlanErrorMessage = (message: string): void => {
  Reflect.set(planStore.value, 'errorMessage', message);
};
const hasPlannedAgentState = computed(() =>
  planHasPlan.value ||
  planIsClassifying.value ||
  planIsPlanning.value ||
  Boolean(planErrorMessage.value) ||
  Boolean(planId.value) ||
  Boolean(planStatus.value) ||
  Boolean(planActiveRun.value),
);
const isPlanConfirmationStatus = computed(() =>
  planStatus.value === 'pending_approval' ||
  planStatus.value === 'draft' ||
  planStatus.value === 'rejected' ||
  !planStatus.value,
);
const planConfirmationVisible = computed(() => {
  if (assistant.activeMode.value !== 'plan') {
    return false;
  }

  return planSteps.value.length > 0 &&
    !planActiveRun.value &&
    !planApprovedAt.value &&
    isPlanConfirmationStatus.value;
});
const canApprovePlan = computed(() =>
  planSteps.value.length >= 2 &&
  planSteps.value.length <= 6 &&
  !planActiveRun.value &&
  !planApprovedAt.value &&
  (
    planStatus.value === 'pending_approval' ||
    planStatus.value === 'draft' ||
    !planStatus.value
  ),
);
const canEditPlan = computed(() =>
  !planActiveRun.value &&
  !planApprovedAt.value &&
  !planIsPlanning.value &&
  !planIsApproving.value &&
  !planIsClassifying.value &&
  (
    planStatus.value === 'draft' ||
    !planStatus.value
  ),
);
const visiblePatchPreview = computed(() =>
  assistant.proposedPatch.value ?? assistant.appliedPatchPreview.value,
);
const isVisiblePatchApplied = computed(() =>
  !assistant.proposedPatch.value && Boolean(assistant.appliedPatchPreview.value),
);
const planProgressVisible = computed(() => {
  if (assistant.activeMode.value !== 'plan') {
    return false;
  }

  return Boolean(planActiveRun.value) ||
    Boolean(planActiveToolActivity.value) ||
    Boolean(planPendingToolConfirmation.value && planActiveRun.value) ||
    Boolean(planApprovedAt.value) ||
    planStatus.value === 'approved' ||
    planStatus.value === 'executing' ||
    planStatus.value === 'completed' ||
    planStatus.value === 'failed';
});
const directToolConfirmationVisible = computed(() => {
  if (assistant.activeMode.value !== 'agent') {
    return false;
  }

  return Boolean(planPendingToolConfirmation.value) && !planProgressVisible.value;
});
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

  return webSources.sources.value.length > 0 ||
    Boolean(webSources.activity.value) ||
    Boolean(webSources.errorMessage.value);
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
    .filter((activity) => run.status !== 'paused' || !isLiveToolActivity(activity))
    .map((activity) => ({
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

  const answerByStepId = new Map(stepFinalAnswers.map((answer) => [answer.stepId, answer.content.trim()]));
  const resultLines = run.steps
    .filter((step) => step.status === 'done')
    .map((step) => {
      const answer = answerByStepId.get(step.id);
      return answer
        ? `- ${step.title}：${answer}`
        : `- ${step.title}：已完成。`;
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

  return run.steps.find((step) => step.status === 'running')
    ?? run.steps.find((step) => step.status === 'pending')
    ?? null;
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

  const hasManualInput = assistant.draft.value.trim().length > 0 || assistant.attachedFiles.value.length > 0;

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
  const hasPlanExecutionEstimate = assistant.activeMode.value === 'plan' && tokenEstimationMessages.value.length > 0;

  if (!hasManualInput && !hasPlanExecutionEstimate) {
    return [];
  }

  return assistant.buildSidecarContextReferences(attachmentReferences);
});
const hasPendingTokenRequest = computed(() =>
  assistant.draft.value.trim().length > 0 ||
  assistant.attachedFiles.value.length > 0 ||
  (assistant.activeMode.value === 'plan' && tokenEstimationMessages.value.length > 0),
);
const tokenOfficialUsage = computed(() => {
  if (assistant.activeMode.value !== 'plan') {
    return null;
  }

  return readPlanStoreValue(planStore.value.totalOfficialUsageResolved)
    ? readPlanStoreValue(planStore.value.totalOfficialUsage)
    : null;
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
  if (
    assistant.activeMode.value === 'plan' &&
    (planIsPlanning.value || planIsClassifying.value)
  ) {
    return '正在生成计划';
  }

  return '正在准备回复';
});

if (planStore.value.mode === 'plan' || Boolean(planId.value) || Boolean(planActiveRun.value)) {
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

const isHistoryEventInside = (eventTarget: EventTarget | null): boolean => {
  const targetNode = eventTarget instanceof Node ? eventTarget : null;

  if (!targetNode) {
    return false;
  }

  return Boolean(
    historyAnchorRef.value?.contains(targetNode) ||
    historyPopoverRef.value?.contains(targetNode),
  );
};

const handleHistoryPointerDown = (event: PointerEvent): void => {
  if (!isHistoryOpen.value || assistant.isClearDialogOpen.value) {
    return;
  }

  if (isHistoryEventInside(event.target)) {
    return;
  }

  isHistoryOpen.value = false;
};

const toggleHistoryPopover = (): void => {
  isHistoryOpen.value = !isHistoryOpen.value;
};

const openSettings = (): void => {
  settingsDraft.value = cloneAiConfigPayload(assistant.config.value);
  isHistoryOpen.value = false;
  assistant.isSettingsOpen.value = true;
  assistant.loadProviderProfiles().catch(() => undefined);
};

const startNewConversation = (): void => {
  if (assistant.isSending.value) {
    assistant.stopCurrentRequest();
  }
  isHistoryOpen.value = false;
  assistant.startNewConversation();
};

const openHistoryThread = (threadId: string): void => {
  if (assistant.isSending.value) {
    assistant.stopCurrentRequest();
  }
  assistant.switchConversation(threadId);
  isHistoryOpen.value = false;
};

const openDeleteConversationDialog = (threadId: string): void => {
  pendingDeleteThreadId.value = threadId;
  assistant.isClearDialogOpen.value = true;
};

const cancelClearConversation = (): void => {
  pendingDeleteThreadId.value = null;
  assistant.isClearDialogOpen.value = false;
};

const confirmClearConversation = (): void => {
  const threadId = pendingDeleteThreadId.value;
  pendingDeleteThreadId.value = null;
  assistant.isClearDialogOpen.value = false;

  if (!threadId) {
    return;
  }

  if (assistant.isSending.value && threadId === assistant.activeConversationId.value) {
    assistant.stopCurrentRequest();
  }

  assistant.deleteConversation(threadId);
};

const handleSuggestionSelect = async (suggestion: string): Promise<void> => {
  if (assistant.isSending.value) {
    return;
  }

  assistant.draft.value = suggestion;
  await assistant.sendMessage();
};

const getHistoryTimeLabel = (timestampText: string): string => {
  const timestamp = Date.parse(timestampText);
  if (!Number.isFinite(timestamp)) return '刚刚';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
};

const getConversationCheckpoint = (messageId: string): IAiConversationCheckpoint | null =>
  conversationCheckpointByMessageId.value[messageId] ?? null;

const isConversationCheckpointRestoring = (messageId: string): boolean => {
  const checkpoint = getConversationCheckpoint(messageId);

  return checkpoint !== null && assistant.restoringCheckpointId.value === checkpoint.id;
};

const getConversationCheckpointLabel = (messageId: string): string => {
  const checkpoint = getConversationCheckpoint(messageId);

  if (!checkpoint) {
    return '';
  }

  if (assistant.restoringCheckpointId.value === checkpoint.id) {
    return '正在恢复检查点';
  }

  return `恢复到 ${getHistoryTimeLabel(checkpoint.createdAt)} 检查点`;
};

const handleRestoreConversationCheckpoint = async (messageId: string): Promise<void> => {
  const checkpoint = getConversationCheckpoint(messageId);

  if (!checkpoint || isConversationCheckpointDisabled.value) {
    return;
  }

  await assistant.restoreConversationCheckpoint(checkpoint.id);
};

const getHistoryMessageCountLabel = (messages: IAiChatMessage[]): string => `${messages.length} 条消息`;

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

const getDeleteDialogTitle = (): string => {
  const thread = pendingDeleteThread.value;

  if (!thread) {
    return '删除对话记录？';
  }

  return `删除“${thread.title}”？`;
};

const getDeleteDialogDescription = (): string => {
  const thread = pendingDeleteThread.value;
  const messageCountLabel = thread ? getHistoryMessageCountLabel(thread.messages) : '这条记录';

  return `只会删除这条对话记录（${messageCountLabel}），不会删除文件或其他对话。`;
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

const getActiveAgentRunId = (): string | null =>
  planActiveRunId.value ?? planActiveRun.value?.id ?? null;

const withAgentRunAction = async <T,>(
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
    await agentRun.runPlanToCompletion(
      planActiveGoal.value,
      planSteps.value,
      {
        context: assistant.buildSidecarContextReferences(),
        workspaceRootPath: props.workspaceRootPath,
      },
    );
  } catch (error) {
    setPlanError(error, '批准或启动计划失败。');
  }
};

const handleResetPlan = (): void => {
  assistant.agentPlan.resetPlan();
};

const handleRejectPlan = async (): Promise<void> => {
  try {
    await assistant.agentPlan.rejectPlan('用户拒绝当前计划。');
  } catch (error) {
    setPlanError(error, '拒绝计划失败。');
  }
};

const handleRunStep = async (): Promise<void> => {
  await withAgentRunAction(
    (runId) => agentRun.runStepWithSidecar(runId, {
      goal: planActiveGoal.value,
      context: assistant.buildSidecarContextReferences(),
      workspaceRootPath: props.workspaceRootPath,
    }),
    '执行 Agent step 失败。',
  );
};
const handlePauseRun = async (): Promise<void> => {
  await withAgentRunAction(
    (runId) => agentRun.pauseRun(runId),
    '暂停 Agent run 失败。',
  );
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
  await withAgentRunAction(
    (runId) => agentRun.cancelRun(runId),
    '取消 Agent run 失败。',
  );
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

const switchProviderProfile = async (
  profileId: string,
  feedback: IAiProviderSettingsActionFeedback,
): Promise<void> => {
  try {
    await assistant.switchProviderProfile(profileId);
    settingsApiKey.value = '';
    settingsDraft.value = cloneAiConfigPayload(assistant.config.value);
    feedback.onSuccess('AI 配置已切换');
  } catch (error) {
    feedback.onError(toErrorMessage(error, 'AI 配置切换失败'));
  }
};

const saveCredentials = async (
  apiKey: string,
  role: TAiModelRole,
  feedback: IAiProviderSettingsActionFeedback,
): Promise<void> => {
  try {
    const providerType = role === 'narrator'
      ? settingsDraft.value.narrator.providerType
      : settingsDraft.value.providerType;
    await assistant.saveCredentials(apiKey, providerType, role);
    settingsApiKey.value = '';
    settingsDraft.value = cloneAiConfigPayload(assistant.config.value);
    feedback.onSuccess('API Key 已保存到系统凭证');
  } catch (error) {
    feedback.onError(toErrorMessage(error, 'API Key 保存失败'));
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

const restorePersistedPlanUiState = async (): Promise<void> => {
  if (!hasPlannedAgentState.value && planStore.value.mode !== 'plan') {
    return;
  }

  assistant.activeMode.value = 'plan';
  await assistant.agentPlan.restorePersistedPlanState();
};

onMounted(() => {
  document.addEventListener('pointerdown', handleHistoryPointerDown);
  restorePersistedPlanUiState().catch((error) => {
    setPlanError(error, '恢复计划状态失败。');
  });
  assistant.loadConfig().then(() => {
    settingsDraft.value = cloneAiConfigPayload(assistant.config.value);
  }).catch(() => undefined);
  assistant.loadTools().catch(() => undefined);
  assistant.loadProviderProfiles().catch(() => undefined);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleHistoryPointerDown);
});
</script>

<template>
  <section class="ai-assistant-panel" aria-label="AI 助手面板">
    <header class="ai-panel-header">
      <div class="ai-provider-mark" aria-label="当前 AI 平台和模型" :title="providerMarkTitle">
        <AiProviderIcon class="ai-provider-mark__icon" :platform-id="aiIconPlatformId" decorative />
        <span class="ai-provider-mark__copy">
          <span class="ai-provider-mark__label">{{ aiModelName }}</span>
        </span>
      </div>
      <div class="ai-panel-actions">
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
          <button
            type="button"
            class="ai-icon-button"
            aria-label="对话记录"
            aria-haspopup="dialog"
            :aria-expanded="isHistoryOpen"
            @click="toggleHistoryPopover"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M3 3v5h5" />
              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
              <path d="M12 7v5l4 2" />
            </svg>
          </button>
          <section
            v-if="isHistoryOpen"
            ref="historyPopoverRef"
            class="ai-history-popover"
            role="dialog"
            aria-label="对话记录"
          >
            <header class="ai-history-header">
              <div class="ai-history-title-group">
                <strong>对话记录</strong>
              </div>
              <button
v-if="activeHistoryThread" type="button" class="ai-history-clear-icon"
                aria-label="删除当前对话记录" @click="openDeleteConversationDialog(activeHistoryThread.id)">
                <Trash2 aria-hidden="true" />
              </button>
            </header>
            <div v-if="historyThreads.length" class="ai-history-scroll-area">
              <div class="ai-history-list">
                <article
v-for="thread in historyThreads" :key="thread.id" class="ai-history-item"
                  :class="{ 'is-active': thread.id === assistant.activeConversationId.value }">
                  <button type="button" class="ai-history-button" @click="openHistoryThread(thread.id)">
                    <div class="ai-history-meta">
                      <strong class="ai-history-title">{{ thread.title }}</strong>
                      <time>{{ getHistoryTimeLabel(thread.updatedAt) }}</time>
                    </div>
                    <div class="ai-history-subtitle">{{ getHistoryMessageCountLabel(thread.messages) }}</div>
                  </button>
                  <button
type="button" class="ai-history-delete-button" aria-label="删除这条对话记录"
                    @click.stop="openDeleteConversationDialog(thread.id)">
                    <Trash2 aria-hidden="true" />
                  </button>
                </article>
              </div>
            </div>
            <div v-else class="ai-history-empty">暂无对话记录</div>
          </section>
        </div>
        <slot name="header-actions-after" />
      </div>
    </header>

    <AiChatThread
      :messages="threadMessages"
      :is-typing="assistant.isSending.value"
      :platform-id="aiIconPlatformId"
      :provider-label="aiIconTitle"
      :conversation-id="assistant.activeConversationId.value"
      :workspace-root-path="workspaceRootPath"
      :scroll-state="assistant.activeConversationScrollState.value"
      :typing-label="assistantTypingLabel"
      :has-extra-content="planConfirmationVisible"
      :reverting-changed-files-summary-id="assistant.revertingChangedFilesSummaryId.value"
      @scroll-state-change="handleConversationScrollStateChange"
      @changed-files-rollback="assistant.rollbackChangedFilesSummary"
    >
      <template #empty>
        <AiFloatingSuggestions
:suggestions="suggestionPool.suggestions.value" :disabled="assistant.isSending.value"
          @select="handleSuggestionSelect" />
      </template>
      <template #after-message="{ message }">
        <Checkpoint v-if="getConversationCheckpoint(message.id)" class="ai-conversation-checkpoint">
          <CheckpointTrigger
class="ai-conversation-checkpoint__trigger" :disabled="isConversationCheckpointDisabled"
            @click="handleRestoreConversationCheckpoint(message.id)">
            <CheckpointIcon class="ai-conversation-checkpoint__icon" aria-hidden="true" />
            <span class="ai-conversation-checkpoint__label">{{ getConversationCheckpointLabel(message.id) }}</span>
            <Loader
v-if="isConversationCheckpointRestoring(message.id)" class="ai-conversation-checkpoint__loader"
              :size="12" />
            <span v-else class="ai-conversation-checkpoint__spacer" aria-hidden="true"></span>
          </CheckpointTrigger>
        </Checkpoint>
      </template>
      <template #after-messages>
        <AiPlanConfirmationMessage
          v-if="planConfirmationVisible"
          :goal="planActiveGoal"
          :summary="planSummary"
          :status="planStatus"
          :steps="planSteps"
          :is-planning="planIsPlanning"
          :is-approving="planIsApproving"
          :can-edit="canEditPlan"
          :can-approve="canApprovePlan"
          :approved-at="planApprovedAt"
          @update-step-title="handleUpdatePlanStepTitle"
          @remove-step="handleRemovePlanStep"
          @regenerate="handleRegeneratePlan"
          @reject="handleRejectPlan"
          @approve="handleApprovePlan"
        />
      </template>
    </AiChatThread>
    <div v-if="fileRollbackPrompt" class="ai-file-rollback-entry" :class="`is-${fileRollbackPrompt.status}`">
      <span class="ai-file-rollback-entry__line" aria-hidden="true"></span>
      <button
type="button" class="ai-file-rollback-entry__button" :disabled="isFileRollbackDisabled"
        :aria-label="fileRollbackLabel" @click="assistant.rollbackLatestFileChange">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M3 7v5h5" />
          <path d="M21 17a8 8 0 0 0-13.66-5.66L3 16" />
        </svg>
        <span>{{ fileRollbackLabel }}</span>
      </button>
      <span class="ai-file-rollback-entry__line" aria-hidden="true"></span>
    </div>
    <AiPatchPreview
      :patch="visiblePatchPreview" :is-applying="assistant.isApplyingPatch.value"
      :is-applied="isVisiblePatchApplied" :workspace-root-path="workspaceRootPath"
      @apply="assistant.applyProposedPatch"
      @close="assistant.proposedPatch.value = null; assistant.appliedPatchPreview.value = null"
      @open-diff="emit('open-patch-diff', $event)" />
    <div v-if="assistant.canPreviewPatch.value" class="ai-patch-entry">
      <span class="ai-patch-entry__line" aria-hidden="true"></span>
      <button type="button" class="ai-patch-entry__button" @click="assistant.previewPatchFromLastAnswer">
        <span>预览为 Patch</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <circle cx="6" cy="6" r="2" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="18" cy="18" r="2" />
          <path d="M8 6h4a4 4 0 0 1 4 4v6" />
        </svg>
      </button>
      <span class="ai-patch-entry__line" aria-hidden="true"></span>
    </div>
    <AiWebSourcesPanel
v-if="webSourcesVisible" :sources="webSources.sources.value"
      :activity="planProgressVisible ? null : webSources.activity.value" :error-message="webSources.errorMessage.value"
      :is-searching="webSources.isSearching.value" :network-permission="networkPermission"
      @search="handleSearchWebSources" @fetch-source="handleFetchWebSource" @clear="webSources.clear" />
    <div class="ai-composer-shell" :class="{ 'has-plan': planProgressVisible }">
      <AiPlanModePanel
v-if="planProgressVisible" :goal="planActiveGoal" :plan-summary="planSummary"
        :plan-status="planStatus" :plan-id="planId" :plan-version="planVersion" :plan-thread-id="planThreadId"
        :plan-created-at="planCreatedAt" :plan-updated-at="planUpdatedAt" :plan-executed-at="planExecutedAt"
        :plan-rejection-reason="planRejectionReason" :plan-error-message="planExecutionErrorMessage"
        :plan-versions="planVersions" :steps="planSteps"
        :classification-reason="planClassificationReason" :error-message="planErrorMessage"
        :is-classifying="planIsClassifying" :is-planning="planIsPlanning" :is-approving="planIsApproving"
        :approved-at="planApprovedAt" :active-run="planActiveRun" :is-run-action-pending="isAgentRunActionPending"
        :web-activity="webSources.activity.value" :tool-activity="planActiveToolActivity"
        :tool-confirmation="planPendingToolConfirmation" @update-step-title="handleUpdatePlanStepTitle"
        @remove-step="handleRemovePlanStep" @regenerate="handleRegeneratePlan" @reject="handleRejectPlan" @approve="handleApprovePlan"
        @reset="handleResetPlan" @run-step="handleRunStep" @pause-run="handlePauseRun" @resume-run="handleResumeRun"
        @cancel-run="handleCancelRun" @resolve-tool-confirmation="handleResolveToolConfirmation" />
      <div v-if="directToolConfirmationVisible && planPendingToolConfirmation" class="ai-direct-tool-confirmation">
        <AiToolConfirmationCard
:confirmation="planPendingToolConfirmation" :disabled="isAgentRunActionPending"
          @resolve="handleResolveToolConfirmation" />
      </div>
      <AiPromptInput
v-model="assistant.draft.value" v-model:active-mode="assistant.activeMode.value"
        :disabled="assistant.isSending.value" :error-message="assistant.errorMessage.value" :submit-label="submitLabel"
        :provider-label="aiIconTitle" :attachments="assistant.attachedFiles.value"
        :has-attachments="assistant.attachedFiles.value.length > 0" :token-context="tokenContextProps"
        @submit="assistant.sendMessage" @stop="assistant.stopCurrentRequest" @file-selected="assistant.attachFile"
        @remove-file="assistant.removeAttachedFile" />
    </div>

    <AiProviderSettings
v-model:draft="settingsDraft" v-model:api-key="settingsApiKey"
      :open="assistant.isSettingsOpen.value" :config="assistant.config.value"
      :profiles="assistant.providerProfiles.value" :load-profile-detail="assistant.getProviderProfileDetail"
      @close="assistant.isSettingsOpen.value = false" @save="saveSettings" @save-credentials="saveCredentials"
      @test-provider="testProvider" @switch-profile="switchProviderProfile" />

    <Teleport to="body">
      <div v-if="assistant.isClearDialogOpen.value" class="ai-dialog-backdrop" @click.self="cancelClearConversation">
        <section class="ai-dialog is-compact" role="alertdialog" aria-modal="true">
          <div class="ai-dialog-copy">
            <h3>{{ getDeleteDialogTitle() }}</h3>
            <p>{{ getDeleteDialogDescription() }}</p>
          </div>
          <div class="ai-dialog-actions">
            <button type="button" class="ai-button is-ghost" @click="cancelClearConversation">取消</button>
            <button type="button" class="ai-button is-danger" @click="confirmClearConversation">删除</button>
          </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.ai-assistant-panel {
  display: flex;
  width: 100%;
  min-width: 0;
  max-width: none;
  height: 100%;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow-x: hidden;
  background: var(--sidebar-bg);
  color: var(--text-primary);
}

.ai-panel-header {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  height: 40px;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 12px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.ai-provider-mark {
  display: inline-flex;
  min-width: 0;
  max-width: min(48%, 320px);
  flex: 0 1 auto;
  align-items: center;
  gap: 10px;
  border-radius: 7px;
  color: var(--text-primary);
}

.ai-provider-mark__icon {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
}

.ai-provider-mark__copy {
  min-width: 0;
  display: inline-flex;
  align-items: center;
}

.ai-provider-mark__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
}

.ai-panel-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  margin-left: auto;
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

.ai-patch-entry,
.ai-conversation-checkpoint,
.ai-file-rollback-entry {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 0;
}

.ai-conversation-checkpoint {
  padding-left: 0px;
  color: var(--text-quaternary);
}

.ai-conversation-checkpoint__trigger {
  display: inline-grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 6px;
  height: auto;
  border: 0;
  padding: 0 2px;
  color: inherit;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
}

.ai-conversation-checkpoint__label {
  text-align: center;
}

.ai-conversation-checkpoint__trigger:hover {
  color: var(--text-secondary);
}

.ai-conversation-checkpoint__trigger:disabled {
  cursor: default;
  opacity: 0.72;
}

.ai-conversation-checkpoint__icon,
.ai-conversation-checkpoint__loader,
.ai-conversation-checkpoint__spacer {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
}

.ai-patch-entry__line,
.ai-file-rollback-entry__line {
  height: 1px;
  flex: 1 1 auto;
  min-width: 18px;
  background: color-mix(in srgb, var(--shell-divider) 86%, transparent);
}

.ai-patch-entry__button,
.ai-file-rollback-entry__button,
.ai-button {
  height: 28px;
  border-radius: 6px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 500;
}

.ai-patch-entry__button,
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

.ai-patch-entry__button:hover,
.ai-file-rollback-entry__button:not(:disabled):hover {
  color: var(--text-primary);
}

.ai-patch-entry__button:focus-visible,
.ai-file-rollback-entry__button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong) 60%, transparent);
  outline-offset: 4px;
}

.ai-patch-entry__button svg,
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
  flex: 0 0 auto;
  background: #ffffff;
}

.ai-composer-shell.has-plan {
  background: transparent;
}

.ai-composer-shell :global(.ai-plan-mode-panel) {
  border-top: 0;
  background: transparent;
  padding: 0 0 calc(var(--app-density-scale) * 0.125rem);
}

.ai-direct-tool-confirmation {
  padding: 8px 10px 0;
}

.ai-composer-shell :global(.ai-composer) {
  background: #ffffff;
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

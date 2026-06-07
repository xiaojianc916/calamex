<script setup lang="ts">
import { useFrontendTool } from '@copilotkit/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { z } from 'zod';
import Checkpoint from '@/components/ai-elements/checkpoint/Checkpoint.vue';
import CheckpointIcon from '@/components/ai-elements/checkpoint/CheckpointIcon.vue';
import CheckpointTrigger from '@/components/ai-elements/checkpoint/CheckpointTrigger.vue';
import { Loader } from '@/components/ai-elements/loader';
import AiChatThread from '@/components/business/ai/chat/AiChatThread.vue';
import AiErrorNotice from '@/components/business/ai/chat/AiErrorNotice.vue';
import AiPromptInput from '@/components/business/ai/chat/AiPromptInput.vue';
import AiPlanConfirmationMessage from '@/components/business/ai/plan/AiPlanConfirmationMessage.vue';
import AiPlanModePanel from '@/components/business/ai/plan/AiPlanModePanel.vue';
import AiProviderIcon from '@/components/business/ai/provider/AiProviderIcon.vue';
import AiProviderSettings from '@/components/business/ai/provider/AiProviderSettings.vue';
import AiPanelFrame from '@/components/business/ai/shell/AiPanelFrame.vue';
import AiToolConfirmationCard from '@/components/business/ai/shell/AiToolConfirmationCard.vue';
import AiWebSourcesPanel from '@/components/business/ai/web/AiWebSourcesPanel.vue';
import { useAiAgentNetwork } from '@/composables/ai/useAiAgentNetwork';
import { useAiAgentRun } from '@/composables/ai/useAiAgentRun';
import { type IAiConversationCheckpoint, useAiAssistant } from '@/composables/ai/useAiAssistant';
import { useAiTokenContext } from '@/composables/ai/useAiTokenContext';
import { useAiWebSources } from '@/composables/ai/useAiWebSources';
import { useCopilotContext } from '@/composables/ai/useCopilotContext';
import { useCopilotSuggestions } from '@/composables/ai/useCopilotSuggestions';
import { findAiServicePlatformByModel } from '@/constants/ai/providers';
import { aiService } from '@/services/ipc/ai.service';
import { cloneAiConfigPayload, resolveDefaultAiBaseUrl } from '@/services/ipc/ai-config.service';
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
import type {
  IActiveRunSummary,
  IAnalyzeScriptPayload,
  IEditorDocument,
  IEditorSelectionSummary,
} from '@/types/editor';
import type { IGitDiffPreviewPayload, IGitRepositoryStatusPayload } from '@/types/git';
import { toErrorMessage } from '@/utils/error';

const splitSuggestionsIntoRows = <T extends { title: string }>(
  items: readonly T[],
  rowCount: number,
): T[][] => {
  if (items.length === 0) {
    return [];
  }

  const effectiveRowCount = Math.min(rowCount, items.length);

  if (effectiveRowCount <= 1) {
    return [items.slice()];
  }

  const totalWeight = items.reduce((sum, item) => sum + item.title.length + 2, 0);
  const targetWeight = totalWeight / effectiveRowCount;

  const rows: T[][] = [];
  let currentRow: T[] = [];
  let currentWeight = 0;
  let rowsRemaining = effectiveRowCount;

  items.forEach((item, index) => {
    currentRow.push(item);
    currentWeight += item.title.length + 2;

    const rowsLeftAfterBreak = rowsRemaining - 1;
    const itemsLeftAfterCurrent = items.length - index - 1;
    const shouldBreakRow =
      rowsLeftAfterBreak > 0 &&
      currentWeight >= targetWeight &&
      itemsLeftAfterCurrent >= rowsLeftAfterBreak;

    if (shouldBreakRow) {
      rows.push(currentRow);
      currentRow = [];
      currentWeight = 0;
      rowsRemaining -= 1;
    }
  });

  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows;
};

const MAX_HISTORY_THREADS = 20;

const HISTORY_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const HISTORY_DATE_FORMAT_SAME_YEAR = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
});
const HISTORY_DATE_FORMAT_FULL = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

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
const suggestionPool = useCopilotSuggestions();
const suggestionRows = computed(() =>
  splitSuggestionsIntoRows(suggestionPool.suggestions.value, 3),
);

// Share editor state with CopilotKit agent
useCopilotContext({
  document: documentRef,
  activeRun: activeRunRef,
  analysis: analysisRef,
  selection: selectionRef,
  gitStatus: gitStatusRef,
  workspaceRootPath: workspaceRootPathRef,
});

// Register CopilotKit frontend tools — replaces manual tool activity tracking.
// Catch-all registration for Mastra tools; HITL intercepts approval-required events.
try {
  useFrontendTool({ name: '*', parameters: z.object({}).passthrough(), handler: async () => 'ok' });
} catch {
  /* provider not ready */
}

const settingsDraft = ref<IAiConfigPayload>(cloneAiConfigPayload(assistant.config.value));
const settingsApiKey = ref('');
const settingsTavilyApiKey = ref('');
const isAgentRunActionPending = ref(false);
const isPromptModelSaving = ref(false);
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
const historyThreads = computed(() =>
  [...assistant.historyThreads.value]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_HISTORY_THREADS),
);
const activeHistoryThread = computed(
  () =>
    assistant.historyThreads.value.find(
      (thread) => thread.id === assistant.activeConversationId.value,
    ) ?? null,
);
const pendingDeleteThread = computed(
  () =>
    assistant.historyThreads.value.find((thread) => thread.id === pendingDeleteThreadId.value) ??
    null,
);
const conversationCheckpointByMessageId = computed<Record<string, IAiConversationCheckpoint>>(
  () => {
    const checkpointMap: Record<string, IAiConversationCheckpoint> = {};

    assistant.conversationCheckpoints.value.forEach((checkpoint) => {
      checkpointMap[checkpoint.messageId] = checkpoint;
    });

    return checkpointMap;
  },
);
const isCheckpointRestorePending = computed(() => assistant.restoringCheckpointId.value !== null);
const isConversationCheckpointDisabled = computed(
  () => assistant.isSending.value || isCheckpointRestorePending.value,
);
const planStore = computed(() => assistant.agentPlan.store);

const planHasPlan = computed(() => planStore.value.hasPlan);
const planIsClassifying = computed(() => planStore.value.isClassifying);
const planIsPlanning = computed(() => planStore.value.isPlanning);
const planClassificationReason = computed(() => planStore.value.classificationReason);
const planErrorMessage = computed(() => planStore.value.errorMessage);
const planIsApproving = computed(() => planStore.value.isApproving);
const planApprovedAt = computed(() => planStore.value.approvedAt);
const planSummary = computed(() => planStore.value.planSummary);
const planStatus = computed(() => planStore.value.planStatus);
const planId = computed(() => planStore.value.planId);
const planVersion = computed(() => planStore.value.planVersion);
const planThreadId = computed(() => planStore.value.planThreadId);
const planCreatedAt = computed(() => planStore.value.planCreatedAt);
const planUpdatedAt = computed(() => planStore.value.planUpdatedAt);
const planExecutedAt = computed(() => planStore.value.planExecutedAt);
const planRejectionReason = computed(() => planStore.value.planRejectionReason);
const planExecutionErrorMessage = computed(() => planStore.value.planErrorMessage);
const planVersions = computed(() => planStore.value.planVersions);
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
const planSteps = computed<IAiTaskPlanStep[]>(() => planStore.value.steps);
const planActiveGoal = computed(() => planStore.value.activeGoal);
const planActiveRunId = computed<string | null>(() => planStore.value.activeRunId);
const networkPermission = computed(() => agentNetwork.store.networkPermission);
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
const canApprovePlan = computed(
  () =>
    planSteps.value.length >= 2 &&
    planSteps.value.length <= 6 &&
    !planActiveRun.value &&
    !planApprovedAt.value &&
    (planStatus.value === 'pending_approval' || planStatus.value === 'draft' || !planStatus.value),
);
const canEditPlan = computed(
  () =>
    !planActiveRun.value &&
    !planApprovedAt.value &&
    !planIsPlanning.value &&
    !planIsApproving.value &&
    !planIsClassifying.value &&
    (planStatus.value === 'draft' || !planStatus.value),
);
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
const directToolConfirmationVisible = computed(() => {
  if (assistant.activeMode.value !== 'agent') {
    return false;
  }

  return Boolean(visibleDirectToolConfirmation.value) && !planProgressVisible.value;
});
const composerDisabled = computed(
  () => assistant.isSending.value || Boolean(visibleDirectToolConfirmation.value),
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

  const hasManualInput = assistant.draft.value.trim()...<response clipped>
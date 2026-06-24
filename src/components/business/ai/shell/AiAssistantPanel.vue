<script setup lang="ts">
import { useFrontendTool } from '@copilotkit/vue';
import { Bot, SquarePen, Trash2 } from '@lucide/vue';
import { AnimatePresence, Motion } from 'motion-v';
import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
import { z } from 'zod';
import {
  ApprovalPrompt,
  resolveAcpDecisionFromAskUserResult,
} from '@/components/ai-elements/approval';
import AiChatThread from '@/components/business/ai/chat/AiChatThread.vue';
import AiErrorNotice from '@/components/business/ai/chat/AiErrorNotice.vue';
import AiPromptInput from '@/components/business/ai/chat/AiPromptInput.vue';
import AiProviderIcon from '@/components/business/ai/provider/AiProviderIcon.vue';
import AiAssistantCheckpointEntry from '@/components/business/ai/shell/AiAssistantCheckpointEntry.vue';
import AiAssistantSuggestionEmpty from '@/components/business/ai/shell/AiAssistantSuggestionEmpty.vue';
import AiPanelFrame from '@/components/business/ai/shell/AiPanelFrame.vue';
import { splitSuggestionsIntoRows } from '@/components/business/ai/shell/split-suggestions';
import AiThreadRunStatusBar from '@/components/business/ai/thread/AiThreadRunStatusBar.vue';
import { deriveThreadPlanDetails } from '@/components/business/ai/thread/projection';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { useAcpApproval } from '@/composables/ai/useAcpApproval';
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
import type { IAiThreadEntry } from '@/types/ai/thread';
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

// \u542f\u52a8\u6253\u70b9\uff08\u9636\u6bb50\u00b7\u91cf\u5316\uff09\uff1aAI \u9762\u677f\u771f\u8eab setup \u8d77\u70b9\uff0c\u7528\u4e8e\u5b9a\u4f4d\u9996\u5c4f\u8017\u65f6\u5206\u5e03\u3002
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
// ACP \u5de5\u5177\u8c03\u7528\u5ba1\u6279\u95ed\u73af\uff08ADR-20260617 D6\uff09\uff1a\u8ba2\u9605\u5bbf\u4e3b\u7ecf ai:sidecar-approval \u62b9\u6765\u7684\u53cd\u5411\n// session/request_permission\uff0c\u5728\u9762\u677f\u5185\u6e32\u67d3\u5ba1\u6279\u6d6e\u5c42\u5e76\u628a\u7528\u6237\u51b3\u7b56\u539f\u6587\u56de\u6295\u3002\u6b64\u524d\u8be5\u95ed\u73af\u7ec4\u5408\u5f0f\n// \u4ece\u672a\u5728\u4efb\u610f\u5df2\u6302\u8f7d\u7ec4\u4ef6\u4e2d\u5b9e\u4f8b\u5316\uff0c\u5bfc\u81f4 Kimi \u7b49\u5916\u90e8 Agent \u7533\u8bf7\u5de5\u5177\u6743\u9650\u65f6\u65e0 UI \u5448\u73b0\uff0c\n// \u7533\u8bf7\u88ab\u6c38\u4e45\u6302\u8d77\u3001\u56de\u5408\u5361\u5728\u201c\u601d\u8003\u4e2d\u201d\u2014\u2014\u6b63\u662f\u6587\u4ef6\u4fee\u6539\u4e00\u76f4\u5361\u4f4f\u7684\u6839\u56e0\u4e4b\u4e8c\u3002
const acpApproval = useAcpApproval();
const acpApprovalCurrent = computed(() => acpApproval.current.value);
// Kimi \u7b49\u5916\u90e8 ACP Agent \u7684 AskUserQuestion \u540c\u6837\u7ecf\u53cd\u5411 request_permission \u62b5\u8fbe\uff1b\u82e5\u8bc6\u522b\u4e3a\u63d0\u95ee\uff0c\n// \u6539\u7528\u9879\u76ee\u65e2\u6709\u7684 QuestionPrompt \u53cd\u5411\u63d0\u95ee UI \u5448\u73b0\uff0c\u800c\u975e\u901a\u7528\u5de5\u5177\u5ba1\u6279\u5361\u7247\u3002
const acpApprovalQuestions = computed(() => acpApprovalCurrent.value?.askUserQuestions ?? null);
const aiThreadStore = useAiThreadStore();
const renderThreadEntries = computed(() => aiThreadStore.renderActiveEntries);
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

// \u5f53\u524d\u4f1a\u8bdd\u4f7f\u7528\u7684 Agent \u540e\u7aef\uff08\u81ea\u7814 / Kimi\uff09\u3002\u4f1a\u8bdd\u7ea7\u5355\u9009\uff0c\u4e00\u4e2a\u4f1a\u8bdd\u53ea\u7528\u4e00\u79cd Agent\u3002
// Kimi \u7b49\u5916\u90e8 Agent \u7ecf agent_sidecar_external_chat\uff08\u6807\u51c6 session/prompt\uff09\u53d1\u9001\uff0c\u7531\n// useAiAssistant.sendMessage \u636e\u6b64 backend \u5206\u6d41\u5230\u5916\u90e8 ACP \u53d1\u9001\u94fe\u8def\u3002
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

// kimi \u4f1a\u8bdd\u5411\u8f93\u5165\u6846\u900f\u4f20 ACP \u516c\u793a\u547d\u4ee4\uff0c\u4f9b\u659c\u6760\u83dc\u5355\u4f5c\u4e3a\u5185\u7f6e\u547d\u4ee4\u5217\u8868\uff1b\u5176\u5b83 Agent \u4e0d\u900f\u4f20\uff08\u7528\u81ea\u7814\u6280\u80fd\uff09\u3002
const kimiSlashCommands = computed(() =>
  sessionAgentBackend.value === 'kimi' ? assistant.acpAvailableCommands.commands.value : undefined,
);

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

// \u542f\u52a8\u6253\u70b9\uff08\u9636\u6bb50\u00b7\u91cf\u5316\uff09\uff1a\u6838\u5fc3 composable \u521d\u59cb\u5316\u5b8c\u6210\u3002
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
// \u7ec4\u5408\u5668\u5185\u8054\u63d0\u95ee\uff1aAiPromptInput \u5185\u5d4c\u63d0\u95ee\u6846\u7684\u7b54\u6848 / \u53d6\u6d88\uff0c\u8def\u7531\u5230\u65e2\u6709 ACP / plan \u63d0\u95ee\u5904\u7406\u5668\u3002
const handleComposerQuestionSubmit = (answers: NonNullable<IAskUserResult['answers']>): void => {
  const result: IAskUserResult = { outcome: 'selected', answers };
  if (acpApprovalQuestions.value) {
    void handleResolveAcpUserQuestion(result);
    return;
  }
  if (visibleUserQuestion.value) {
    void handleResolveUserQuestion(result);
  }
};
const handleComposerQuestionCancel = (): void => {
  if (acpApprovalQuestions.value) {
    void handleCancelAcpUserQuestion();
    return;
  }
  if (visibleUserQuestion.value) {
    void handleCancelUserQuestion();
  }
};
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
// Plan \u5ba1\u6279\u4f5c\u4e3a\u5e73\u94fa\u65f6\u95f4\u7ebf\u91cc\u7684\u4e00\u6761 plan-control \u6761\u76ee\uff1a\u7b49\u5f85\u6279\u51c6\u65f6\u5408\u6210\u4e00\u6761\u6570\u636e\u6a21\u578b
// plan_control entry\uff0c\u8ffd\u52a0\u8fdb\u5582\u7ed9 AiChatThread \u7684 thread-entries\uff0c\u7531 threadEntriesToTimeline
// \u6295\u5f71\u4e3a plan-control \u6e32\u67d3\u6761\u76ee\u3002\u5ba1\u6279\u6001\u662f planStore \u6d3e\u751f\u7684\u4e34\u65f6\u6001\uff0c\u6545\u53ea\u5728\u6e32\u67d3\u671f overlay\uff0c
// \u4e0d\u843d reduce \u6301\u4e45\u5316\uff1a\u6279\u51c6/\u62d2\u7edd\u540e\u5b83\u968f planConfirmationVisible \u81ea\u7136\u6d88\u5931\uff0c\u4e0d\u6b8b\u7559\u5e7d\u7075\u5361\u3002
const planControlEntry = computed<IAiThreadEntry | null>(() => {
  if (!planConfirmationVisible.value) {
    return null;
  }

  const goal = planActiveGoal.value.trim();

  if (goal.length === 0) {
    return null;
  }

  return {
    type: 'plan_control',
    id: 'thread-plan-control',
    createdAt: planCreatedAt.value ?? new Date().toISOString(),
    goal,
    references: [],
    phase: 'awaiting-approval',
  };
});
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
// \u8fd0\u884c\u8fdb\u5ea6/\u5de5\u5177\u786e\u8ba4\u6536\u655b\u5230\u8f93\u5165\u6846\u4e0a\u65b9\u7684 Codex \u98ce\u683c\u7ec6\u6761\uff1b\u53ea\u5728\u8ba1\u5212\u771f\u6b63\u6267\u884c\uff08\u6709 run\uff09\u6216
// \u51fa\u73b0\u5de5\u5177\u786e\u8ba4\u65f6\u663e\u793a\uff0c\u7528\u4e8e\u6291\u5236 Web \u6765\u6e90\u9762\u677f\u91cc\u91cd\u590d\u7684\u6d3b\u52a8\u6307\u793a\u3002
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
    (acpApproval.hasPending.value && !acpApprovalQuestions.value),
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
  const withoutEllipsis = source.replace(/\u2026+$/u, '').trim();
  const withoutPrefix = withoutEllipsis
    .replace(/^\u6b63\u5728(?:\u8bfb\u53d6|\u641c\u7d22|\u52a0\u8f7d|\u4f7f\u7528|\u5e94\u7528|\u751f\u6210|\u9a8c\u8bc1|\u6267\u884c)\s*[\uff1a:\uff1a]?\s*/u, '')
    .replace(/^\u5df2(?:\u8bfb\u53d6|\u641c\u7d22|\u52a0\u8f7d|\u4f7f\u7528|\u5e94\u7528|\u751f\u6210|\u9a8c\u8bc1|\u6267\u884c)\s*[\uff1a:\uff1a]?\s*/u, '')
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
    return `\u8ba1\u5212\u6267\u884c\u5931\u8d25\uff1a${run.errorMessage ?? '\u6267\u884c\u8fc7\u7a0b\u4e2d\u51fa\u73b0\u9519\u8bef\u3002'}`;
  }

  if (run.status === 'cancelled') {
    return '\u8ba1\u5212\u6267\u884c\u5df2\u53d6\u6d88\u3002';
  }

  const answerByStepId = new Map(
    stepFinalAnswers.map((answer) => [answer.stepId, answer.content.trim()]),
  );
  const resultLines = run.steps
    .filter((step) => step.status === 'done')
    .map((step) => {
      const answer = answerByStepId.get(step.id);
      return answer ? `- ${step.title}\uff1a${answer}` : `- ${step.title}\uff1a\u5df2\u5b8c\u6210\u3002`;
    });

  return [
    '\u5df2\u5b8c\u6210\u8fd9\u8f6e\u8ba1\u5212\u6267\u884c\u3002',
    ...(resultLines.length ? ['', '\u6267\u884c\u7ed3\u679c\uff1a', ...resultLines] : []),
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
  const toolList = step.tools.length ? step.tools.join(', ') : '\u672a\u9650\u5b9a\uff0c\u6309\u4efb\u52a1\u9700\u8981\u9009\u62e9\u53ef\u7528\u5de5\u5177';

  return [
    {
      id: `plan-token-system:${step.id}`,
      role: 'system',
      content: [
        '\u4f60\u6b63\u5728\u6267\u884c IDE Agent Plan \u7684\u5355\u4e2a\u6b65\u9aa4\u3002',
        '\u5fc5\u987b\u56f4\u7ed5\u5f53\u524d\u6b65\u9aa4\u76ee\u6807\u8c03\u7528\u53ef\u7528\u5de5\u5177\uff1b\u4e0d\u8981\u6267\u884c\u4e0e\u5f53\u524d\u6b65\u9aa4\u65e0\u5173\u7684\u64cd\u4f5c\u3002',
        '\u5982\u679c\u9700\u8981\u9ad8\u98ce\u9669\u5de5\u5177\uff0c\u8bf7\u901a\u8fc7 sidecar approval \u4e8b\u4ef6\u7b49\u5f85\u7528\u6237\u786e\u8ba4\u3002',
        '\u5199\u76d8\u3001\u5220\u9664\u3001\u547d\u4ee4\u3001\u5b89\u88c5\u4f9d\u8d56\u548c Git \u64cd\u4f5c\u90fd\u5fc5\u987b\u4fdd\u7559\u53ef\u56de\u6eda\u8bed\u4e49\u3002',
      ].join('\n'),
      createdAt,
      references: [],
    },
    {
      id: `plan-token-user:${step.id}`,
      role: 'user',
      content: [
        `\u4efb\u52a1\u76ee\u6807\uff1a${goal}`,
        `\u5f53\u524d\u6b65\u9aa4\uff1a${step.title}`,
        `\u6b65\u9aa4\u76ee\u6807\uff1a${step.goal}`,
        `\u9884\u671f\u4ea7\u7269\uff1a${step.expectedOutput}`,
        `\u5efa\u8bae\u5de5\u5177\uff1a${toolList}`,
        '\u8bf7\u6267\u884c\u8fd9\u4e2a\u6b65\u9aa4\uff0c\u5e76\u5728\u5b8c\u6210\u540e\u7ed9\u51fa\u7b80\u77ed\u7ed3\u8bba\u3002',
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
  let content = 'Agent \u6b63\u5728\u6267\u884c\u8ba1\u5212\u3002';

  if (run?.status === 'paused') {
    content = '\u8ba1\u5212\u5df2\u6682\u505c\uff0c\u70b9\u51fb\u7ee7\u7eed\u540e\u4f1a\u4ece\u672a\u5b8c\u6210\u6b65\u9aa4\u6062\u590d\u6267\u884c\u3002';
  } else if (run && isTerminalRun) {
    content = buildPlanRunFinalAnswer(run, stepFinalAnswers);
  } else if (latestToolCall) {
    content = `AI \u6b63\u5728\u81ea\u52a8\u4f7f\u7528\u5de5\u5177\uff1a${latestToolCall.summary}`;
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

// \u65e7\u7684 agent-flow synthetic message \u4ec5\u7528\u4e8e token usage \u4f30\u7b97\uff0c\u4e0d\u518d\u8fdb\u5165\u53ef\u89c1\u65f6\u95f4\u7ebf\uff1b
// AiChatThread \u4f1a\u6309 `agent-flow:` \u524d\u7f00\u5c06\u5176\u8fc7\u6ee4\u6389\u3002
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
// \u771f\u6b63\u5582\u7ed9\u5e73\u94fa\u65f6\u95f4\u7ebf\u7684 entries\uff1areduce \u771f\u6e90 entries + \u53ef\u9009\u7684 plan-control \u5ba1\u6279\u6761\u76ee\uff08\u6e32\u67d3\u671f overlay\uff09\u3002
const visibleThreadEntries = computed<readonly IAiThreadEntry[]>(() => {
  const controlEntry = planControlEntry.value;

  if (!controlEntry) {
    return renderThreadEntries.value;
  }

  return [...renderThreadEntries.value, controlEntry];
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
  // \u63a5\u6536\u4fa7 ACP usage_update \u95ed\u73af\uff08ADR-20260617 \u00b7 D7-\u2466\uff09\uff1a\u5bbf\u4e3b\u5df2\u628a usage_update \u6295\u5f71\u4e3a
  // \u5171\u4eab IAiLanguageModelUsage VM\u3002\u4efb\u4e00\u6a21\u5f0f\u53ea\u8981\u672c\u56de\u5408\u6709 ACP \u7528\u91cf\u5c31\u4f18\u5148\u91c7\u7528\uff08chat / agent
  // \u7ecf ACP host \u4e0a\u62a5\uff09\uff1b\u5176\u5f62\u72b6\u4e0e\u5916\u90e8 LanguageModelUsage \u8d4b\u503c\u517c\u5bb9\uff0c\u53ef\u76f4\u63a5\u4f5c\u4e3a\u5b98\u65b9\u7528\u91cf\u6765\u6e90\u3002
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
    return '\u751f\u6210\u8ba1\u5212';
  }

  if (assistant.activeMode.value === 'agent') {
    return '\u5f00\u59cb\u6267\u884c';
  }

  return assistant.sendButtonLabel.value;
});
const assistantTypingLabel = computed(() => {
  if (assistant.activeMode.value === 'plan' && (planIsPlanning.value || planIsClassifying.value)) {
    return '\u6b63\u5728\u751f\u6210\u8ba1\u5212';
  }

  return '\u6b63\u5728\u51c6\u5907\u56de\u590d';
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
    return '\u6b63\u5728\u56de\u6eda AI \u6587\u4ef6\u4fee\u6539';
  }

  if (prompt.status === 'reverted') {
    return '\u5df2\u56de\u6eda AI \u6700\u8fd1\u4e00\u6b21\u6587\u4ef6\u4fee\u6539';
  }

  return 'AI \u5df2\u4fee\u6539\u6587\u4ef6\uff0c\u53ef\u56de\u6eda\u6700\u8fd1\u4e00\u6b21';
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

// \u5207\u6362\u4f1a\u8bdd Agent \u540e\u7aef\u540e\uff0c\u6e05\u6389\u4e0a\u4e00\u6761\uff08\u53ef\u80fd\u662f Kimi \u672a\u63a5\u5165\uff09\u7684\u9519\u8bef\u63d0\u793a\u3002
const handleAgentBackendChange = (agent: unknown): void => {
  if (!isSessionAgentBackend(agent)) {
    return;
  }

  sessionAgentBackend.value = agent;
  assistant.error.value = '';
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
    setPlanError(error, '\u7f51\u7edc\u641c\u7d22\u5931\u8d25\u3002');
  }
};
const handleFetchWebSource = async (sourceId: string): Promise<void> => {
  try {
    await webSources.fetchSource(sourceId);
  } catch (error) {
    setPlanError(error, '\u7f51\u9875\u8bfb\u53d6\u5931\u8d25\u3002');
  }
};

// \u4e3b\u6a21\u578b\u9009\u62e9\u5668\u53d8\u66f4\uff1a\u53ea\u5bf9 builtin\uff08mastra \u5168\u5c40\u6a21\u578b\uff09\u751f\u6548\uff0c\u628a selectedModel \u6301\u4e45\u5316\u5230 ai.json\u3002
// kimi \u7b49\u5916\u90e8 Agent \u7684\u6a21\u578b\u5207\u6362\u8d70 ACP config_options\uff08handleSessionConfigOptionChange\uff09\uff0c\u4e0d\u7ecf\u6b64\u8def\u5f84\u3002
const handlePromptModelChange = async (modelId: string): Promise<void> => {
  if (sessionAgentBackend.value !== 'builtin') {
    return;
  }

  const normalizedModelId = modelId.trim();
  const currentModelId = assistant.config.value.selectedModel?.trim() ?? '';
  if (!normalizedModelId || normalizedModelId === currentModelId) {
    return;
  }

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
    assistant.error.value = toErrorMessage(error, '\u6a21\u578b\u5207\u6362\u5931\u8d25');
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
    setPlanError(error, '\u8bbe\u7f6e\u7f51\u7edc\u8bbf\u95ee\u6743\u9650\u5931\u8d25\u3002');
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

// kimi(ACP) \u4f1a\u8bdd\u914d\u7f6e\u9879\u53d8\u66f4\uff1a\u628a\u8f93\u5165\u6846\u9009\u62e9\u7684 optionId/value \u8def\u7531\u5230\u5f53\u524d\u4f1a\u8bdd\u7684 ACP \u914d\u7f6e\u9879\u5207\u6362\u3002
const handleSessionConfigOptionChange = (optionId: string, value: string): void => {
  void assistant.acpSessionConfigOptions.selectConfigOption(
    assistant.activeConversationId.value,
    optionId,
    value,
  );
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
        reason: toErrorMessage(error, '\u9884\u70ed\u8fde\u63a5\u5931\u8d25'),
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
    setPlanErrorMessage('\u5f53\u524d\u6ca1\u6709\u53ef\u6267\u884c\u7684 Agent run\u3002');
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
    setPlanError(error, '\u5220\u9664\u8ba1\u5212\u6b65\u9aa4\u5931\u8d25\u3002');
  }
};

const handleRegeneratePlan = async (): Promise<void> => {
  try {
    await assistant.agentPlan.regeneratePlan();
  } catch (error) {
    setPlanError(error, '\u91cd\u751f\u6210\u8ba1\u5212\u5931\u8d25\u3002');
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
    setPlanError(error, '\u6279\u51c6\u6216\u542f\u52a8\u8ba1\u5212\u5931\u8d25\u3002');
  }
};

const handleRejectPlan = async (): Promise<void> => {
  try {
    await assistant.agentPlan.rejectPlan('\u7528\u6237\u62d2\u7edd\u5f53\u524d\u8ba1\u5212\u3002');
  } catch (error) {
    setPlanError(error, '\u62d2\u7edd\u8ba1\u5212\u5931\u8d25\u3002');
  }
};

const handlePauseRun = async (): Promise<void> => {
  await withAgentRunAction((runId) => agentRun.pauseRun(runId), '\u6682\u505c Agent run \u5931\u8d25\u3002');
};

const handleResumeRun = async (): Promise<void> => {
  const resumedRun = await withAgentRunAction(
    (runId) => agentRun.resumeRun(runId),
    '\u7ee7\u7eed Agent run \u5931\u8d25\u3002',
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
    setPlanError(error, '\u7ee7\u7eed\u6267\u884c\u8ba1\u5212\u5931\u8d25\u3002');
  }
};

const handleCancelRun = async (): Promise<void> => {
  await withAgentRunAction((runId) => agentRun.cancelRun(runId), '\u53d6\u6d88 Agent run \u5931\u8d25\u3002');
};

const handleResolveToolConfirmation = async (
  decision: TAiToolConfirmationDecision,
): Promise<void> => {
  const confirmation = planPendingToolConfirmation.value;

  if (!confirmation) {
    setPlanErrorMessage('\u5f53\u524d\u6ca1\u6709\u5f85\u5904\u7406\u7684\u5de5\u5177\u786e\u8ba4\u3002');
    return;
  }

  if (!planActiveRun.value) {
    isAgentRunActionPending.value = true;
    setPlanErrorMessage('');

    try {
      await assistant.resolveSidecarToolConfirmation(decision);
    } catch (error) {
      setPlanError(error, '\u5904\u7406 Provider \u5de5\u5177\u786e\u8ba4\u5931\u8d25\u3002');
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
      setPlanError(error, '\u5904\u7406 Sidecar step \u5de5\u5177\u786e\u8ba4\u5931\u8d25\u3002');
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
        setPlanError(error, '\u7ee7\u7eed\u6267\u884c\u8ba1\u5212\u5931\u8d25\u3002');
      }
    }

    return;
  }

  setPlanErrorMessage('Legacy Agent \u5de5\u5177\u786e\u8ba4\u94fe\u5df2\u79fb\u9664\uff0c\u8bf7\u4f7f\u7528\u5b98\u65b9 sidecar \u5ba1\u6279\u94fe\u3002');
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
    setPlanError(error, '\u5904\u7406\u53cd\u5411\u63d0\u95ee\u5931\u8d25\u3002');
  } finally {
    isResolvingUserQuestion.value = false;
  }
};

const handleCancelUserQuestion = async (): Promise<void> => {
  await handleResolveUserQuestion({ outcome: 'cancelled' });
};

const handleResolveAcpApproval = async (optionId: string): Promise<void> => {
  const current = acpApprovalCurrent.value;

  if (!current) {
    return;
  }

  try {
    await acpApproval.resolve(current.toolCallId, optionId);
  } catch (error) {
    assistant.error.value = toErrorMessage(error, '\u63d0\u4ea4\u5de5\u5177\u8c03\u7528\u5ba1\u6279\u5931\u8d25\u3002');
  }
};

const handleCancelAcpApproval = (): void => {
  const current = acpApprovalCurrent.value;

  if (!current) {
    return;
  }

  // \u53d6\u6d88\u5ba1\u6279 = \u53d6\u6d88\u5f53\u524d\u56de\u5408\uff1a\u5148\u672c\u5730\u51fa\u961f\u907f\u514d\u91cd\u590d\u5448\u73b0\uff0c\u518d\u89e6\u53d1\u5e26\u5916 ai_cancel\uff1b
  // \u5bbf\u4e3b ApprovalRegistry::cancel_session \u4e22\u5f03 sender \u2192 Cancelled\uff0c\u7ecf\u5e26\u5916 responder \u56de\u6295\u3002
  acpApproval.dismiss(current.toolCallId);
  void assistant.stopCurrentRequest();
};

const handleResolveAcpUserQuestion = async (result: IAskUserResult): Promise<void> => {
  const current = acpApprovalCurrent.value;

  if (!current) {
    return;
  }

  // \u9009\u4e2d\u5019\u9009\u9879 / \u547d\u4e2d Skip(reject) \u2192 \u56de\u6295\u8be5 optionId \u539f\u503c\uff08\u5bf9\u9f50 approval.rs \u9010\u5b57\u5339\u914d\uff09\u3002
  const decision = resolveAcpDecisionFromAskUserResult(current.request, result);

  if (decision) {
    try {
      await acpApproval.resolve(current.toolCallId, decision);
    } catch (error) {
      assistant.error.value = toErrorMessage(error, '\u63d0\u4ea4\u5de5\u5177\u8c03\u7528\u5ba1\u6279\u5931\u8d25\u3002');
    }
    return;
  }

  // \u65e2\u672a\u9009\u9879\u4e5f\u65e0 reject \u53ef\u56de\u6295 \u2192 \u53d6\u6d88\u5f53\u524d\u56de\u5408\uff08\u5e26\u5916 ai_cancel\uff09\u3002
  acpApproval.dismiss(current.toolCallId);
  void assistant.stopCurrentRequest();
};

const handleCancelAcpUserQuestion = (): void => {
  void handleResolveAcpUserQuestion({ outcome: 'cancelled' });
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
    feedback.onError(toErrorMessage(error, 'AI \u8fde\u63a5\u5931\u8d25'));
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
    feedback.onError(toErrorMessage(error, '\u8fde\u63a5\u6d4b\u8bd5\u5931\u8d25'));
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
    feedback.onError(toErrorMessage(error, 'Tavily API Key \u4fdd\u5b58\u5931\u8d25'));
  }
};

const restorePersistedPlanUiState = async (): Promise<void> => {
  if (!hasPlannedAgentState.value && planStore.value.mode !== 'plan') {
    return;
  }

  assistant.activeMode.value = 'plan';
  await assistant.agentPlan.restorePersistedPlanState();
};

// \u542f\u52a8\u6253\u70b9\uff08\u9636\u6bb50\u00b7\u91cf\u5316\uff09\uff1a\u540c\u6b65 setup\uff08\u542b\u6d3e\u751f\u8ba1\u7b97\uff09\u5168\u90e8\u5b8c\u6210\u3002
markStartup('ai-assistant-panel-setup-done');

onMounted(() => {
  // \u542f\u52a8\u6253\u70b9\uff08\u9636\u6bb50\u00b7\u91cf\u5316\uff09\uff1a\u5b50\u7ec4\u4ef6\u6e32\u67d3\u6302\u8f7d\u5b8c\u6210\uff08\u9996\u5e27\uff09\u3002
  markStartup('ai-assistant-panel-mounted');
  restorePersistedPlanUiState().catch((error) => {
    setPlanError(error, '\u6062\u590d\u8ba1\u5212\u72b6\u6001\u5931\u8d25\u3002');
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
  <AiPanelFrame class="ai-assistant-panel" aria-label="AI \u52a9\u624b\u9762\u677f">
    <template #mark>
      <Select :model-value="sessionAgentBackend" @update:model-value="handleAgentBackendChange">
        <SelectTrigger aria-label="\u9009\u62e9 Agent" class="ai-agent-mark">
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
      <button type="button" class="ai-icon-button" aria-label="\u65b0\u5efa\u5bf9\u8bdd" @click="startNewConversation">
        <SquarePen aria-hidden="true" />
      </button>
      <button type="button" class="ai-icon-button" aria-label="AI \u8bbe\u7f6e" @click="openSettings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M20 7h-7" />
          <path d="M14 17H4" />
          <circle cx="17" cy="17" r="3" />
          <circle cx="7" cy="7" r="3" />
        </svg>
      </button>
      <div ref="historyAnchorRef" class="ai-history-anchor">
        <button type="button" class="ai-icon-button" aria-label="\u5bf9\u8bdd\u8bb0\u5f55" aria-haspopup="dialog"
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
              aria-label="\u5bf9\u8bdd\u8bb0\u5f55">
              <header class="ai-history-header">
                <div class="ai-history-title-group">
                  <strong>\u5bf9\u8bdd\u8bb0\u5f55</strong>
                </div>
                <button v-if="activeHistoryThread" type="button" class="ai-history-clear-icon" aria-label="\u5220\u9664\u5f53\u524d\u5bf9\u8bdd\u8bb0\u5f55"
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
                    <button type="button" class="ai-history-delete-button" aria-label="\u5220\u9664\u8fd9\u6761\u5bf9\u8bdd\u8bb0\u5f55"
                      @click.stop="openDeleteConversationDialog(thread.id)">
                      <Trash2 aria-hidden="true" />
                    </button>
                  </article>
                </div>
                <div v-if="hasMoreHistoryThreads" class="ai-history-load-sentinel" aria-hidden="true"></div>
              </div>
              <div v-else class="ai-history-empty">\u6682\u65e0\u5bf9\u8bdd\u8bb0\u5f55</div>
            </section>
          </Motion>
        </AnimatePresence>
      </div>
      <slot name="header-actions-after" />
    </template>

    <template #body>
      <AiChatThread :messages="assistant.messages.value" :is-typing="assistant.isSending.value"
        :thread-entries="visibleThreadEntries"
        :streaming-message-id="assistant.activeAgentMessageId.value"
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
        <ApprovalPrompt
          v-if="acpApprovalCurrent && !acpApprovalQuestions"
          autofocus
          :title="acpApprovalCurrent.approval.title"
          :reason="acpApprovalCurrent.approval.summary"
          :options="acpApprovalCurrent.approval.options"
          @select="handleResolveAcpApproval"
          @cancel="handleCancelAcpApproval"
        />
        <AiPromptInput v-model="assistant.draft.value" v-model:active-mode="assistant.activeMode.value"
          v-model:agent-backend="sessionAgentBackend"
          :acp-commands="kimiSlashCommands"
          :session-config-options="assistant.acpSessionConfigOptions.state.value"
          :is-session-config-option-switching="assistant.acpSessionConfigOptions.isSwitching.value"
          @session-config-option-change="handleSessionConfigOptionChange"
          :disabled="composerDisabled" :stop-visible="assistant.isSending.value"
          :submit-label="submitLabel" :config="assistant.config.value"
          :is-model-saving="isPromptModelSaving"
          :network-permission="networkPermission"
          :execution-mode="executionMode"
          :is-network-permission-saving="agentNetwork.pending.value" :attachments="assistant.attachedFiles.value"
          :has-attachments="assistant.attachedFiles.value.length > 0" :token-context="tokenContextProps"
          @submit="handleSubmitMessage" @stop="assistant.stopCurrentRequest" :resolve-attachment="assistant.attachFile"
          @remove-file="assistant.removeAttachedFile" @model-change="handlePromptModelChange"
          @network-permission-change="handlePromptNetworkPermissionChange"
          @execution-mode-change="handlePromptExecutionModeChange"
          @information-sources-open="openPromptInformationSources" @personalization-open="openPromptPersonalization"
          @prewarm="handlePromptPrewarm"
          :user-questions="acpApprovalQuestions ?? visibleUserQuestion?.questions ?? null"
          @question-submit="handleComposerQuestionSubmit"
          @question-cancel="handleComposerQuestionCancel" />
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
              <button type="button" class="ai-button is-ghost" @click="cancelClearConversation">\u53d6\u6d88</button>
              <button type="button" class="ai-button is-danger" @click="confirmClearConversation">\u5220\u9664</button>
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

.ai-question-surface {
  width: min(100%, 710px);
  max-width: 860px;
  margin-inline: auto;
  padding: 0 10px 4px;
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
/* \u5de6\u4e0a\u89d2 Agent \u4e0b\u62c9\uff1aSelectContent \u4f1a teleport \u5230 body\uff0c\u5fc5\u987b\u7528\u5168\u5c40\u6837\u5f0f\u8986\u76d6 */
.ai-agent-mark-content {
  border: 1px solid #f0f0f2 !important;
  background: #ffffff !important;
  background-color: #ffffff !important;
  color: #1f2328 !important;
  box-shadow: 0 8px 24px rgb(15 23 42 / 8%) !important;
  border-radius: 10px !important;
  padding: 8px !important;
}

/* \u8986\u76d6\u5185\u90e8\u53ef\u80fd\u7ee7\u627f\u7684\u5f39\u7a97/\u83dc\u5355\u80cc\u666f */
.ai-agent-mark-content *,
.ai-agent-mark-content [data-radix-select-viewport],
.ai-agent-mark-content [role='listbox'] {
  background-color: transparent;
}

/* \u5220\u9664/\u9690\u85cf\u201c\u9009\u62e9 Agent\u201d\u6807\u9898\uff0c\u53cc\u4fdd\u9669 */
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

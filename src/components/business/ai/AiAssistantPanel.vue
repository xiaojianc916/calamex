<script setup lang="ts">
import AiChatThread from '@/components/business/ai/AiChatThread.vue';
import AiContextChips from '@/components/business/ai/AiContextChips.vue';
import AiPatchPreview from '@/components/business/ai/AiPatchPreview.vue';
import AiPlanModePanel from '@/components/business/ai/AiPlanModePanel.vue';
import AiPromptInput from '@/components/business/ai/AiPromptInput.vue';
import AiProviderIcon from '@/components/business/ai/AiProviderIcon.vue';
import AiProviderSettings from '@/components/business/ai/AiProviderSettings.vue';
import AiToolConfirmationCard from '@/components/business/ai/AiToolConfirmationCard.vue';
import AiWebSourcesPanel from '@/components/business/ai/AiWebSourcesPanel.vue';
import { useAiAgentNetwork } from '@/composables/useAiAgentNetwork';
import { useAiAgentRun } from '@/composables/useAiAgentRun';
import { useAiAgentStream } from '@/composables/useAiAgentStream';
import { useAiAssistant } from '@/composables/useAiAssistant';
import { useAiWebSources } from '@/composables/useAiWebSources';
import { findAiServicePlatformByModel } from '@/constants/ai-providers';
import type {
  IAiAgentRun,
  IAiAgentStepToolResultSummary,
  IAiAgentStepWebSourceSummary,
  IAiChatMessage,
  IAiConfigPayload,
  IAiProviderSettingsActionFeedback,
  IAiTaskPlanStep,
  IAiToolActivityInline,
  IAiToolCall,
  IAiWebSourceEntry,
  TAiAgentNetworkPermission,
  TAiChatMessageActionId,
  TAiToolConfirmationDecision,
} from '@/types/ai';
import type {
  IActiveRunSummary,
  IAnalyzeScriptPayload,
  IEditorDocument,
  IEditorSelectionSummary,
} from '@/types/editor';
import type { IGitRepositoryStatusPayload } from '@/types/git';
import { toErrorMessage } from '@/utils/error';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type CSSProperties } from 'vue';

const MAX_HISTORY_MESSAGES = 20;
const HISTORY_POPOVER_WIDTH = 332;
const HISTORY_POPOVER_MAX_HEIGHT = 452;
const HISTORY_POPOVER_MIN_HEIGHT = 220;
const HISTORY_POPOVER_VIEWPORT_MARGIN = 12;
const HISTORY_POPOVER_TRIGGER_GAP = 8;
type TAiAssistantViewMode = 'chat' | 'agent' | 'plan';

const props = defineProps<{
  document: IEditorDocument;
  activeRun: IActiveRunSummary | null;
  analysis: IAnalyzeScriptPayload;
  selection: IEditorSelectionSummary | null;
  gitStatus: IGitRepositoryStatusPayload;
  workspaceRootPath: string | null;
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
const agentStream = useAiAgentStream();
const webSources = useAiWebSources();
const settingsDraft = ref<IAiConfigPayload>({ ...assistant.config.value });
const settingsApiKey = ref('');
const isAgentRunActionPending = ref(false);
const isModeMenuOpen = ref(false);
const isNetworkMenuOpen = ref(false);
const isNetworkPermissionPending = ref(false);
const isHistoryOpen = ref(false);
const historyButtonRef = ref<HTMLButtonElement | null>(null);
const historyPopoverStyle = ref<CSSProperties>({});
const currentServicePlatform = computed(() =>
  findAiServicePlatformByModel(assistant.config.value.selectedModel),
);
const aiIconPlatformId = computed(() => currentServicePlatform.value.id);
const aiIconTitle = computed(() => currentServicePlatform.value.label);
const aiCurrentModelLabel = computed(() =>
  assistant.config.value.selectedModel?.trim() || 'AI Assistant',
);
const aiModelButtonLabel = computed(() =>
  `${aiIconTitle.value} · ${aiCurrentModelLabel.value}`,
);
const historyThreads = computed(() => assistant.historyThreads.value.slice(-MAX_HISTORY_MESSAGES).reverse());
const historyCountLabel = computed(() => `最近 ${historyThreads.value.length} 组`);
const networkPermissionLabel = computed(() => {
  switch (agentNetwork.store.networkPermission) {
    case 'off':
      return 'Network Off';
    case 'allowed-this-run':
      return 'Network Allowed';
    case 'ask':
      return 'Network Ask';
    default:
      return 'Network Ask';
  }
});
const planStore = computed(() => assistant.agentPlan.store);
const hasPlannedAgentState = computed(() =>
  planStore.value.hasPlan ||
  planStore.value.isClassifying ||
  planStore.value.isPlanning ||
  Boolean(planStore.value.errorMessage) ||
  Boolean(planStore.value.activeRun),
);
const planVisible = computed(() => {
  if (assistant.activeMode.value !== 'plan') {
    return false;
  }

  return hasPlannedAgentState.value ||
    Boolean(planStore.value.pendingToolConfirmation && (
      planStore.value.hasPlan ||
      planStore.value.activeRun
    ));
});
const directToolConfirmationVisible = computed(() => {
  if (assistant.activeMode.value !== 'agent') {
    return false;
  }

  return Boolean(planStore.value.pendingToolConfirmation) && !planVisible.value;
});
const activePlanStep = computed(() => {
  const currentStepId = planStore.value.activeRun?.currentStepId;

  if (currentStepId) {
    return planStore.value.steps.find((step) => step.id === currentStepId) ?? null;
  }

  return planStore.value.steps.find((step) => step.isActive) ?? null;
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
    .map((activity) => ({
      id: activity.id,
      name: activity.toolName,
      status: mapActivityToToolCallStatus(activity.state),
      summary: activity.label,
      targetPreview: normalizeToolActivitySummary(activity),
    }));
};

const activeAgentFlowMessage = computed<IAiChatMessage | null>(() => {
  if (assistant.activeMode.value !== 'plan') {
    return null;
  }

  const run = planStore.value.activeRun;
  const toolCalls = buildAgentFlowToolCalls(run);
  const latestAnswer = run
    ? planStore.value.getStepFinalAnswers(run.id).at(-1) ?? null
    : null;

  if (!run && toolCalls.length === 0) {
    return null;
  }

  const latestToolCall = toolCalls.at(-1);
  const createdAt = latestAnswer?.createdAt ?? run?.updatedAt ?? new Date().toISOString();
  const content = latestAnswer?.content.trim() ||
    (latestToolCall
      ? `AI 正在自动使用工具：${latestToolCall.summary}`
      : 'Agent 正在执行计划。');

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
const submitLabel = computed(() => {
  if (assistant.activeMode.value === 'plan') {
    return '生成计划';
  }

  if (assistant.activeMode.value === 'agent') {
    return '开始执行';
  }

  return assistant.sendButtonLabel.value;
});

const openSettings = (): void => {
  settingsDraft.value = { ...assistant.config.value };
  isNetworkMenuOpen.value = false;
  isHistoryOpen.value = false;
  assistant.isSettingsOpen.value = true;
  assistant.loadProviderProfiles().catch(() => undefined);
};

const updateHistoryPopoverPosition = (): void => {
  if (!historyButtonRef.value || typeof window === 'undefined') {
    return;
  }

  const triggerRect = historyButtonRef.value.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(
    HISTORY_POPOVER_WIDTH,
    Math.max(0, viewportWidth - HISTORY_POPOVER_VIEWPORT_MARGIN * 2),
  );
  const preferredRight = viewportWidth - triggerRect.right;
  const right = Math.min(
    Math.max(preferredRight, HISTORY_POPOVER_VIEWPORT_MARGIN),
    Math.max(HISTORY_POPOVER_VIEWPORT_MARGIN, viewportWidth - width - HISTORY_POPOVER_VIEWPORT_MARGIN),
  );
  const availableBelow = viewportHeight -
    triggerRect.bottom -
    HISTORY_POPOVER_TRIGGER_GAP -
    HISTORY_POPOVER_VIEWPORT_MARGIN;
  const availableAbove = triggerRect.top -
    HISTORY_POPOVER_TRIGGER_GAP -
    HISTORY_POPOVER_VIEWPORT_MARGIN;
  const shouldOpenAbove = availableBelow < HISTORY_POPOVER_MIN_HEIGHT && availableAbove > availableBelow;
  const availableHeight = shouldOpenAbove ? availableAbove : availableBelow;
  const maxHeight = Math.min(
    HISTORY_POPOVER_MAX_HEIGHT,
    Math.max(HISTORY_POPOVER_MIN_HEIGHT, availableHeight),
  );
  const top = shouldOpenAbove
    ? Math.max(
        HISTORY_POPOVER_VIEWPORT_MARGIN,
        triggerRect.top - HISTORY_POPOVER_TRIGGER_GAP - maxHeight,
      )
    : Math.min(
        triggerRect.bottom + HISTORY_POPOVER_TRIGGER_GAP,
        viewportHeight - HISTORY_POPOVER_VIEWPORT_MARGIN - maxHeight,
      );

  historyPopoverStyle.value = {
    top: `${top}px`,
    right: `${right}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`,
  };
};

const handleToggleHistoryPopover = async (): Promise<void> => {
  if (isHistoryOpen.value) {
    isHistoryOpen.value = false;
    return;
  }

  isModeMenuOpen.value = false;
  isNetworkMenuOpen.value = false;
  updateHistoryPopoverPosition();
  isHistoryOpen.value = true;
  await nextTick();
  updateHistoryPopoverPosition();
};

const handleHistoryViewportChange = (): void => {
  if (!isHistoryOpen.value) {
    return;
  }

  updateHistoryPopoverPosition();
};

const startNewConversation = (): void => {
  if (assistant.isSending.value) {
    assistant.stopCurrentRequest();
  }
  isHistoryOpen.value = false;
  isModeMenuOpen.value = false;
  isNetworkMenuOpen.value = false;
  assistant.startNewConversation();
};

const openHistoryThread = (threadId: string): void => {
  if (assistant.isSending.value) {
    assistant.stopCurrentRequest();
  }
  assistant.switchConversation(threadId);
  isHistoryOpen.value = false;
  isModeMenuOpen.value = false;
  isNetworkMenuOpen.value = false;
};

const selectMode = (mode: TAiAssistantViewMode): void => {
  assistant.activeMode.value = mode;
  isModeMenuOpen.value = false;
  isNetworkMenuOpen.value = false;
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

const getHistoryPreview = (messages: IAiChatMessage[]): string => {
  const lastMessage = [...messages].reverse().find((message) => message.content.trim());
  if (!lastMessage) return '空对话';
  const normalized = lastMessage.content.replace(/\s+/g, ' ').trim();
  return normalized.length > 64 ? `${normalized.slice(0, 64)}…` : normalized;
};

const getHistoryMessageCountLabel = (messages: IAiChatMessage[]): string => `${messages.length} 条消息`;

const clipQueryPreview = (value: string): string => {
  const characters = Array.from(value.replace(/\s+/g, ' ').trim());

  if (characters.length <= 48) {
    return characters.join('');
  }

  return `${characters.slice(0, 48).join('')}…`;
};

const toStepWebSourceSummaries = (
  sources: readonly IAiWebSourceEntry[],
): IAiAgentStepWebSourceSummary[] =>
  sources.map((source) => ({
    id: source.id,
    title: source.result.title,
    url: source.result.url,
    sourceType: source.result.sourceType,
    status: source.status,
    queryPreview: clipQueryPreview(source.query),
    fetchedAt: source.fetchedSource?.fetchedAt ?? source.result.fetchedAt,
    ...(source.fetchedSource?.textRef ? { textRef: source.fetchedSource.textRef } : {}),
    ...(source.fetchedSource?.excerpt ? { excerpt: source.fetchedSource.excerpt } : {}),
  }));

const buildWebToolResults = (
  runId: string,
  step: IAiTaskPlanStep,
  sources: readonly IAiWebSourceEntry[],
  status: 'succeeded' | 'failed',
  startedAt: string,
  endedAt: string,
  errorMessage?: string,
): IAiAgentStepToolResultSummary[] => {
  const resultIdBase = `${runId}:${step.id}:${endedAt}`;
  const results: IAiAgentStepToolResultSummary[] = [];

  if (step.tools.includes('web_search')) {
    results.push({
      id: `${resultIdBase}:web_search`,
      runId,
      stepId: step.id,
      toolName: 'web_search',
      status,
      summary: status === 'succeeded'
        ? `搜索到 ${sources.length} 个来源`
        : errorMessage ?? '网络搜索失败',
      startedAt,
      endedAt,
    });
  }

  if (step.tools.includes('web_fetch')) {
    const fetchedCount = sources.filter((source) => source.status === 'fetched').length;
    const fetchedRef = sources.find((source) => source.fetchedSource?.textRef)?.fetchedSource?.textRef;
    results.push({
      id: `${resultIdBase}:web_fetch`,
      runId,
      stepId: step.id,
      toolName: 'web_fetch',
      status,
      summary: status === 'succeeded'
        ? `读取 ${fetchedCount} 个网页正文引用`
        : errorMessage ?? '网页读取失败',
      startedAt,
      endedAt,
      ...(fetchedRef ? { outputRef: fetchedRef } : {}),
    });
  }

  return results;
};

const setPlanError = (error: unknown, fallback: string): void => {
  planStore.value.errorMessage = toErrorMessage(error, fallback);
};

const handleSetNetworkPermission = async (
  permission: TAiAgentNetworkPermission,
): Promise<void> => {
  isNetworkPermissionPending.value = true;

  try {
    await agentNetwork.setNetworkPermission(permission);
    isNetworkMenuOpen.value = false;
  } catch (error) {
    setPlanError(error, '设置 AI Agent 网络权限失败。');
  } finally {
    isNetworkPermissionPending.value = false;
  }
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
  planStore.value.activeRunId ?? planStore.value.activeRun?.id ?? null;

const withAgentRunAction = async <T,>(
  action: (runId: string) => Promise<T>,
  fallback: string,
): Promise<T | null> => {
  const runId = getActiveAgentRunId();

  if (!runId) {
    planStore.value.errorMessage = '当前没有可执行的 Agent run。';
    return null;
  }

  isAgentRunActionPending.value = true;
  planStore.value.errorMessage = '';

  try {
    return await action(runId);
  } catch (error) {
    setPlanError(error, fallback);
    return null;
  } finally {
    isAgentRunActionPending.value = false;
  }
};

const findRunningStep = (run: IAiAgentRun | null): IAiTaskPlanStep | null => {
  if (!run) {
    return null;
  }

  if (run.currentStepId) {
    return run.steps.find((step) => step.id === run.currentStepId && step.status === 'running') ?? null;
  }

  return run.steps.find((step) => step.status === 'running') ?? null;
};

const runWebToolsForStep = async (step: IAiTaskPlanStep): Promise<boolean> => {
  if (!webSources.shouldRunWebToolsForStep(step)) {
    return false;
  }

  const runId = getActiveAgentRunId();
  const startedAt = new Date().toISOString();

  if (!runId) {
    planStore.value.errorMessage = '当前没有可记录工具结果的 Agent run。';
    return true;
  }

  try {
    const sources = await webSources.runStepWebTools(step);
    const endedAt = new Date().toISOString();
    planStore.value.setStepWebSources(runId, step.id, toStepWebSourceSummaries(sources));
    planStore.value.appendStepToolResults(
      runId,
      step.id,
      buildWebToolResults(runId, step, sources, 'succeeded', startedAt, endedAt),
    );
    return true;
  } catch (error) {
    const endedAt = new Date().toISOString();
    const message = toErrorMessage(error, '执行 Web 工具失败。');
    const currentSources = webSources.sources.value.filter((source) => source.stepId === step.id);

    planStore.value.setStepWebSources(runId, step.id, toStepWebSourceSummaries(currentSources));
    planStore.value.appendStepToolResults(
      runId,
      step.id,
      buildWebToolResults(runId, step, currentSources, 'failed', startedAt, endedAt, message),
    );
    setPlanError(error, '执行 Web 工具失败。');
    return true;
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
    await agentRun.runPlan(
      planStore.value.activeGoal,
      planStore.value.steps,
      assistant.currentReferences.value,
    );
  } catch (error) {
    setPlanError(error, '批准或启动计划失败。');
  }
};

const handleResetPlan = (): void => {
  assistant.agentPlan.resetPlan();
};

const handleRunStep = async (): Promise<void> => {
  await withAgentRunAction(
    (runId) => agentRun.runStepWithSidecar(runId, {
      goal: planStore.value.activeGoal,
      context: assistant.currentReferences.value,
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
  await withAgentRunAction(
    (runId) => agentRun.resumeRun(runId),
    '继续 Agent run 失败。',
  );
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
  const confirmation = planStore.value.pendingToolConfirmation;

  if (!confirmation) {
    planStore.value.errorMessage = '当前没有待处理的工具确认。';
    return;
  }

  if (!planStore.value.activeRun) {
    isAgentRunActionPending.value = true;
    planStore.value.errorMessage = '';

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
    planStore.value.errorMessage = '';

    try {
      await agentRun.resolveSidecarStepToolConfirmation(confirmation.id, decision);
    } catch (error) {
      setPlanError(error, '处理 Sidecar step 工具确认失败。');
    } finally {
      isAgentRunActionPending.value = false;
    }

    return;
  }

  const resolvedRun = await withAgentRunAction(
    (runId) => agentRun.resolveToolConfirmation(runId, confirmation.id, decision),
    '处理工具确认失败。',
  );

  if (decision === 'stop' || !resolvedRun) {
    return;
  }

  const run = await withAgentRunAction(
    (runId) => agentRun.runStep(runId),
    '继续执行 Agent step 失败。',
  );
  const nextRunningStep = findRunningStep(run);

  if (nextRunningStep) {
    await runWebToolsForStep(nextRunningStep);
  }
};

const saveSettings = async (
  config: IAiConfigPayload,
  apiKey: string,
  feedback: IAiProviderSettingsActionFeedback,
): Promise<void> => {
  try {
    const message = await assistant.connectProvider(config, apiKey);
    settingsApiKey.value = '';
    settingsDraft.value = { ...assistant.config.value };
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
    settingsDraft.value = { ...assistant.config.value };
    feedback.onSuccess('AI 配置已切换');
  } catch (error) {
    feedback.onError(toErrorMessage(error, 'AI 配置切换失败'));
  }
};

const saveCredentials = async (
  apiKey: string,
  feedback: IAiProviderSettingsActionFeedback,
): Promise<void> => {
  try {
    await assistant.saveCredentials(apiKey, settingsDraft.value.providerType);
    settingsApiKey.value = '';
    settingsDraft.value = { ...assistant.config.value };
    feedback.onSuccess('API Key 已保存到系统凭证');
  } catch (error) {
    feedback.onError(toErrorMessage(error, 'API Key 保存失败'));
  }
};

const testProvider = async (
  config: IAiConfigPayload,
  apiKey: string,
  feedback: IAiProviderSettingsActionFeedback,
): Promise<void> => {
  try {
    feedback.onSuccess(await assistant.testProviderConfig(config, apiKey));
  } catch (error) {
    feedback.onError(toErrorMessage(error, '连接测试失败'));
  }
};

const handleMessageAction = async (
  messageId: string,
  actionId: TAiChatMessageActionId,
): Promise<void> => {
  await assistant.handleMessageAction(messageId, actionId);
};

onMounted(() => {
  assistant.loadConfig().then(() => {
    settingsDraft.value = { ...assistant.config.value };
  }).catch(() => undefined);
  assistant.loadTools().catch(() => undefined);
  assistant.loadProviderProfiles().catch(() => undefined);
  agentStream.start().catch(() => undefined);

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', handleHistoryViewportChange);
  }
});

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', handleHistoryViewportChange);
  }
});
</script>

<template>
  <section class="ai-assistant-panel" aria-label="AI 助手面板">
    <header class="ai-panel-header">
      <span class="ai-status-dot" aria-hidden="true"></span>
      <div class="ai-model-switch">
        <button type="button" class="ai-model-button" :aria-expanded="isModeMenuOpen" aria-haspopup="menu"
          :title="aiModelButtonLabel" aria-label="切换 AI 模式" @click="isModeMenuOpen = !isModeMenuOpen">
          <AiProviderIcon class="ai-model-icon" :platform-id="aiIconPlatformId" :title="aiIconTitle" decorative />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div v-if="isModeMenuOpen" class="ai-mode-menu" role="menu">
          <button type="button" role="menuitemradio" :aria-checked="assistant.activeMode.value === 'chat'"
            :class="{ active: assistant.activeMode.value === 'chat' }" @click="selectMode('chat')">
            Chat
          </button>
          <button type="button" role="menuitemradio" :aria-checked="assistant.activeMode.value === 'agent'"
            :class="{ active: assistant.activeMode.value === 'agent' }" @click="selectMode('agent')">
            Agent
          </button>
          <button type="button" role="menuitemradio" :aria-checked="assistant.activeMode.value === 'plan'"
            :class="{ active: assistant.activeMode.value === 'plan' }" @click="selectMode('plan')">
            Plan
          </button>
        </div>
      </div>
      <div class="ai-network-anchor">
        <button type="button" class="ai-network-button" :aria-expanded="isNetworkMenuOpen" aria-haspopup="menu"
          :disabled="isNetworkPermissionPending" @click="isNetworkMenuOpen = !isNetworkMenuOpen">
          <span class="ai-network-dot" :class="`is-${agentNetwork.store.networkPermission}`" aria-hidden="true"></span>
          <span>{{ networkPermissionLabel }}</span>
        </button>
        <div v-if="isNetworkMenuOpen" class="ai-network-menu" role="menu" aria-label="AI Agent 网络权限">
          <button type="button" role="menuitemradio" :aria-checked="agentNetwork.store.networkPermission === 'ask'"
            :class="{ active: agentNetwork.store.networkPermission === 'ask' }" :disabled="isNetworkPermissionPending"
            @click="handleSetNetworkPermission('ask')">
            Ask
          </button>
          <button type="button" role="menuitemradio"
            :aria-checked="agentNetwork.store.networkPermission === 'allowed-this-run'"
            :class="{ active: agentNetwork.store.networkPermission === 'allowed-this-run' }"
            :disabled="isNetworkPermissionPending" @click="handleSetNetworkPermission('allowed-this-run')">
            Allowed this run
          </button>
          <button type="button" role="menuitemradio" :aria-checked="agentNetwork.store.networkPermission === 'off'"
            :class="{ active: agentNetwork.store.networkPermission === 'off' }" :disabled="isNetworkPermissionPending"
            @click="handleSetNetworkPermission('off')">
            Off
          </button>
        </div>
      </div>
      <button type="button" class="ai-icon-button" aria-label="新建对话" @click="startNewConversation">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
          <path d="M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
        </svg>
      </button>
      <button type="button" class="ai-icon-button" aria-label="AI 设置" @click="openSettings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M20 7h-7" />
          <path d="M14 17H4" />
          <circle cx="17" cy="17" r="3" />
          <circle cx="7" cy="7" r="3" />
        </svg>
      </button>
      <div class="ai-history-anchor">
        <button
          ref="historyButtonRef"
          type="button"
          class="ai-icon-button"
          aria-label="对话记录"
          aria-haspopup="dialog"
          :aria-expanded="isHistoryOpen"
          @click="handleToggleHistoryPopover"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M3 3v5h5" />
            <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
            <path d="M12 7v5l4 2" />
          </svg>
        </button>
      </div>
    </header>

    <AiContextChips :references="assistant.currentReferences.value" />
    <AiChatThread :messages="threadMessages" :is-typing="assistant.isSending.value" :platform-id="aiIconPlatformId"
      :provider-label="aiIconTitle" @message-action="handleMessageAction">
    </AiChatThread>
    <div v-if="assistant.canPreviewPatch.value" class="ai-patch-entry">
      <button type="button" class="ai-quick-action" @click="assistant.previewPatchFromLastAnswer">
        预览为 Patch
      </button>
    </div>
    <AiPatchPreview :patch="assistant.proposedPatch.value" :is-applying="assistant.isApplyingPatch.value"
      @apply="assistant.applyProposedPatch" @close="assistant.proposedPatch.value = null" />
    <AiWebSourcesPanel v-if="webSourcesVisible" :sources="webSources.sources.value"
      :activity="planVisible ? null : webSources.activity.value" :error-message="webSources.errorMessage.value"
      :is-searching="webSources.isSearching.value" :network-permission="agentNetwork.store.networkPermission"
      @search="handleSearchWebSources" @fetch-source="handleFetchWebSource" @clear="webSources.clear" />
    <div class="ai-composer-shell" :class="{ 'has-plan': planVisible }">
      <AiPlanModePanel v-if="planVisible" :goal="planStore.activeGoal" :steps="planStore.steps"
        :classification-reason="planStore.classificationReason" :error-message="planStore.errorMessage"
        :is-classifying="planStore.isClassifying" :is-planning="planStore.isPlanning"
        :is-approving="planStore.isApproving" :approved-at="planStore.approvedAt" :active-run="planStore.activeRun"
        :is-run-action-pending="isAgentRunActionPending" :web-activity="webSources.activity.value"
        :tool-activity="planStore.activeToolActivity" :tool-confirmation="planStore.pendingToolConfirmation"
        @update-step-title="handleUpdatePlanStepTitle" @remove-step="handleRemovePlanStep"
        @regenerate="handleRegeneratePlan" @approve="handleApprovePlan" @reset="handleResetPlan"
        @run-step="handleRunStep" @pause-run="handlePauseRun" @resume-run="handleResumeRun"
        @cancel-run="handleCancelRun" @resolve-tool-confirmation="handleResolveToolConfirmation" />
      <div v-if="directToolConfirmationVisible && planStore.pendingToolConfirmation"
        class="ai-direct-tool-confirmation">
        <AiToolConfirmationCard :confirmation="planStore.pendingToolConfirmation" :disabled="isAgentRunActionPending"
          @resolve="handleResolveToolConfirmation" />
      </div>
      <AiPromptInput v-model="assistant.draft.value" :disabled="assistant.isSending.value"
        :error-message="assistant.errorMessage.value" :submit-label="submitLabel"
        :attachments="assistant.attachedFiles.value" :has-attachments="assistant.attachedFiles.value.length > 0"
        @submit="assistant.sendMessage" @stop="assistant.stopCurrentRequest" @file-selected="assistant.attachFile"
        @remove-file="assistant.removeAttachedFile" />
    </div>

    <AiProviderSettings v-model:draft="settingsDraft" v-model:api-key="settingsApiKey"
      :open="assistant.isSettingsOpen.value" :config="assistant.config.value"
      :profiles="assistant.providerProfiles.value"
      :load-profile-detail="assistant.getProviderProfileDetail"
      @close="assistant.isSettingsOpen.value = false" @save="saveSettings" @save-credentials="saveCredentials"
      @test-provider="testProvider" @switch-profile="switchProviderProfile" />

    <Teleport to="body">
      <section
        v-if="isHistoryOpen"
        class="ai-history-popover"
        :style="historyPopoverStyle"
        role="dialog"
        aria-label="最近 20 组对话记录"
      >
        <header class="ai-history-header">
          <div class="ai-history-title-group">
            <strong>对话记录</strong>
            <span>{{ historyCountLabel }}</span>
          </div>
        </header>
        <div v-if="historyThreads.length" class="ai-history-list">
          <article
            v-for="thread in historyThreads"
            :key="thread.id"
            class="ai-history-item"
            :class="{ 'is-active': thread.id === assistant.activeConversationId.value }"
          >
            <button type="button" class="ai-history-button" @click="openHistoryThread(thread.id)">
              <div class="ai-history-meta">
                <strong class="ai-history-title">{{ thread.title }}</strong>
                <time>{{ getHistoryTimeLabel(thread.updatedAt) }}</time>
              </div>
              <p class="ai-history-content">{{ getHistoryPreview(thread.messages) }}</p>
              <div class="ai-history-subtitle">{{ getHistoryMessageCountLabel(thread.messages) }}</div>
            </button>
          </article>
        </div>
        <div v-else class="ai-history-empty">最近 20 组对话会显示在这里</div>
        <footer v-if="assistant.messages.value.length" class="ai-history-footer">
          <button type="button" @click="assistant.isClearDialogOpen.value = true; isHistoryOpen = false">
            清空当前对话
          </button>
        </footer>
      </section>
    </Teleport>

    <Teleport to="body">
      <div v-if="assistant.isClearDialogOpen.value" class="ai-dialog-backdrop"
        @click.self="assistant.isClearDialogOpen.value = false">
        <section class="ai-dialog is-compact" role="alertdialog" aria-modal="true">
          <div class="ai-dialog-copy">
            <h3>清空当前对话？</h3>
            <p>这只会清空面板里的临时对话记录，不会删除任何文件。</p>
          </div>
          <div class="ai-dialog-actions">
            <button type="button" class="ai-button is-ghost"
              @click="assistant.isClearDialogOpen.value = false">取消</button>
            <button type="button" class="ai-button is-danger" @click="assistant.clearConversation">清空</button>
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
  border-bottom: 1px solid var(--shell-divider);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.ai-status-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 12%, transparent);
}

.ai-model-switch {
  position: relative;
  min-width: 0;
  flex: 0 0 auto;
}

.ai-model-button {
  display: inline-flex;
  height: 26px;
  min-width: 42px;
  align-items: center;
  gap: 5px;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 500;
  padding: 0 6px;
}

.ai-model-button:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-model-icon {
  width: 18px;
  height: 18px;
}

.ai-model-button>svg:not(.ai-model-icon) {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  color: var(--text-quaternary);
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ai-mode-menu {
  position: absolute;
  top: 31px;
  left: 0;
  z-index: 5;
  display: grid;
  width: 104px;
  gap: 2px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 100%, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel-bg) 96%, var(--sidebar-bg));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  padding: 5px;
}

.ai-mode-menu button {
  height: 26px;
  border-radius: 5px;
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: left;
  padding: 0 8px;
}

.ai-mode-menu button:hover,
.ai-mode-menu button.active {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-network-anchor {
  position: relative;
  flex: 0 0 auto;
}

.ai-network-button {
  display: inline-flex;
  height: 26px;
  max-width: 120px;
  align-items: center;
  gap: 5px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 74%, transparent);
  border-radius: 999px;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1;
  padding: 0 8px;
}

.ai-network-button:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-network-button:disabled {
  opacity: 0.58;
  cursor: wait;
}

.ai-network-button span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-network-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--text-quaternary);
}

.ai-network-dot.is-allowed-this-run {
  background: var(--success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 12%, transparent);
}

.ai-network-dot.is-off {
  background: var(--danger);
}

.ai-network-menu {
  position: absolute;
  top: 31px;
  right: 0;
  z-index: 6;
  display: grid;
  width: 148px;
  gap: 2px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 100%, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel-bg) 96%, var(--sidebar-bg));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  padding: 5px;
}

.ai-network-menu button {
  height: 26px;
  border-radius: 5px;
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: left;
  padding: 0 8px;
}

.ai-network-menu button:hover,
.ai-network-menu button.active {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-network-menu button:disabled {
  opacity: 0.58;
  cursor: wait;
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
  position: fixed;
  z-index: 1200;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: 332px;
  max-height: 452px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 100%, rgba(255, 255, 255, 0.1));
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel-bg) 97%, var(--sidebar-bg));
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.34);
}

.ai-history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 40px;
  border-bottom: 1px solid var(--shell-divider);
  padding: 0 12px;
}

.ai-history-title-group {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.ai-history-title-group strong {
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.ai-history-title-group span {
  color: var(--text-quaternary);
  font-size: 11px;
  line-height: 16px;
}

.ai-history-list {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--shell-divider) 88%, transparent) transparent;
  -webkit-overflow-scrolling: touch;
}

.ai-history-list::-webkit-scrollbar {
  width: 8px;
}

.ai-history-list::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
  background-color: color-mix(in srgb, var(--shell-divider) 88%, transparent);
}

.ai-history-item {
  display: block;
  flex: 0 0 auto;
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 78%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-soft) 72%, transparent);
  overflow: hidden;
}

.ai-history-item:hover {
  border-color: color-mix(in srgb, var(--shell-divider) 100%, rgba(255, 255, 255, 0.12));
  background: color-mix(in srgb, var(--surface-soft) 100%, transparent);
}

.ai-history-item.is-active {
  border-color: color-mix(in srgb, var(--accent-strong) 34%, var(--shell-divider));
  background: color-mix(in srgb, var(--accent-strong) 8%, var(--surface-soft));
}

.ai-history-button {
  display: grid;
  width: 100%;
  gap: 6px;
  color: inherit;
  text-align: left;
  padding: 10px;
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
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-history-meta time {
  color: var(--text-quaternary);
}

.ai-history-content {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-history-subtitle {
  color: var(--text-quaternary);
  font-size: 11px;
  line-height: 16px;
}

.ai-history-empty {
  color: var(--text-quaternary);
  font-size: 12px;
  line-height: 18px;
  padding: 20px 16px;
  text-align: center;
}

.ai-history-footer {
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--shell-divider);
  padding: 8px;
}

.ai-history-footer button {
  height: 26px;
  border-radius: 6px;
  color: var(--text-tertiary);
  font-size: 12px;
  padding: 0 9px;
}

.ai-history-footer button:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-patch-entry {
  padding: 8px 12px 0;
}

.ai-quick-action,
.ai-button {
  height: 28px;
  border-radius: 6px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 500;
}

.ai-quick-action {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  background: color-mix(in srgb, var(--surface-soft) 80%, transparent);
  color: var(--text-secondary);
}

.ai-quick-action:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-composer-shell {
  flex: 0 0 auto;
  border-top: 1px solid var(--shell-divider);
  background: color-mix(in srgb, var(--panel-bg) 92%, var(--sidebar-bg));
}

.ai-composer-shell.has-plan {
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--panel-bg) 96%, transparent),
      color-mix(in srgb, var(--panel-bg) 90%, var(--sidebar-bg)));
}

.ai-composer-shell :deep(.ai-plan-mode-panel) {
  border-top: 0;
  background: transparent;
  padding: 8px 10px 0;
}

.ai-direct-tool-confirmation {
  padding: 8px 10px 0;
}

.ai-composer-shell :deep(.ai-composer) {
  padding: 8px 10px 10px;
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
  border: 1px solid color-mix(in srgb, var(--shell-divider) 100%, rgba(255, 255, 255, 0.1));
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel-bg) 96%, var(--sidebar-bg));
  padding: 16px;
}

.ai-dialog-copy h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
}

.ai-dialog-copy p {
  margin: 4px 0 0;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.55;
}

.ai-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.ai-button.is-ghost {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  background: transparent;
  color: var(--text-tertiary);
}

.ai-button.is-danger {
  border: 0;
  background: var(--danger);
  color: #fff;
}
</style>

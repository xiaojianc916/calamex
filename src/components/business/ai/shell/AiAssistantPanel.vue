<script setup lang="ts">
import { Bot, SquarePen, Trash2 } from '@lucide/vue';
import { AnimatePresence, Motion } from 'motion-v';
import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { useAcpApproval } from '@/composables/ai/useAcpApproval';
import { useAiAgentNetwork } from '@/composables/ai/useAiAgentNetwork';
import { useAiAssistant } from '@/composables/ai/useAiAssistant';
import { useAiConversationCheckpoints } from '@/composables/ai/useAiConversationCheckpoints';
import { useAiConversationHistory } from '@/composables/ai/useAiConversationHistory';
import { useAiTokenContext } from '@/composables/ai/useAiTokenContext';
import { useAiWebSources } from '@/composables/ai/useAiWebSources';
import { useCopilotSuggestions } from '@/composables/ai/useCopilotSuggestions';
import { findAiServicePlatformByModel } from '@/constants/ai/providers';
import { aiService } from '@/services/ipc/ai.service';
import { cloneAiConfigPayload, resolveDefaultAiBaseUrl } from '@/services/ipc/ai-config.service';
import { useAiThreadStore } from '@/store/aiThread';
import type {
  IAiConfigPayload,
  IAiProviderSettingsActionFeedback,
  TAiAgentNetworkPermission,
  TAiModelRole,
} from '@/types/ai';
import type { TAiExecutionMode } from '@/types/ai/execution-mode';
import type { IAskUserResult } from '@/types/ai/sidecar';
import type { IActiveRunSummary, IEditorDocument, IEditorSelectionSummary } from '@/types/editor';
import type { IGitDiffPreviewPayload, IGitRepositoryStatusPayload } from '@/types/git';
import { toErrorMessage } from '@/utils/error/error';
import { markStartup } from '@/utils/platform/startup-profiler';

const props = defineProps<{
  document: IEditorDocument;
  activeRun: IActiveRunSummary | null;
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
const selectionRef = computed(() => props.selection);
const gitStatusRef = computed(() => props.gitStatus);
const workspaceRootPathRef = computed(() => props.workspaceRootPath);
const assistant = useAiAssistant({
  document: documentRef,
  activeRun: activeRunRef,
  selection: selectionRef,
  gitStatus: gitStatusRef,
  workspaceRootPath: workspaceRootPathRef,
});
const agentNetwork = useAiAgentNetwork();
const webSources = useAiWebSources();
// ACP 工具调用审批闭环（ADR-20260617 D6）：订阅宿主经 ai:sidecar-approval 抹来的反向
// session/request_permission，在面板内渲染审批浮层并把用户决策原文回投。
const acpApproval = useAcpApproval();
const acpApprovalCurrent = computed(() => acpApproval.current.value);
// 外部 ACP Agent 的 AskUserQuestion 经反向 request_permission 抵达；识别为提问时改用输入框
// 内嵌的反向提问 UI 呈现，而非通用工具审批卡片。
const acpApprovalQuestions = computed(() => acpApprovalCurrent.value?.askUserQuestions ?? null);
const aiThreadStore = useAiThreadStore();
const renderThreadEntries = computed(() => aiThreadStore.renderActiveEntries);
const suggestionPool = useCopilotSuggestions();
const suggestionRows = computed(() =>
  splitSuggestionsIntoRows(suggestionPool.suggestions.value, 3),
);

const settingsDraft = ref<IAiConfigPayload>(cloneAiConfigPayload(assistant.config.value));
const settingsApiKey = ref('');
const settingsTavilyApiKey = ref('');
const isPromptModelSaving = ref(false);

// 当前会话使用的 Agent 后端（自研 / Kimi）。会话级单选，一个会话只用一种 Agent。
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

// kimi 会话向输入框透传 ACP 公示命令，供斜杠菜单作为内置命令列表；其它 Agent 不透传。
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

// 启动打点（阶段0·量化）：核心 composable 初始化完成。
markStartup('ai-assistant-panel-composables-ready');

const currentServicePlatform = computed(() =>
  findAiServicePlatformByModel(assistant.config.value.selectedModel),
);
const aiIconPlatformId = computed(() => currentServicePlatform.value.id);
const aiIconTitle = computed(() => currentServicePlatform.value.label);

// 网络权限 / 执行模式：legacy planStore 删除后，统一从 agentNetwork 暴露的 aiAgent store 取。
const networkPermission = computed(() => agentNetwork.store.networkPermission);
const executionMode = computed(() => agentNetwork.store.executionMode);

const reportError = (error: unknown, fallback: string): void => {
  assistant.error.value = toErrorMessage(error, fallback);
};

const composerDisabled = computed(
  () => assistant.isSending.value || (acpApproval.hasPending.value && !acpApprovalQuestions.value),
);
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

// 接收侧 ACP usage_update 闭环（ADR-20260617 · D7-⑦）：宿主已把 usage_update 投影为共享
// IAiLanguageModelUsage VM；本回合有 ACP 用量即采用，无则置空（plan 旧用量来源已随 store 删除）。
const tokenOfficialUsage = computed(() => assistant.acpUsage.usage.value ?? null);
const { contextProps: tokenContextProps } = useAiTokenContext({
  mode: computed(() => assistant.activeMode.value),
  modelId: computed(() => assistant.config.value.selectedModel),
  entries: computed(() => aiThreadStore.authoritativeActiveEntries),
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
const assistantTypingLabel = '正在准备回复';

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

const handleSearchWebSources = async (query: string): Promise<void> => {
  try {
    await webSources.search(
      {
        query,
        intent: 'general',
        maxResults: 5,
        recency: 'any',
      },
      {},
    );
  } catch (error) {
    reportError(error, '网络搜索失败。');
  }
};
const handleFetchWebSource = async (sourceId: string): Promise<void> => {
  try {
    await webSources.fetchSource(sourceId);
  } catch (error) {
    reportError(error, '网页读取失败。');
  }
};

// 主模型选择器变更：只对 builtin（mastra 全局模型）生效，把 selectedModel 持久化到 ai.json。
// kimi 等外部 Agent 的模型切换走 ACP config_options（handleSessionConfigOptionChange），不经此路径。
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
    reportError(error, '设置网络访问权限失败。');
  }
};

const openPromptInformationSources = (): void => {
  openSettings();
};

const openPromptPersonalization = (): void => {
  openSettings();
};

const handlePromptExecutionModeChange = (mode: TAiExecutionMode): void => {
  agentNetwork.store.setExecutionMode(mode);
};

// kimi(ACP) 会话配置项变更：把输入框选择的 optionId/value 路由到当前会话的 ACP 配置项切换。
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
        event: 'builtin_agent_warmup.skipped',
        reason: toErrorMessage(error, '预热连接失败'),
      }),
    );
  });
};

const handleResolveAcpApproval = async (optionId: string): Promise<void> => {
  const current = acpApprovalCurrent.value;

  if (!current) {
    return;
  }

  try {
    await acpApproval.resolve(current.toolCallId, optionId);
  } catch (error) {
    assistant.error.value = toErrorMessage(error, '提交工具调用审批失败。');
  }
};

const handleCancelAcpApproval = (): void => {
  const current = acpApprovalCurrent.value;

  if (!current) {
    return;
  }

  // 取消审批 = 取消当前回合：先本地出队避免重复呈现，再触发带外 ai_cancel；
  // 宿主 ApprovalRegistry::cancel_session 丢弃 sender → Cancelled，经带外 responder 回投。
  acpApproval.dismiss(current.toolCallId);
  void assistant.stopCurrentRequest();
};

const handleResolveAcpUserQuestion = async (result: IAskUserResult): Promise<void> => {
  const current = acpApprovalCurrent.value;

  if (!current) {
    return;
  }

  // 选中候选项 / 命中 Skip(reject) → 回投该 optionId 原值（对齐 approval.rs 逐字匹配）。
  const decision = resolveAcpDecisionFromAskUserResult(current.request, result);

  if (decision) {
    try {
      await acpApproval.resolve(current.toolCallId, decision);
    } catch (error) {
      assistant.error.value = toErrorMessage(error, '提交工具调用审批失败。');
    }
    return;
  }

  // 既未选项也无 reject 可回投 → 取消当前回合（带外 ai_cancel）。
  acpApproval.dismiss(current.toolCallId);
  void assistant.stopCurrentRequest();
};

const handleCancelAcpUserQuestion = (): void => {
  void handleResolveAcpUserQuestion({ outcome: 'cancelled' });
};

// 组合器内联提问：AiPromptInput 内嵌提问框的答案 / 取消，路由到 ACP 反向提问处理器。
const handleComposerQuestionSubmit = (answers: NonNullable<IAskUserResult['answers']>): void => {
  if (!acpApprovalQuestions.value) {
    return;
  }

  void handleResolveAcpUserQuestion({ outcome: 'selected', answers });
};
const handleComposerQuestionCancel = (): void => {
  if (!acpApprovalQuestions.value) {
    return;
  }

  void handleCancelAcpUserQuestion();
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

// 启动打点（阶段0·量化）：同步 setup（含派生计算）全部完成。
markStartup('ai-assistant-panel-setup-done');

onMounted(() => {
  // 启动打点（阶段0·量化）：子组件渲染挂载完成（首帧）。
  markStartup('ai-assistant-panel-mounted');
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
                      <div class="ai-history-subtitle" v-text="getHistoryMessageCountLabel(thread)"></div>
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
      <AiChatThread :is-typing="assistant.isSending.value"
        :thread-entries="renderThreadEntries"
        :streaming-message-id="assistant.activeAgentMessageId.value"
        :platform-id="aiIconPlatformId" :provider-label="aiIconTitle"
        :conversation-id="assistant.activeConversationId.value" :workspace-root-path="workspaceRootPath"
        :scroll-state="assistant.activeConversationScrollState.value" :typing-label="assistantTypingLabel"
        :reverting-changed-files-summary-id="assistant.revertingChangedFilesSummaryId.value"
        :pinning-changed-files-summary-id="assistant.pinningChangedFilesSummaryId.value"
        @scroll-state-change="handleConversationScrollStateChange"
        @changed-files-rollback="assistant.rollbackChangedFilesSummary"
        @changed-files-pin="assistant.setChangedFilesSummaryPin">
        <template #empty>
          <AiAssistantSuggestionEmpty :suggestion-rows="suggestionRows" :disabled="composerDisabled"
            @select="handleSuggestionSelect" />
        </template>
        <template #after-message="{ messageId }">
          <AiAssistantCheckpointEntry v-if="getConversationCheckpoint(messageId)"
            :label="getConversationCheckpointLabel(messageId)" :disabled="isConversationCheckpointDisabled"
            :restoring="isConversationCheckpointRestoring(messageId)"
            @restore="handleRestoreConversationCheckpoint(messageId)" />
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
        :activity="webSources.activity.value" :error-message="webSources.errorMessage.value"
        :is-searching="webSources.isSearching.value" :network-permission="networkPermission"
        @search="handleSearchWebSources" @fetch-source="handleFetchWebSource" @clear="webSources.clear" />
      <div class="ai-composer-shell">
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
          :user-questions="acpApprovalQuestions ?? null"
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

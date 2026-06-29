// d1s3.mjs — D1 切片3：AiAssistantPanel.vue 删除整套 legacy plan/run UI，收敛为 ACP-native
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const FILE = join(ROOT, 'src/components/business/ai/shell/AiAssistantPanel.vue');

const LF = (s) => s.split('\r\n').join('\n');

const raw = readFileSync(FILE, 'utf8');
const usesCRLF = raw.includes('\r\n');
let content = LF(raw);

function replaceOnce(hay, oldStr, newStr, label) {
  const o = LF(oldStr);
  const first = hay.indexOf(o);
  if (first === -1) throw new Error('[D1S3] 锚点未命中: ' + label);
  if (hay.indexOf(o, first + o.length) !== -1) throw new Error('[D1S3] 锚点不唯一: ' + label);
  return hay.slice(0, first) + LF(newStr) + hay.slice(first + o.length);
}

function replaceBetween(hay, startAnchor, endAnchor, newStr, label) {
  const sa = LF(startAnchor);
  const ea = LF(endAnchor);
  const s = hay.indexOf(sa);
  if (s === -1) throw new Error('[D1S3] 起锚未命中: ' + label);
  if (hay.indexOf(sa, s + sa.length) !== -1) throw new Error('[D1S3] 起锚不唯一: ' + label);
  const e = hay.indexOf(ea, s + sa.length);
  if (e === -1) throw new Error('[D1S3] 止锚未命中: ' + label);
  if (hay.indexOf(ea, e + ea.length) !== -1) throw new Error('[D1S3] 止锚不唯一: ' + label);
  return hay.slice(0, s) + LF(newStr) + hay.slice(e + ea.length);
}

const SCRIPT_OPEN = '<script setup lang="ts">';
const SCRIPT_CLOSE = '</scr' + 'ipt>'; // 仅为安全贴入，运行时即字符串 </script>

const NEW_SCRIPT = SCRIPT_OPEN + `
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
  IAiChatMessage,
  IAiConfigPayload,
  IAiProviderSettingsActionFeedback,
  TAiAgentNetworkPermission,
  TAiModelRole,
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

const isAgentTokenMessage = (message: IAiChatMessage): boolean =>
  message.role !== 'assistant' ||
  Boolean(message.toolCalls?.length) ||
  Boolean(message.stream?.runtimeEvents?.length);

const threadMessages = computed<IAiChatMessage[]>(() => assistant.messages.value);
const tokenUsageMessages = computed<IAiChatMessage[]>(() => {
  if (assistant.activeMode.value === 'chat') {
    return threadMessages.value;
  }

  return assistant.messages.value.filter(isAgentTokenMessage);
});
const tokenEstimationMessages = computed<IAiChatMessage[]>(() => {
  if (assistant.activeMode.value === 'chat') {
    return threadMessages.value;
  }

  return [];
});
const tokenContextReferences = computed(() =>
  assistant.attachedFiles.value.map((file) => file.reference),
);
const hasPendingTokenRequest = computed(
  () => assistant.draft.value.trim().length > 0 || assistant.attachedFiles.value.length > 0,
);
// 接收侧 ACP usage_update 闭环（ADR-20260617 · D7-⑦）：宿主已把 usage_update 投影为共享
// IAiLanguageModelUsage VM；本回合有 ACP 用量即采用，无则置空（plan 旧用量来源已随 store 删除）。
const tokenOfficialUsage = computed(() => assistant.acpUsage.usage.value ?? null);
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
` + SCRIPT_CLOSE;

// ── 1) 整段替换 <script setup> ───────────────────────────────────────────────
content = replaceBetween(content, SCRIPT_OPEN, SCRIPT_CLOSE, NEW_SCRIPT, 'script-block');

// ── 2) 模板：删 run 状态条（legacy run + 工具确认 UI）─────────────────────────
content = replaceOnce(
  content,
  '        <AiThreadRunStatusBar :run="planActiveRun" :confirmation="visibleDirectToolConfirmation"\n' +
    '          :busy="isAgentRunActionPending" @pause="handlePauseRun" @resume="handleResumeRun" @cancel="handleCancelRun"\n' +
    '          @resolve="handleResolveToolConfirmation" />\n',
  '',
  'tpl:AiThreadRunStatusBar',
);

// ── 3) 模板：AiChatThread 改喂 renderThreadEntries，去掉 plan-details / @plan-* ──
content = replaceOnce(
  content,
  '        :thread-entries="visibleThreadEntries"',
  '        :thread-entries="renderThreadEntries"',
  'tpl:thread-entries',
);
content = replaceOnce(content, '        :plan-details="threadPlanDetails"\n', '', 'tpl:plan-details');
content = replaceOnce(
  content,
  '        @changed-files-pin="assistant.setChangedFilesSummaryPin" @plan-approve="handleApprovePlan"\n' +
    '        @plan-reject="handleRejectPlan" @plan-regenerate="handleRegeneratePlan"\n' +
    '        @plan-update-step-title="handleUpdatePlanStepTitle" @plan-remove-step="handleRemovePlanStep">',
  '        @changed-files-pin="assistant.setChangedFilesSummaryPin">',
  'tpl:plan-events',
);

// ── 4) 模板：Web 来源活动指示去掉已删的 planProgressVisible ───────────────────
content = replaceOnce(
  content,
  ':activity="planProgressVisible ? null : webSources.activity.value"',
  ':activity="webSources.activity.value"',
  'tpl:web-activity',
);

// ── 5) 模板：反向提问只剩 ACP 来源（删 legacy visibleUserQuestion）────────────
content = replaceOnce(
  content,
  '          :user-questions="acpApprovalQuestions ?? visibleUserQuestion?.questions ?? null"',
  '          :user-questions="acpApprovalQuestions ?? null"',
  'tpl:user-questions',
);

const out = usesCRLF ? content.split('\n').join('\r\n') : content;
writeFileSync(FILE, out, 'utf8');
console.log('[D1S3] AiAssistantPanel.vue 已重写：legacy plan/run UI 子系统已移除，收敛为 ACP-native。');
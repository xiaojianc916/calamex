import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, ref } from 'vue';
import AiAssistantPanel from '@/components/business/ai/shell/AiAssistantPanel.vue';
import { createDefaultAiModelEndpointConfig } from '@/services/ipc/ai-config.service';
import type {
  IAiAgentPlanMetadata,
  IAiAgentRun,
  IAiAgentStepFinalAnswer,
  IAiChatMessage,
  IAiConfigPayload,
  IAiContextReference,
  IAiLanguageModelUsage,
  IAiTaskPlanStep,
  IAiToolActivityInline,
  IAiToolConfirmationRequest,
} from '@/types/ai';
import type { TAgentRuntimeEvent } from '@/types/ai/sidecar';
import type {
  IActiveRunSummary,
  IAnalyzeScriptPayload,
  IEditorDocument,
  IEditorSelectionSummary,
} from '@/types/editor';
import type { IGitRepositoryStatusPayload } from '@/types/git';

const useAiAssistantMock = vi.hoisted(() => vi.fn());
const useAiAgentRunMock = vi.hoisted(() => vi.fn());
const useAiAgentNetworkMock = vi.hoisted(() => vi.fn());
const useAiWebSourcesMock = vi.hoisted(() => vi.fn());
const useAiTokenContextMock = vi.hoisted(() => vi.fn());
const useCopilotSuggestionsMock = vi.hoisted(() => vi.fn());
const useAcpApprovalMock = vi.hoisted(() => vi.fn());

vi.mock('@/composables/ai/useAiAssistant', () => ({
  useAiAssistant: useAiAssistantMock,
}));

vi.mock('@/composables/ai/useAiAgentRun', () => ({
  useAiAgentRun: useAiAgentRunMock,
}));

vi.mock('@/composables/ai/useAiAgentNetwork', () => ({
  useAiAgentNetwork: useAiAgentNetworkMock,
}));

vi.mock('@/composables/ai/useAiWebSources', () => ({
  useAiWebSources: useAiWebSourcesMock,
}));

vi.mock('@/composables/ai/useAiTokenContext', () => ({
  useAiTokenContext: useAiTokenContextMock,
}));

vi.mock('@/composables/ai/useCopilotSuggestions', () => ({
  useCopilotSuggestions: useCopilotSuggestionsMock,
}));

vi.mock('@/composables/ai/useAcpApproval', () => ({
  useAcpApproval: useAcpApprovalMock,
}));

type TAssistantMode = 'chat' | 'agent' | 'plan';

interface IAiConversationThreadMock {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: IAiChatMessage[];
}

interface ITokenContextArgs {
  messages: { value: IAiChatMessage[] };
  estimationMessages: { value: IAiChatMessage[] };
  officialUsage?: { value: IAiLanguageModelUsage | null | undefined };
}

let latestTokenContextArgs: ITokenContextArgs | null = null;

const createMessage = (
  id: string,
  role: IAiChatMessage['role'],
  content: string,
): IAiChatMessage => ({
  id,
  role,
  content,
  createdAt: '2026-04-28T10:00:00.000Z',
  references: [],
});

const createPlanStep = (
  id: string,
  title: string,
  status: IAiTaskPlanStep['status'] = 'pending',
): IAiTaskPlanStep => ({
  id,
  index: Number(id.replace('plan-step-', '')) - 1,
  title,
  goal: title,
  kind: status === 'done' ? 'verify' : 'inspect',
  status,
  expectedOutput: `${title}的输出`,
  tools: status === 'running' ? ['read_file'] : ['get_diagnostics'],
  requiresUserApproval: false,
  riskLevel: 'low',
});

const createAgentRun = (steps: IAiTaskPlanStep[], currentStepId: string | null): IAiAgentRun => ({
  id: 'agent-run-1',
  goal: '重构 AI 面板模式边界',
  status: currentStepId ? 'running-step' : 'completed',
  steps,
  currentStepId,
  createdAt: '2026-04-29T10:00:00.000Z',
  updatedAt: '2026-04-29T10:00:03.000Z',
  startedAt: '2026-04-29T10:00:00.000Z',
  completedAt: currentStepId ? null : '2026-04-29T10:00:03.000Z',
  errorMessage: null,
});

const createDocument = (): IEditorDocument => ({
  id: 'doc-1',
  path: 'src/app.ts',
  name: 'app.ts',
  kind: 'text',
  content: 'const ready = true;',
  encoding: 'utf-8',
  savedContent: 'const ready = true;',
  savedEncoding: 'utf-8',
  isDirty: false,
  lineCount: 1,
  charCount: 19,
});

const createAnalysis = (): IAnalyzeScriptPayload => ({
  available: true,
  message: null,
  dialect: 'typescript',
  diagnostics: [],
});

const createGitStatus = (): IGitRepositoryStatusPayload => ({
  available: false,
  message: null,
  repositoryRootPath: null,
  repositoryName: null,
  gitDirPath: null,
  headBranchName: null,
  headShortName: null,
  headShortOid: null,
  isDetached: false,
  isClean: true,
  ahead: 0,
  behind: 0,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  conflictedCount: 0,
  files: [],
  lastCommit: null,
});

const createAssistantMock = (messagesList: IAiChatMessage[] = []) => {
  const config = ref<IAiConfigPayload>({
    providerType: 'mastra',
    selectedModel: 'deepseek/deepseek-v4-pro',
    baseUrl: 'http://127.0.0.1:4000/v1',
    isBaseUrlConfigured: true,
    hasCredentials: false,
    isConfigured: true,
    inlineCompletionEnabled: false,
    chatEnabled: true,
    agentEnabled: true,
    narrator: createDefaultAiModelEndpointConfig('zhipuai/glm-4.7-flash'),
    credentials: [],
  });
  const messages = ref<IAiChatMessage[]>(messagesList);
  const historyThreads = ref<IAiConversationThreadMock[]>([]);
  const activeConversationId = ref<string | null>('thread-active');
  const activeConversationScrollState = ref(null);
  const activeMode = ref<TAssistantMode>('chat');
  const isSettingsOpen = ref(false);
  const isClearDialogOpen = ref(false);
  const isSending = ref(false);
  const draft = ref('');
  const errorMessage = ref('');
  const currentReferences = ref<IAiContextReference[]>([]);
  const attachedFiles = ref(
    [] as Array<{
      id: string;
      name: string;
      sizeLabel: string;
      kind: 'text' | 'image';
      reference: IAiContextReference;
    }>,
  );
  const runtimeTimelineEvents = ref<TAgentRuntimeEvent[]>([]);
  const conversationCheckpoints = ref<
    Array<{
      id: string;
      messageId: string;
      runId: string;
      snapshotId: string;
      sessionId: string;
      createdAt: string;
    }>
  >([]);
  const restoringCheckpointId = ref<string | null>(null);
  const revertingChangedFilesSummaryId = ref<string | null>(null);
  const pinningChangedFilesSummaryId = ref<string | null>(null);
  const fileRollbackPrompt = ref(null);
  const acpUsageRef = ref<IAiLanguageModelUsage | null>(null);

  const agentPlanStore = {
    mode: 'chat' as 'chat' | 'plan',
    activeGoal: '',
    steps: [] as IAiTaskPlanStep[],
    classification: null,
    classificationReason: '',
    shouldEnterPlanMode: false,
    isPlanning: false,
    isApproving: false,
    approvedAt: null as string | null,
    errorMessage: '',
    hasPlan: false,
    planSummary: null as string | null,
    planId: null as string | null,
    planVersion: null as number | null,
    planThreadId: null as string | null,
    planCreatedAt: null as string | null,
    planUpdatedAt: null as string | null,
    planExecutedAt: null as string | null,
    planRejectionReason: null as string | null,
    planErrorMessage: null as string | null,
    planVersions: [],
    planStatus: null as IAiAgentPlanMetadata['status'] | null,
    isClassifying: false,
    activeRunId: null as string | null,
    activeRun: null as IAiAgentRun | null,
    stepDetails: {},
    stepFinalAnswers: {},
    patchSummaries: {},
    toolActivities: {},
    pendingToolConfirmation: null as IAiToolConfirmationRequest | null,
    pendingSidecarAgentSession: null as { threadId?: string | null } | null,
    activeToolActivity: null as IAiToolActivityInline | null,
    totalOfficialUsageResolved: false,
    totalOfficialUsage: null,
    getToolActivities: vi.fn((): IAiToolActivityInline[] => []),
    getStepFinalAnswers: vi.fn((): IAiAgentStepFinalAnswer[] => []),
    getPatchSummaries: vi.fn(() => []),
    appendStepToolResults: vi.fn(),
    setStepWebSources: vi.fn(),
  };

  return {
    acpSessionModes: {
      state: computed(() => null),
      modes: computed(() => []),
      hasModes: computed(() => false),
      isSwitching: computed(() => false),
      loadModes: vi.fn().mockResolvedValue(undefined),
      selectMode: vi.fn().mockResolvedValue(undefined),
      applyCurrentModeUpdate: vi.fn(),
      reset: vi.fn(),
    },
    activeAgentMessageId: ref<string | null>(null),
    acpSessionConfigOptions: {
      state: computed(() => null),
      configOptions: computed(() => []),
      hasConfigOptions: computed(() => false),
      isSwitching: computed(() => false),
      loadConfigOptions: vi.fn().mockResolvedValue(undefined),
      selectConfigOption: vi.fn().mockResolvedValue(undefined),
      applyConfigOptionUpdate: vi.fn(),
      reset: vi.fn(),
    },
    acpAvailableCommands: {
      state: computed(() => null),
      commands: computed(() => []),
      hasCommands: computed(() => false),
      applyCommandsUpdate: vi.fn(),
      reset: vi.fn(),
    },
    acpUsage: {
      usage: acpUsageRef,
      hasUsage: computed(() => acpUsageRef.value !== null),
      applyUsageUpdate: vi.fn(),
      reset: vi.fn(),
    },
    config,
    messages,
    historyThreads,
    activeConversationId,
    activeConversationScrollState,
    activeMode,
    isSettingsOpen,
    isClearDialogOpen,
    isSending,
    draft,
    errorMessage,
    error: errorMessage,
    currentReferences,
    agentSteps: ref<IAiTaskPlanStep[]>([]),
    attachedFiles,
    runtimeTimelineEvents,
    conversationCheckpoints,
    restoringCheckpointId,
    revertingChangedFilesSummaryId,
    pinningChangedFilesSummaryId,
    fileRollbackPrompt,
    agentPlan: {
      store: agentPlanStore,
      classifyTask: vi.fn(),
      createPlan: vi.fn(),
      regeneratePlan: vi.fn(),
      updateStep: vi.fn(),
      removeStep: vi.fn(),
      approvePlan: vi.fn().mockResolvedValue(undefined),
      rejectPlan: vi.fn().mockResolvedValue(undefined),
      resetPlan: vi.fn(),
      restorePersistedPlanState: vi.fn().mockResolvedValue(undefined),
    },
    sendButtonLabel: computed(() => '发送'),
    loadConfig: vi.fn().mockResolvedValue(undefined),
    loadTavilyApiKey: vi.fn().mockResolvedValue(''),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    saveTavilyApiKey: vi.fn().mockResolvedValue('ok'),
    testProviderConfig: vi.fn().mockResolvedValue('ok'),
    connectProvider: vi.fn().mockResolvedValue('ok'),
    rollbackLatestFileChange: vi.fn(),
    rollbackChangedFilesSummary: vi.fn(),
    setChangedFilesSummaryPin: vi.fn(),
    restoreConversationCheckpoint: vi.fn().mockResolvedValue(undefined),
    resolveSidecarToolConfirmation: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    stopCurrentRequest: vi.fn(),
    startNewConversation: vi.fn(),
    switchConversation: vi.fn(),
    deleteConversation: vi.fn().mockReturnValue(true),
    updateConversationScrollState: vi.fn(),
    attachFile: vi.fn(),
    removeAttachedFile: vi.fn(),
    buildSidecarContextReferences: vi.fn(() => currentReferences.value),
    clearConversation: vi.fn(),
  };
};

interface IAcpApprovalCurrentMock {
  sessionId: string;
  toolCallId: string;
  request: { sessionId: string; toolCallId: string; options: unknown[] };
  approval: {
    title: string;
    summary: string | null;
    impact: string | null;
    options: Array<{ id: string; label: string; shortcut?: string; tone?: 'default' | 'danger' }>;
  };
}

const createAcpApprovalCurrent = (): IAcpApprovalCurrentMock => ({
  sessionId: 'acp-session-1',
  toolCallId: 'tool-call-1',
  request: { sessionId: 'acp-session-1', toolCallId: 'tool-call-1', options: [] },
  approval: {
    title: '是否允许写入 src/app.ts？',
    summary: null,
    impact: null,
    options: [
      { id: 'allow-once-id', label: '允许一次', shortcut: 'y', tone: 'default' },
      { id: 'reject-once-id', label: '拒绝', shortcut: 'n', tone: 'danger' },
    ],
  },
});

const createAcpApprovalMock = (current: IAcpApprovalCurrentMock | null = null) => {
  const currentRef = ref<IAcpApprovalCurrentMock | null>(current);

  return {
    pending: computed(() => (currentRef.value ? [currentRef.value] : [])),
    current: computed(() => currentRef.value),
    hasPending: computed(() => currentRef.value !== null),
    resolve: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn(),
  };
};

const mountPanel = (_assistantMock: ReturnType<typeof createAssistantMock>) =>
  mount(AiAssistantPanel, {
    props: {
      document: createDocument(),
      activeRun: null as IActiveRunSummary | null,
      analysis: createAnalysis(),
      selection: null as IEditorSelectionSummary | null,
      gitStatus: createGitStatus(),
      workspaceRootPath: 'd:/com.xiaojianc/my_desktop_app',
    },
    global: {
      stubs: {
        AiPanelFrame: defineComponent({
          template:
            '<section class="ai-panel-frame"><header><slot name="mark" /><slot name="actions" /></header><main><slot name="body" /></main><footer><slot name="composer" /></footer></section>',
        }),
        AiProviderIcon: defineComponent({
          template: '<span class="ai-provider-icon" />',
        }),
        Select: defineComponent({
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template: '<div data-testid="agent-mark-select"><slot /></div>',
        }),
        SelectTrigger: defineComponent({
          template: '<button type="button"><slot /></button>',
        }),
        SelectContent: defineComponent({
          template: '<div><slot /></div>',
        }),
        SelectGroup: defineComponent({
          template: '<div><slot /></div>',
        }),
        SelectItem: defineComponent({
          props: ['value'],
          template: '<div><slot /></div>',
        }),
        SelectLabel: defineComponent({
          template: '<div><slot /></div>',
        }),
        // 平铺时间线替身:plan 审批不再是独立面板,而是 thread-entries 里一条 type 为
        // plan_control 的数据模型条目(渲染期 overlay),步骤明细由 planDetails 传入就地渲染,
        // 审批事件向上冒泡;真实组件经 threadEntriesToTimeline 投影为 plan-control 渲染条目。
        AiChatThread: defineComponent({
          props: ['messages', 'threadEntries', 'isTyping', 'typingLabel', 'planDetails'],
          emits: [
            'planApprove',
            'planReject',
            'planRegenerate',
            'planUpdateStepTitle',
            'planRemoveStep',
          ],
          template:
            '<section data-testid="chat-thread"><slot name="empty" /><div v-if="(threadEntries ?? []).some((entry) => entry.type === \'plan_control\')" data-testid="plan-confirmation"><ol><li v-for="step in (planDetails?.steps ?? [])" :key="step.id" v-text="step.title" /></ol><button data-testid="approve-plan" :disabled="!planDetails?.canApprove" @click="$emit(\'planApprove\')">批准</button></div><template v-for="message in messages.filter((entry) => !entry.id.startsWith(\'agent-flow:\'))" :key="message.id"><article :data-role="message.role" v-text="message.content" /><slot name="after-message" :message="message" /></template></section>',
        }),
        AiAssistantSuggestionEmpty: defineComponent({
          props: ['suggestionRows', 'disabled'],
          emits: ['select'],
          template:
            '<div data-testid="suggestion-empty"><button v-for="suggestion in suggestionRows.flat()" :key="suggestion.title" data-testid="suggestion-chip" :disabled="disabled" @click="$emit(\'select\', suggestion.message)" v-text="suggestion.title" /></div>',
        }),
        AiAssistantCheckpointEntry: defineComponent({
          props: ['label', 'disabled', 'restoring'],
          emits: ['restore'],
          template:
            '<button data-testid="checkpoint-entry" :disabled="disabled" @click="$emit(\'restore\')" v-text="label" />',
        }),
        // 输入框上方的 Codex 风格运行细条:运行进度 + 工具/计划确认都收敛到这里。
        AiThreadRunStatusBar: defineComponent({
          props: ['run', 'confirmation', 'busy'],
          emits: ['pause', 'resume', 'cancel', 'resolve'],
          template:
            '<div v-if="run || confirmation" data-testid="run-status-bar"><strong v-if="confirmation" data-testid="tool-confirmation" v-text="confirmation.question" /><button v-if="confirmation" data-testid="resolve-confirmation" @click="$emit(\'resolve\', \'allow-once\')">允许</button></div>',
        }),
        AiPromptInput: defineComponent({
          emits: [
            'submit',
            'update:activeMode',
            'update:agentBackend',
            'sessionConfigOptionChange',
          ],
          template:
            '<div data-testid="prompt-input"><button data-testid="switch-plan" @click="$emit(\'update:activeMode\', \'plan\')">切到 Plan</button><button data-testid="switch-config-option" @click="$emit(\'sessionConfigOptionChange\', \'model\', \'kimi-k2\')">切换配置</button><button data-testid="submit" @click="$emit(\'submit\')">发送</button></div>',
        }),
        ApprovalPrompt: defineComponent({
          props: ['title', 'reason', 'options', 'autofocus'],
          emits: ['select', 'cancel'],
          setup(props, { emit }) {
            return () =>
              h('div', { 'data-testid': 'acp-approval' }, [
                h('strong', { 'data-testid': 'acp-approval-title' }, props.title),
                h(
                  'button',
                  {
                    'data-testid': 'acp-approval-allow',
                    onClick: () => emit('select', props.options[0]?.id),
                  },
                  '允许',
                ),
                h(
                  'button',
                  { 'data-testid': 'acp-approval-cancel', onClick: () => emit('cancel') },
                  '取消',
                ),
              ]);
          },
        }),
        AiProviderSettings: defineComponent({ template: '<div />' }),
        AiWebSourcesPanel: defineComponent({ template: '<div />' }),
        teleport: true,
      },
    },
  });

describe('AiAssistantPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    latestTokenContextArgs = null;
    useCopilotSuggestionsMock.mockReturnValue({
      suggestions: ref([{ title: '讲一个科学小知识', message: '讲一个科学小知识' }]),
      rotateBatch: vi.fn(),
    });
    useAiAgentRunMock.mockReturnValue({
      runPlanToCompletion: vi.fn().mockResolvedValue(undefined),
      runStepWithSidecar: vi.fn().mockResolvedValue(null),
      pauseRun: vi.fn().mockResolvedValue(null),
      resumeRun: vi.fn().mockResolvedValue(null),
      continueRunToCompletion: vi.fn().mockResolvedValue(undefined),
      cancelRun: vi.fn().mockResolvedValue(null),
      hasSidecarStepToolConfirmation: vi.fn(() => false),
      resolveSidecarStepToolConfirmation: vi.fn().mockResolvedValue(null),
    });
    useAiAgentNetworkMock.mockReturnValue({
      store: { networkPermission: 'ask' },
      pending: ref(false),
      setNetworkPermission: vi.fn().mockResolvedValue(undefined),
    });
    useAiWebSourcesMock.mockReturnValue({
      sources: ref([]),
      activity: ref(null),
      errorMessage: ref(''),
      isSearching: ref(false),
      search: vi.fn().mockResolvedValue(undefined),
      fetchSource: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
    });
    useAiTokenContextMock.mockImplementation((args: ITokenContextArgs) => {
      latestTokenContextArgs = args;
      return { contextProps: computed(() => ({ state: 'idle' })) };
    });
    useAcpApprovalMock.mockReturnValue(createAcpApprovalMock());
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders a single unified thread surface for chat mode', () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '解释当前文件'),
      createMessage('message-assistant', 'assistant', '这是普通聊天回复'),
    ]);
    assistantMock.activeMode.value = 'chat';
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mountPanel(assistantMock);

    expect(wrapper.find('[data-testid="chat-thread"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="chat-thread"]').text()).toContain('这是普通聊天回复');
    expect(wrapper.find('[data-testid="plan-confirmation"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="run-status-bar"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="tool-confirmation"]').exists()).toBe(false);
  });

  it('surfaces a direct tool confirmation in the run status bar above the composer', () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '修改这个项目'),
      createMessage('message-assistant', 'assistant', 'Agent 最终回复'),
    ]);
    assistantMock.activeMode.value = 'agent';
    assistantMock.agentPlan.store.pendingToolConfirmation = {
      id: 'confirmation-1',
      runId: 'run-1',
      stepId: 'step-1',
      toolName: 'run_command',
      question: '允许执行 pnpm test 吗？',
      summary: '运行验证命令',
      riskLevel: 'medium',
      impact: '会在当前工作区执行命令。',
      reversible: false,
      createdAt: '2026-04-29T00:00:00.000Z',
      options: [{ id: 'allow-once', label: '允许', tone: 'primary' }],
    };
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mountPanel(assistantMock);

    expect(wrapper.find('[data-testid="chat-thread"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="chat-thread"]').text()).toContain('Agent 最终回复');
    expect(wrapper.find('[data-testid="run-status-bar"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="tool-confirmation"]').text()).toContain(
      '允许执行 pnpm test 吗？',
    );
  });

  it('routes a tool confirmation decision from the run status bar to the assistant', async () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '修改这个项目'),
    ]);
    assistantMock.activeMode.value = 'agent';
    assistantMock.agentPlan.store.pendingToolConfirmation = {
      id: 'confirmation-1',
      runId: 'run-1',
      stepId: 'step-1',
      toolName: 'run_command',
      question: '允许执行 pnpm test 吗？',
      summary: '运行验证命令',
      riskLevel: 'medium',
      impact: '会在当前工作区执行命令。',
      reversible: false,
      createdAt: '2026-04-29T00:00:00.000Z',
      options: [{ id: 'allow-once', label: '允许', tone: 'primary' }],
    };
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mountPanel(assistantMock);

    await wrapper.get('[data-testid="resolve-confirmation"]').trigger('click');

    expect(assistantMock.resolveSidecarToolConfirmation).toHaveBeenCalledWith('allow-once');
  });

  it('renders Plan approval as an inline plan-control entry in the unified thread', () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '重构 AI 模式 UI'),
    ]);
    assistantMock.activeMode.value = 'plan';
    assistantMock.agentPlan.store.hasPlan = true;
    assistantMock.agentPlan.store.activeGoal = '重构 AI 模式 UI';
    assistantMock.agentPlan.store.planStatus = 'pending_approval';
    assistantMock.agentPlan.store.steps = [
      createPlanStep('plan-step-1', '审查模式边界'),
      createPlanStep('plan-step-2', '接线统一线程'),
    ];
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mountPanel(assistantMock);

    expect(wrapper.find('[data-testid="chat-thread"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="plan-confirmation"]').text()).toContain('审查模式边界');
    expect(wrapper.get('[data-testid="approve-plan"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-testid="run-status-bar"]').exists()).toBe(false);
  });

  it('forwards the inline plan approval to the agent run pipeline', async () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '重构 AI 模式 UI'),
    ]);
    const agentRunMock = {
      runPlanToCompletion: vi.fn().mockResolvedValue(undefined),
      runStepWithSidecar: vi.fn().mockResolvedValue(null),
      pauseRun: vi.fn().mockResolvedValue(null),
      resumeRun: vi.fn().mockResolvedValue(null),
      continueRunToCompletion: vi.fn().mockResolvedValue(undefined),
      cancelRun: vi.fn().mockResolvedValue(null),
      hasSidecarStepToolConfirmation: vi.fn(() => false),
      resolveSidecarStepToolConfirmation: vi.fn().mockResolvedValue(null),
    };
    useAiAgentRunMock.mockReturnValue(agentRunMock);
    assistantMock.activeMode.value = 'plan';
    assistantMock.agentPlan.store.hasPlan = true;
    assistantMock.agentPlan.store.activeGoal = '重构 AI 模式 UI';
    assistantMock.agentPlan.store.planStatus = 'pending_approval';
    assistantMock.agentPlan.store.steps = [
      createPlanStep('plan-step-1', '审查模式边界'),
      createPlanStep('plan-step-2', '接线统一线程'),
    ];
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mountPanel(assistantMock);

    await wrapper.get('[data-testid="approve-plan"]').trigger('click');
    await Promise.resolve();

    expect(assistantMock.agentPlan.approvePlan).toHaveBeenCalledTimes(1);
    expect(agentRunMock.runPlanToCompletion).toHaveBeenCalledTimes(1);
  });

  it('does not render synthetic plan progress messages in the unified thread', () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '继续执行计划'),
    ]);
    const steps = [
      createPlanStep('plan-step-1', '读取源码', 'running'),
      createPlanStep('plan-step-2', '修改 UI', 'pending'),
    ];
    const activeRun = createAgentRun(steps, 'plan-step-1');
    assistantMock.activeMode.value = 'plan';
    assistantMock.agentPlan.store.hasPlan = true;
    assistantMock.agentPlan.store.activeGoal = '继续执行计划';
    assistantMock.agentPlan.store.steps = steps;
    assistantMock.agentPlan.store.activeRunId = activeRun.id;
    assistantMock.agentPlan.store.activeRun = activeRun;
    assistantMock.agentPlan.store.activeToolActivity = {
      id: 'activity-read-file',
      stepId: 'plan-step-1',
      toolName: 'read_file',
      state: 'running',
      label: '正在读取 AiAssistantPanel.vue…',
      startedAt: '2026-04-29T10:00:01.000Z',
    };
    assistantMock.agentPlan.store.getToolActivities = vi.fn((): IAiToolActivityInline[] => [
      assistantMock.agentPlan.store.activeToolActivity as IAiToolActivityInline,
    ]);
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mountPanel(assistantMock);

    expect(wrapper.find('[data-testid="chat-thread"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="plan-confirmation"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('AI 正在自动使用工具');
    expect(wrapper.find('[data-testid="run-status-bar"]').exists()).toBe(true);
  });

  it('keeps plan execution token accounting in the token context only', () => {
    const assistantMock = createAssistantMock([createMessage('message-user', 'user', '执行计划')]);
    const steps = [createPlanStep('plan-step-1', '读取源码', 'running')];
    const activeRun = createAgentRun(steps, 'plan-step-1');
    assistantMock.activeMode.value = 'plan';
    assistantMock.agentPlan.store.activeGoal = '执行计划';
    assistantMock.agentPlan.store.steps = steps;
    assistantMock.agentPlan.store.activeRun = activeRun;
    assistantMock.agentPlan.store.getToolActivities = vi.fn((): IAiToolActivityInline[] => [
      {
        id: 'activity-read-file',
        stepId: 'plan-step-1',
        toolName: 'read_file',
        state: 'running',
        label: '正在读取 AiAssistantPanel.vue…',
        startedAt: '2026-04-29T10:00:01.000Z',
      },
    ]);
    useAiAssistantMock.mockReturnValue(assistantMock);

    mountPanel(assistantMock);

    expect(latestTokenContextArgs).not.toBeNull();
    expect(latestTokenContextArgs?.messages.value).toHaveLength(1);
    expect(latestTokenContextArgs?.messages.value[0]?.content).toContain(
      '正在读取 AiAssistantPanel.vue',
    );
  });

  it('keeps the same unified thread surface when switching from Agent to Plan', async () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '换个模式继续'),
    ]);
    assistantMock.activeMode.value = 'agent';
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mountPanel(assistantMock);

    expect(wrapper.find('[data-testid="chat-thread"]').exists()).toBe(true);

    await wrapper.get('[data-testid="switch-plan"]').trigger('click');

    expect(assistantMock.activeMode.value).toBe('plan');
    expect(wrapper.find('[data-testid="chat-thread"]').exists()).toBe(true);
  });

  it('renders the shared suggestion pool and sends the picked suggestion', async () => {
    const assistantMock = createAssistantMock([]);
    assistantMock.activeMode.value = 'agent';
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mountPanel(assistantMock);

    expect(wrapper.find('[data-testid="suggestion-empty"]').exists()).toBe(true);

    await wrapper.get('[data-testid="suggestion-chip"]').trigger('click');

    expect(assistantMock.draft.value).toBe('讲一个科学小知识');
    expect(assistantMock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('prefers ACP usage_update over plan-store usage for the token context (chat mode)', () => {
    const assistantMock = createAssistantMock([createMessage('message-user', 'user', 'hi')]);
    assistantMock.activeMode.value = 'chat';
    assistantMock.acpUsage.usage.value = {
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
    };
    useAiAssistantMock.mockReturnValue(assistantMock);

    mountPanel(assistantMock);

    expect(latestTokenContextArgs?.officialUsage?.value).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
    });
  });

  it('exposes no official usage when neither ACP nor plan usage is present (chat mode)', () => {
    const assistantMock = createAssistantMock([createMessage('message-user', 'user', 'hi')]);
    assistantMock.activeMode.value = 'chat';
    useAiAssistantMock.mockReturnValue(assistantMock);

    mountPanel(assistantMock);

    expect(latestTokenContextArgs?.officialUsage?.value ?? null).toBeNull();
  });

  it('routes a session config option change from the prompt input to the assistant', async () => {
    const assistantMock = createAssistantMock([createMessage('message-user', 'user', '切换模型')]);
    assistantMock.activeMode.value = 'agent';
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mountPanel(assistantMock);

    await wrapper.get('[data-testid="switch-config-option"]').trigger('click');

    expect(assistantMock.acpSessionConfigOptions.selectConfigOption).toHaveBeenCalledWith(
      'thread-active',
      'model',
      'kimi-k2',
    );
  });

  it('renders the ACP tool-permission approval prompt when one is pending', () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '改这个文件'),
    ]);
    useAiAssistantMock.mockReturnValue(assistantMock);
    useAcpApprovalMock.mockReturnValue(createAcpApprovalMock(createAcpApprovalCurrent()));

    const wrapper = mountPanel(assistantMock);

    expect(wrapper.find('[data-testid="acp-approval"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="acp-approval-title"]').text()).toContain(
      '是否允许写入 src/app.ts？',
    );
  });

  it('routes an ACP approval decision back to the approval queue verbatim', async () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '改这个文件'),
    ]);
    useAiAssistantMock.mockReturnValue(assistantMock);
    const acpApprovalMock = createAcpApprovalMock(createAcpApprovalCurrent());
    useAcpApprovalMock.mockReturnValue(acpApprovalMock);

    const wrapper = mountPanel(assistantMock);

    await wrapper.get('[data-testid="acp-approval-allow"]').trigger('click');

    expect(acpApprovalMock.resolve).toHaveBeenCalledWith('tool-call-1', 'allow-once-id');
  });

  it('cancelling an ACP approval dismisses it and stops the current run', async () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '改这个文件'),
    ]);
    useAiAssistantMock.mockReturnValue(assistantMock);
    const acpApprovalMock = createAcpApprovalMock(createAcpApprovalCurrent());
    useAcpApprovalMock.mockReturnValue(acpApprovalMock);

    const wrapper = mountPanel(assistantMock);

    await wrapper.get('[data-testid="acp-approval-cancel"]').trigger('click');

    expect(acpApprovalMock.dismiss).toHaveBeenCalledWith('tool-call-1');
    expect(assistantMock.stopCurrentRequest).toHaveBeenCalledTimes(1);
  });
});

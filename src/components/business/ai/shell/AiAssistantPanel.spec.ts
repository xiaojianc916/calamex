import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, ref } from 'vue';
import AiAssistantPanel from '@/components/business/ai/shell/AiAssistantPanel.vue';
import { createDefaultAiModelEndpointConfig } from '@/services/ipc/ai-config.service';
import type {
  IAiAgentPlanMetadata,
  IAiAgentRun,
  IAiAgentStepFinalAnswer,
  IAiChatMessage,
  IAiConfigPayload,
  IAiContextReference,
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

const useFrontendToolMock = vi.hoisted(() => vi.fn());
const useAiAssistantMock = vi.hoisted(() => vi.fn());
const useAiAgentRunMock = vi.hoisted(() => vi.fn());
const useAiAgentNetworkMock = vi.hoisted(() => vi.fn());
const useAiWebSourcesMock = vi.hoisted(() => vi.fn());
const useAiTokenContextMock = vi.hoisted(() => vi.fn());
const useCopilotSuggestionsMock = vi.hoisted(() => vi.fn());
const useCopilotContextMock = vi.hoisted(() => vi.fn());

vi.mock('@copilotkit/vue', () => ({
  useFrontendTool: useFrontendToolMock,
}));

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

vi.mock('@/composables/ai/useCopilotContext', () => ({
  useCopilotContext: useCopilotContextMock,
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

const mountPanel = (assistantMock: ReturnType<typeof createAssistantMock>) =>
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
        AiChatThread: defineComponent({
          props: ['messages', 'isTyping', 'typingLabel', 'hasExtraContent'],
          template:
            '<section data-testid="chat-thread"><slot name="empty" /><article v-for="message in messages" :key="message.id" :data-role="message.role" v-text="message.content" /><slot name="after-messages" /></section>',
        }),
        AiAgentModePanel: defineComponent({
          props: ['messages', 'toolConfirmation', 'errorMessage'],
          emits: ['resolveToolConfirmation'],
          template:
            '<section data-testid="agent-mode-panel"><article v-for="message in messages" :key="message.id" v-text="message.content" /><strong v-if="toolConfirmation" data-testid="agent-tool-confirmation" v-text="toolConfirmation.question" /><p v-if="errorMessage" v-text="errorMessage" /></section>',
        }),
        AiPlanModeThread: defineComponent({
          props: ['goal', 'steps', 'toolConfirmation', 'errorMessage'],
          emits: ['resolveToolConfirmation'],
          template:
            '<section data-testid="plan-mode-thread"><h2 v-text="goal" /><ol><li v-for="step in steps" :key="step.id" v-text="step.title" /></ol><strong v-if="toolConfirmation" data-testid="plan-tool-confirmation" v-text="toolConfirmation.question" /><p v-if="errorMessage" v-text="errorMessage" /></section>',
        }),
        AiPromptInput: defineComponent({
          emits: ['submit', 'update:activeMode'],
          template:
            '<div data-testid="prompt-input"><button data-testid="switch-plan" @click="$emit(\'update:activeMode\', \'plan\')">切到 Plan</button><button data-testid="submit" @click="$emit(\'submit\')">发送</button></div>',
        }),
        AiProviderSettings: defineComponent({ template: '<div />' }),
        AiPlanModePanel: defineComponent({ template: '<div data-testid="composer-plan-panel" />' }),
        AiWebSourcesPanel: defineComponent({ template: '<div />' }),
        AiErrorNotice: defineComponent({ props: ['message'], template: '<p data-testid="error" v-text="message" />' }),
        Checkpoint: defineComponent({ template: '<div><slot /></div>' }),
        CheckpointTrigger: defineComponent({ template: '<button><slot /></button>' }),
        CheckpointIcon: defineComponent({ template: '<span />' }),
        Loader: defineComponent({ template: '<span />' }),
        teleport: true,
      },
    },
  });

describe('AiAssistantPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    latestTokenContextArgs = null;
    useFrontendToolMock.mockReturnValue(undefined);
    useCopilotContextMock.mockReturnValue(undefined);
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
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('keeps ordinary answer rendering as chat-mode only', () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '解释当前文件'),
      createMessage('message-assistant', 'assistant', '这是普通聊天回复'),
    ]);
    assistantMock.activeMode.value = 'chat';
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mountPanel(assistantMock);

    expect(wrapper.find('[data-testid="chat-thread"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="agent-mode-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="plan-mode-thread"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="chat-thread"]').text()).toContain('这是普通聊天回复');
  });

  it('renders Agent mode through its execution panel instead of the chat thread', () => {
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

    expect(wrapper.find('[data-testid="chat-thread"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="agent-mode-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="plan-mode-thread"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="agent-tool-confirmation"]').text()).toContain('允许执行 pnpm test 吗？');
  });

  it('renders Plan mode through the structured plan thread instead of chat messages', () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '重构 AI 模式 UI'),
    ]);
    assistantMock.activeMode.value = 'plan';
    assistantMock.agentPlan.store.hasPlan = true;
    assistantMock.agentPlan.store.activeGoal = '重构 AI 模式 UI';
    assistantMock.agentPlan.store.planStatus = 'pending_approval';
    assistantMock.agentPlan.store.steps = [
      createPlanStep('plan-step-1', '审查模式边界'),
      createPlanStep('plan-step-2', '接线专属面板'),
    ];
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mountPanel(assistantMock);

    expect(wrapper.find('[data-testid="chat-thread"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="agent-mode-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="plan-mode-thread"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="plan-mode-thread"]').text()).toContain('审查模式边界');
    expect(wrapper.find('[data-testid="composer-plan-panel"]').exists()).toBe(false);
  });

  it('does not inject synthetic plan progress messages into rendered chat content', () => {
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

    expect(wrapper.find('[data-testid="chat-thread"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('AI 正在自动使用工具');
    expect(wrapper.get('[data-testid="plan-mode-thread"]').text()).toContain('读取源码');
  });

  it('keeps plan execution token accounting private and uses neutral tool wording', () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '执行计划'),
    ]);
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
    expect(latestTokenContextArgs?.messages.value[0]?.content).toContain('工具活动：');
    expect(latestTokenContextArgs?.messages.value[0]?.content).not.toContain('AI 正在自动使用工具');
  });

  it('switches from Agent to Plan by rendering the plan thread surface', async () => {
    const assistantMock = createAssistantMock([
      createMessage('message-user', 'user', '拆成计划再做'),
    ]);
    assistantMock.activeMode.value = 'agent';
    assistantMock.agentPlan.store.hasPlan = true;
    assistantMock.agentPlan.store.activeGoal = '拆成计划再做';
    assistantMock.agentPlan.store.steps = [createPlanStep('plan-step-1', '展示计划')];
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mountPanel(assistantMock);

    expect(wrapper.find('[data-testid="agent-mode-panel"]').exists()).toBe(true);

    await wrapper.get('[data-testid="switch-plan"]').trigger('click');

    expect(assistantMock.activeMode.value).toBe('plan');
    expect(wrapper.find('[data-testid="agent-mode-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="plan-mode-thread"]').exists()).toBe(true);
  });
});

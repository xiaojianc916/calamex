import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ComputedRef,
  computed,
  defineComponent,
  h,
  type InjectionKey,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
} from 'vue';
import AiAssistantPanel from '@/components/business/ai/shell/AiAssistantPanel.vue';
import { createDefaultAiModelEndpointConfig } from '@/services/ipc/ai-config.service';
import type {
  IAiAgentPlanMetadata,
  IAiAgentRun,
  IAiAgentStepFinalAnswer,
  IAiChatMessage,
  IAiConfigPayload,
  IAiContextReference,
  IAiPatchSet,
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
const useCopilotSuggestionsMock = vi.hoisted(() => vi.fn());
const useCopilotContextMock = vi.hoisted(() => vi.fn());
const useCopilotAgentBridgeMock = vi.hoisted(() => vi.fn());

vi.mock('@/composables/ai/useAiAssistant', () => ({
  useAiAssistant: useAiAssistantMock,
}));

vi.mock('@/composables/ai/useCopilotSuggestions', () => ({
  useCopilotSuggestions: useCopilotSuggestionsMock,
}));

vi.mock('@/composables/ai/useCopilotContext', () => ({
  useCopilotContext: useCopilotContextMock,
}));

vi.mock('@/composables/ai/useCopilotAgentBridge', () => ({
  useCopilotAgentBridge: useCopilotAgentBridgeMock,
}));

interface IAiConversationThreadMock {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: IAiChatMessage[];
}

interface ITestDropdownMenuContext {
  open: ComputedRef<boolean>;
  setOpen(value: boolean): void;
}

const TEST_DROPDOWN_MENU_CONTEXT: InjectionKey<ITestDropdownMenuContext> = Symbol(
  'test-dropdown-menu-context',
);

const TestDropdownMenu = defineComponent({
  name: 'TestDropdownMenu',
  props: {
    open: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:open'],
  setup(props, { emit, slots }) {
    const root = ref<HTMLElement | null>(null);
    const open = computed(() => props.open);
    const setOpen = (value: boolean): void => {
      emit('update:open', value);
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (!props.open) {
        return;
      }

      const targetNode = event.target instanceof Node ? event.target : null;
      if (targetNode && root.value?.contains(targetNode)) {
        return;
      }

      setOpen(false);
    };

    provide(TEST_DROPDOWN_MENU_CONTEXT, { open, setOpen });
    onMounted(() => {
      document.body.addEventListener('pointerdown', handlePointerDown);
    });
    onBeforeUnmount(() => {
      document.body.removeEventListener('pointerdown', handlePointerDown);
    });

    return () => h('div', { ref: root }, slots.default?.());
  },
});

const TestDropdownMenuTrigger = defineComponent({
  name: 'TestDropdownMenuTrigger',
  setup(_props, { slots }) {
    const context = inject(TEST_DROPDOWN_MENU_CONTEXT);

    return () =>
      h(
        'div',
        {
          'data-slot': 'dropdown-menu-trigger',
          onClick: (event: MouseEvent) => {
            event.stopPropagation();
            context?.setOpen(!context.open.value);
          },
        },
        slots.default?.(),
      );
  },
});

const TestDropdownMenuContent = defineComponent({
  name: 'TestDropdownMenuContent',
  inheritAttrs: false,
  setup(_props, { attrs, slots }) {
    const context = inject(TEST_DROPDOWN_MENU_CONTEXT);

    return () => (context?.open.value ? h('section', attrs, slots.default?.()) : null);
  },
});

const historyDropdownStubs = {
  DropdownMenu: TestDropdownMenu,
  DropdownMenuTrigger: TestDropdownMenuTrigger,
  DropdownMenuContent: TestDropdownMenuContent,
};

const createAssistantMock = (
  messagesList: IAiChatMessage[],
  historyThreadsList: IAiConversationThreadMock[] = messagesList.length
    ? [
        {
          id: 'thread-active',
          title: '当前对话',
          createdAt: messagesList[0]?.createdAt ?? '2026-04-28T10:00:00.000Z',
          updatedAt: messagesList.at(-1)?.createdAt ?? '2026-04-28T10:00:00.000Z',
          messages: messagesList,
        },
      ]
    : [],
) => {
  const config = ref<IAiConfigPayload>({
    providerType: 'mastra',
    selectedModel: 'openai/gpt-5.5',
    baseUrl: 'http://127.0.0.1:4000/v1',
    isBaseUrlConfigured: true,
    hasCredentials: false,
    isConfigured: true,
    inlineCompletionEnabled: false,
    chatEnabled: true,
    agentEnabled: false,
    narrator: createDefaultAiModelEndpointConfig('zhipuai/glm-4.7-flash'),
    credentials: [],
  });

  const messages = ref<IAiChatMessage[]>(messagesList);
  const historyThreads = ref<IAiConversationThreadMock[]>(historyThreadsList);
  const activeConversationId = ref<string | null>(historyThreadsList.at(-1)?.id ?? null);
  const activeConversationScrollState = ref(null);
  const activeMode = ref<'chat' | 'agent' | 'plan'>('agent');
  const isSettingsOpen = ref(false);
  const isClearDialogOpen = ref(false);
  const isSending = ref(false);
  const draft = ref('');
  const errorMessage = ref('');
  const currentReferences = ref<IAiContextReference[]>([]);
  const agentSteps = ref<IAiTaskPlanStep[]>([]);
  const attachedFiles = ref(
    [] as Array<{ id: string; name: string; sizeLabel: string; kind: 'text' | 'image' }>,
  );
  const proposedPatch = ref<IAiPatchSet | null>(null);
  const appliedPatchPreview = ref<IAiPatchSet | null>(null);
  const isApplyingPatch = ref(false);
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
  const fileRollbackPrompt = ref<{
    operationId: string;
    fileCount: number;
    status: 'ready' | 'reverting' | 'reverted';
    updatedAt: string;
    restoredFileCount?: number;
  } | null>(null);
  const agentPlanStore = {
    mode: 'chat' as const,
    activeGoal: '',
    steps: [] as IAiTaskPlanStep[],
    classification: null,
    classificationReason: '',
    shouldEnterPlanMode: false,
    isPlanning: false,
    isApproving: false,
    approvedAt: null,
    errorMessage: '',
    hasPlan: false,
    planId: null as string | null,
    planVersion: null as number | null,
    planStatus: null as IAiAgentPlanMetadata['status'] | null,
    isClassifying: false,
    activeRunId: null as string | null,
    activeRun: null as IAiAgentRun | null,
    stepDetails: {},
    stepFinalAnswers: {},
    patchSummaries: {},
    toolActivities: {},
    pendingToolConfirmation: null as IAiToolConfirmationRequest | null,
    activeToolActivity: null as IAiToolActivityInline | null,
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
    agentSteps,
    attachedFiles,
    proposedPatch,
    appliedPatchPreview,
    isApplyingPatch,
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
      approvePlan: vi.fn(),
      resetPlan: vi.fn(),
      restorePersistedPlanState: vi.fn().mockResolvedValue(undefined),
    },
    canPreviewPatch: computed(() => false),
    sendButtonLabel: computed(() => '发送'),
    loadConfig: vi.fn().mockResolvedValue(undefined),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    saveCredentials: vi.fn().mockResolvedValue(undefined),
    testProviderConfig: vi.fn().mockResolvedValue('ok'),
    connectProvider: vi.fn().mockResolvedValue('ok'),
    testProvider: vi.fn().mockResolvedValue('ok'),
    previewPatchFromLastAnswer: vi.fn(),
    applyProposedPatch: vi.fn(),
    rollbackLatestFileChange: vi.fn(),
    rollbackChangedFilesSummary: vi.fn(),
    setChangedFilesSummaryPin: vi.fn(),
    restoreConversationCheckpoint: vi.fn().mockResolvedValue(undefined),
    resolveSidecarToolConfirmation: vi.fn(),
    sendMessage: vi.fn(),
    handleMessageAction: vi.fn(),
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

const createMessage = (index: number): IAiChatMessage => ({
  id: `message-${index}`,
  role: index % 2 === 0 ? 'assistant' : 'user',
  content: `第 ${index} 条对话内容\n这是完整内容 ${index}`,
  createdAt: new Date(Date.UTC(2026, 3, 28, 10, index % 60, 0)).toISOString(),
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
  id: 'agent-run-complex-1',
  goal: '把 run timeline 改成对话流里的实时活动，修复计划折叠按钮，并补全过程测试',
  status: currentStepId ? 'running-step' : 'completed',
  steps,
  currentStepId,
  createdAt: '2026-04-29T10:00:00.000Z',
  updatedAt: '2026-04-29T10:00:03.000Z',
  startedAt: '2026-04-29T10:00:00.000Z',
  completedAt: currentStepId ? null : '2026-04-29T10:00:03.000Z',
  errorMessage: null,
});

const createThread = (index: number): IAiConversationThreadMock => {
  const message = createMessage(index);
  return {
    id: `thread-${index}`,
    title: `第 ${index} 组对话`,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    messages: [message],
  };
};

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

describe('AiAssistantPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useCopilotSuggestionsMock.mockReturnValue({
      suggestions: ref(['讲一个科学小知识']),
      rotateBatch: vi.fn(),
    });
    useCopilotContextMock.mockReturnValue(undefined);
    useCopilotAgentBridgeMock.mockReturnValue({
      messages: ref([]),
      isRunning: ref(false),
      errorMessage: ref(''),
      sendMessage: vi.fn(),
      stop: vi.fn(),
      clearMessages: vi.fn(),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('顶部保留 AI 图标和模型名称，但不再渲染 Chat Agent Plan 模式选择入口', () => {
    const assistantMock = createAssistantMock([]);
    assistantMock.config.value.selectedModel = 'deepseek/deepseek-v4-pro';
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: {
            template: '<div data-testid="chat-thread"><slot name="after-messages" /></div>',
          },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div />' },
          teleport: true,
        },
      },
    });

    const providerMark = wrapper.get('.ai-provider-mark');

    expect(providerMark.find('.ai-provider-icon').exists()).toBe(true);
    expect(providerMark.text()).toContain('deepseek-v4-pro');
    expect(providerMark.attributes('title')).toContain('DeepSeek');
    expect(providerMark.attributes('title')).toContain('deepseek/deepseek-v4-pro');
    expect(wrapper.find('.ai-model-switch').exists()).toBe(false);
    expect(wrapper.find('.ai-model-button').exists()).toBe(false);
    expect(wrapper.find('.ai-mode-menu').exists()).toBe(false);
    expect(wrapper.findAll('.ai-panel-frame__actions .ai-icon-button')).toHaveLength(3);
  });

  it('点击空态提示词会直接发送给 AI', async () => {
    const assistantMock = createAssistantMock([]);
    useAiAssistantMock.mockReturnValue(assistantMock);
    useCopilotSuggestionsMock.mockReturnValue({
      suggestions: ref([{ title: '讲一个科学小知识', message: '讲一个科学小知识' }]),
      rotateBatch: vi.fn(),
    });

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: { template: '<section><slot name="empty" /></section>' },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div />' },
          AiWebSourcesPanel: { template: '<div />' },
          AiToolConfirmationCard: { template: '<div />' },
          teleport: true,
        },
      },
    });

    await wrapper.get('.ai-suggestion-chip').trigger('click');

    expect(assistantMock.draft.value).toBe('讲一个科学小知识');
    expect(assistantMock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('在带 checkpoint 的消息后渲染恢复入口并触发 restore', async () => {
    const messages = [createMessage(1), createMessage(2), createMessage(3)];
    const assistantMock = createAssistantMock(messages);
    assistantMock.conversationCheckpoints.value = [
      {
        id: 'checkpoint-1',
        messageId: 'message-2',
        runId: 'run-1',
        snapshotId: 'snapshot-1',
        sessionId: 'session-1',
        createdAt: '2026-04-28T10:02:00.000Z',
      },
    ];
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: {
            props: ['messages'],
            template: `
                          <div class="thread-stub">
                            <div v-for="message in messages" :key="message.id" class="thread-stub__message">
                              <slot name="after-message" :message="message" />
                            </div>
                          </div>
                        `,
          },
          Checkpoint: { template: '<div class="checkpoint-stub"><slot /></div>' },
          CheckpointTrigger: {
            props: ['disabled', 'tooltip'],
            emits: ['click'],
            template: `<button class="checkpoint-trigger-stub" :disabled="disabled" :title="tooltip" @click="$emit('click')"><slot /></button>`,
          },
          CheckpointIcon: { template: '<span class="checkpoint-icon-stub" />' },
          Loader: { template: '<span class="loader-stub" />' },
          AiPatchPreview: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div />' },
          AiWebSourcesPanel: { template: '<div />' },
          AiToolConfirmationCard: { template: '<div />' },
          teleport: true,
        },
      },
    });

    expect(wrapper.find('.checkpoint-trigger-stub').text()).toContain('恢复到');

    await wrapper.find('.checkpoint-trigger-stub').trigger('click');

    expect(assistantMock.restoreConversationCheckpoint).toHaveBeenCalledWith('checkpoint-1');
  });

  it('将预览 Patch 入口放在预览面板下方并保留点击动作', async () => {
    const assistantMock = createAssistantMock([]);
    assistantMock.canPreviewPatch = computed(() => true);
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: {
            template: '<div data-testid="chat-thread"><slot name="after-messages" /></div>',
          },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div class="patch-preview-stub" />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div />' },
          teleport: true,
        },
      },
    });

    const html = wrapper.html();
    expect(html.indexOf('patch-preview-stub')).toBeLessThan(html.indexOf('ai-patch-entry__button'));

    const trigger = wrapper.get('.ai-patch-entry__button');
    expect(trigger.text()).toContain('预览为 Patch');
    expect(trigger.find('svg').exists()).toBe(true);

    await trigger.trigger('click');

    expect(assistantMock.previewPatchFromLastAnswer).toHaveBeenCalledTimes(1);
  });

  it('AI 修改文件后在对话框下方显示低调回滚入口', async () => {
    const assistantMock = createAssistantMock([]);
    assistantMock.fileRollbackPrompt.value = {
      operationId: 'operation-rollback-1',
      fileCount: 2,
      status: 'ready',
      updatedAt: '2026-04-29T00:00:00.000Z',
    };
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: {
            template:
              '<div data-testid="chat-thread"><slot name="before-messages" /><slot /></div>',
          },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div class="patch-preview-stub" />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div />' },
          teleport: true,
        },
      },
    });

    const html = wrapper.html();
    const rollbackButton = wrapper.get('.ai-file-rollback-entry__button');

    expect(html.indexOf('chat-thread')).toBeLessThan(
      html.indexOf('ai-file-rollback-entry__button'),
    );
    expect(html.indexOf('ai-file-rollback-entry__button')).toBeLessThan(
      html.indexOf('patch-preview-stub'),
    );
    expect(rollbackButton.text()).toContain('AI 已修改文件，可回滚最近一次');
    expect(rollbackButton.find('svg').exists()).toBe(true);

    await rollbackButton.trigger('click');

    expect(assistantMock.rollbackLatestFileChange).toHaveBeenCalledTimes(1);
  });

  it('不再把 Agent 事件时间线作为消息外的独立区域渲染', () => {
    const assistantMock = createAssistantMock([]);
    assistantMock.runtimeTimelineEvents.value = [
      {
        id: 'runtime-started',
        type: 'agent.run.started',
        runId: 'run-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        timestamp: '2026-05-02T10:00:00.000Z',
        seq: 0,
        schemaVersion: 1,
        redacted: true,
        visibility: 'user',
        level: 'info',
        inputPreview: '检查并修改当前文件',
      },
      {
        id: 'runtime-tool-completed',
        type: 'agent.tool.completed',
        runId: 'run-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        timestamp: '2026-05-02T10:00:01.000Z',
        seq: 1,
        schemaVersion: 1,
        redacted: true,
        visibility: 'user',
        level: 'info',
        toolName: 'edit_file',
        ok: true,
        resultPreview: '已更新 src/app.ts',
      },
      {
        id: 'runtime-completed',
        type: 'agent.run.completed',
        runId: 'run-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        timestamp: '2026-05-02T10:00:02.000Z',
        seq: 2,
        schemaVersion: 1,
        redacted: true,
        visibility: 'user',
        level: 'info',
        stopReason: 'end_turn',
      },
    ];
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: {
            template:
              '<div data-testid="chat-thread"><slot name="before-messages" /><slot /></div>',
          },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div class="patch-preview-stub" />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div />' },
          teleport: true,
        },
      },
    });

    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(false);
  });

  it('在 plan mode 有待确认计划时把确认卡渲染到对话流里', () => {
    const assistantMock = createAssistantMock([]);
    assistantMock.activeMode.value = 'plan';
    assistantMock.agentPlan.store.hasPlan = true;
    assistantMock.agentPlan.store.activeGoal = '补齐计划模式 UI 接线';
    assistantMock.agentPlan.store.steps = [
      {
        id: 'plan-step-1',
        index: 0,
        title: '收集上下文',
        goal: '收集上下文',
        kind: 'inspect',
        status: 'pending',
        expectedOutput: '影响范围',
        tools: ['search_text'],
        requiresUserApproval: false,
        riskLevel: 'low',
      },
      {
        id: 'plan-step-2',
        index: 1,
        title: '输出计划',
        goal: '输出计划',
        kind: 'summarize',
        status: 'pending',
        expectedOutput: '可执行计划',
        tools: ['get_diagnostics'],
        requiresUserApproval: true,
        riskLevel: 'medium',
      },
    ];
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: {
            template: '<div data-testid="chat-thread"><slot name="after-messages" /></div>',
          },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div data-testid="plan-mode-panel" />' },
          AiPlanConfirmationMessage: {
            template: '<div data-testid="plan-confirmation-message" />',
          },
          teleport: true,
        },
      },
    });

    expect(wrapper.find('[data-testid="plan-mode-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="plan-confirmation-message"]').exists()).toBe(true);
  });

  it('生成计划时把对话等待态文案切换为正在生成计划', () => {
    const assistantMock = createAssistantMock([createMessage(1)]);
    assistantMock.activeMode.value = 'plan';
    assistantMock.isSending.value = true;
    assistantMock.agentPlan.store.isPlanning = true;
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: {
            props: ['typingLabel'],
            template: '<div class="chat-thread-stub" v-text="typingLabel"></div>',
          },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div />' },
          AiWebSourcesPanel: { template: '<div />' },
          AiToolConfirmationCard: { template: '<div />' },
          teleport: true,
        },
      },
    });

    expect(wrapper.get('.chat-thread-stub').text()).toBe('正在生成计划');
  });

  it('刷新恢复时只要有持久化 planId 就回到计划模式并回查计划记录', async () => {
    const assistantMock = createAssistantMock([]);
    assistantMock.activeMode.value = 'agent';
    Reflect.set(assistantMock.agentPlan.store, 'mode', 'plan');
    assistantMock.agentPlan.store.planId = 'plan-persisted-1';
    assistantMock.agentPlan.store.planVersion = 1;
    assistantMock.agentPlan.store.planStatus = 'pending_approval';
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: { template: '<div />' },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div data-testid="plan-mode-panel" />' },
          AiWebSourcesPanel: { template: '<div />' },
          AiToolConfirmationCard: { template: '<div />' },
          teleport: true,
        },
      },
    });

    await nextTick();

    expect(assistantMock.activeMode.value).toBe('plan');
    expect(wrapper.find('[data-testid="plan-mode-panel"]').exists()).toBe(false);
    expect(assistantMock.agentPlan.restorePersistedPlanState).toHaveBeenCalledTimes(1);
  });

  it('does not show the plan panel in agent mode even when stale plan state exists', () => {
    const assistantMock = createAssistantMock([]);
    assistantMock.activeMode.value = 'agent';
    assistantMock.agentPlan.store.hasPlan = true;
    assistantMock.agentPlan.store.steps = [createPlanStep('plan-step-1', 'stale plan')];
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: { template: '<div />' },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div data-testid="plan-mode-panel" />' },
          teleport: true,
        },
      },
    });

    expect(wrapper.find('[data-testid="plan-mode-panel"]').exists()).toBe(false);
  });

  it('wires prompt mode updates into the plan confirmation message state', async () => {
    const assistantMock = createAssistantMock([]);
    assistantMock.activeMode.value = 'agent';
    assistantMock.agentPlan.store.hasPlan = true;
    assistantMock.agentPlan.store.activeGoal = '切到 plan 后显示真实计划面板';
    assistantMock.agentPlan.store.steps = [createPlanStep('plan-step-1', '展示计划')];
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: {
            template: '<div data-testid="chat-thread"><slot name="after-messages" /></div>',
          },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPromptInput: {
            emits: ['update:activeMode'],
            template: `<button data-testid="switch-plan" @click="$emit('update:activeMode', 'plan')">切到 Plan</button>`,
          },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div data-testid="plan-mode-panel" />' },
          AiPlanConfirmationMessage: {
            template: '<div data-testid="plan-confirmation-message" />',
          },
          teleport: true,
        },
      },
    });

    expect(wrapper.find('[data-testid="plan-mode-panel"]').exists()).toBe(false);

    await wrapper.get('[data-testid="switch-plan"]').trigger('click');
    await nextTick();

    expect(assistantMock.activeMode.value).toBe('plan');
    expect(wrapper.find('[data-testid="plan-mode-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="plan-confirmation-message"]').exists()).toBe(true);
  });

  it('简单工具确认不再冒充计划面板', () => {
    const assistantMock = createAssistantMock([]);
    assistantMock.activeMode.value = 'agent';
    assistantMock.agentPlan.store.pendingToolConfirmation = {
      id: 'call-run-command',
      runId: 'agent-tool-loop-test',
      stepId: 'call-run-command',
      toolName: 'run_command',
      question: '允许 Agent 执行 pnpm test 吗？',
      summary: '运行最小验证命令。',
      riskLevel: 'medium',
      impact: '会在当前工作区执行测试命令。',
      reversible: false,
      createdAt: '2026-04-29T00:00:00.000Z',
      options: [
        { id: 'allow-once', label: '允许', tone: 'primary' },
        { id: 'stop', label: '拒绝', tone: 'danger' },
      ],
    };
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: {
            template: '<div data-testid="chat-thread"><slot name="after-messages" /></div>',
          },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div data-testid="plan-mode-panel" />' },
          teleport: true,
        },
      },
    });

    expect(wrapper.find('[data-testid="plan-mode-panel"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('允许 Agent 执行 pnpm test 吗？');
    expect(wrapper.text()).toContain('允许');
    expect(wrapper.text()).toContain('拒绝');
    expect(wrapper.text()).not.toContain('跳过');
  });

  it('简单任务的工具活动只留在对话流，不触发计划框', () => {
    const assistantMock = createAssistantMock([
      {
        id: 'message-user-simple',
        role: 'user',
        content: '解释当前脚本',
        createdAt: '2026-04-29T10:00:00.000Z',
        references: [],
      },
    ]);
    assistantMock.activeMode.value = 'agent';
    assistantMock.agentPlan.store.classificationReason = '任务可在单轮内完成，可直接执行。';
    assistantMock.agentPlan.store.activeToolActivity = {
      id: 'activity-read-file',
      stepId: 'tool-call-step:read_file:call-read',
      toolName: 'read_file',
      state: 'running',
      label: '正在读取 test.sh…',
      startedAt: '2026-04-29T10:00:01.000Z',
    };
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: {
            props: ['messages'],
            template: `
                            <section data-testid="chat-thread">
                                <p v-for="message in messages" :key="message.id" v-text="message.content"></p>
                            </section>
                        `,
          },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div data-testid="plan-mode-panel" />' },
          teleport: true,
        },
      },
    });

    expect(wrapper.find('[data-testid="plan-mode-panel"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="chat-thread"]').text()).toContain('解释当前脚本');
  });

  it('把复杂任务全过程显示在对话流里，包含用户提问、运行活动和 AI 最终回答', () => {
    const userQuestion = '把 run timeline 改成对话流里的实时活动，修复计划折叠按钮，并补全过程测试';
    const finalAnswer = '已修复：运行活动进入对话流，计划按钮可收起，并补齐全过程测试。';
    const assistantMock = createAssistantMock([
      {
        id: 'message-user-complex',
        role: 'user',
        content: userQuestion,
        createdAt: '2026-04-29T10:00:00.000Z',
        references: [],
      },
    ]);
    const steps = [
      createPlanStep('plan-step-1', '定位对话流运行反馈', 'done'),
      createPlanStep('plan-step-2', '修复计划折叠交互', 'done'),
      createPlanStep('plan-step-3', '执行全过程测试', 'done'),
    ];
    const activeRun = createAgentRun(steps, null);

    assistantMock.activeMode.value = 'plan';
    assistantMock.agentPlan.store.hasPlan = true;
    assistantMock.agentPlan.store.activeGoal = userQuestion;
    assistantMock.agentPlan.store.steps = steps;
    assistantMock.agentPlan.store.activeRunId = activeRun.id;
    assistantMock.agentPlan.store.activeRun = activeRun;
    assistantMock.agentPlan.store.getToolActivities = vi.fn((): IAiToolActivityInline[] => [
      {
        id: 'activity-read-file',
        stepId: 'plan-step-2',
        toolName: 'read_file',
        state: 'running',
        label: '正在读取 AiAssistantPanel.vue…',
        startedAt: '2026-04-29T10:00:01.000Z',
      },
      {
        id: 'activity-run-test',
        stepId: 'plan-step-3',
        toolName: 'run_test',
        state: 'succeeded',
        label: '已运行全过程测试',
        startedAt: '2026-04-29T10:00:02.000Z',
      },
    ]);
    assistantMock.agentPlan.store.getStepFinalAnswers = vi.fn((): IAiAgentStepFinalAnswer[] => [
      {
        id: 'final-answer-1',
        runId: activeRun.id,
        stepId: 'plan-step-3',
        content: finalAnswer,
        createdAt: '2026-04-29T10:00:03.000Z',
      },
    ]);
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: {
            props: ['messages'],
            template: `
                            <section data-testid="chat-thread">
                                <article
                                    v-for="message in messages"
                                    :key="message.id"
                                    :data-role="message.role"
                                >
                                    <p v-text="message.content"></p>
                                    <ol v-if="message.toolCalls?.length">
                                        <li
                                            v-for="toolCall in message.toolCalls"
                                            :key="toolCall.id"
                                            v-text="toolCall.name + ':' + toolCall.status + ':' + toolCall.summary"
                                        ></li>
                                    </ol>
                                </article>
                            </section>
                        `,
          },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div data-testid="plan-mode-panel" />' },
          teleport: true,
        },
      },
    });

    const chatThread = wrapper.get('[data-testid="chat-thread"]');

    expect(chatThread.text()).toContain(userQuestion);
    expect(chatThread.text()).toContain('read_file:running');
    expect(chatThread.text()).toContain('run_test:succeeded');
    expect(chatThread.text()).toContain(finalAnswer);
    expect(wrapper.find('[data-testid="agent-run-timeline"]').exists()).toBe(false);
  });

  it('恢复到暂停态时不把刷新前的工具活动继续显示成运行中', () => {
    const userQuestion = '切换界面后继续执行计划';
    const assistantMock = createAssistantMock([
      {
        id: 'message-user-paused',
        role: 'user',
        content: userQuestion,
        createdAt: '2026-04-29T10:00:00.000Z',
        references: [],
      },
    ]);
    const steps = [
      createPlanStep('plan-step-1', '定位持久化链路', 'pending'),
      createPlanStep('plan-step-2', '补齐继续入口', 'pending'),
    ];
    const activeRun: IAiAgentRun = {
      ...createAgentRun(steps, 'plan-step-1'),
      status: 'paused',
      completedAt: null,
    };

    assistantMock.activeMode.value = 'plan';
    assistantMock.agentPlan.store.hasPlan = true;
    assistantMock.agentPlan.store.activeGoal = userQuestion;
    assistantMock.agentPlan.store.steps = steps;
    assistantMock.agentPlan.store.activeRunId = activeRun.id;
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

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: {
            props: ['messages'],
            template: `
                            <section data-testid="chat-thread">
                                <article v-for="message in messages" :key="message.id">
                                    <p v-text="message.content"></p>
                                    <ol v-if="message.toolCalls?.length">
                                        <li v-for="toolCall in message.toolCalls" :key="toolCall.id" v-text="toolCall.name + ':' + toolCall.status + ':' + toolCall.summary"></li>
                                    </ol>
                                </article>
                            </section>
                        `,
          },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiPlanModePanel: { template: '<div data-testid="plan-mode-panel" />' },
          teleport: true,
        },
      },
    });

    const chatThread = wrapper.get('[data-testid="chat-thread"]');

    expect(chatThread.text()).toContain('计划已暂停，点击继续后会从未完成步骤恢复执行。');
    expect(chatThread.text()).not.toContain('AI 正在自动使用工具');
    expect(chatThread.text()).not.toContain('read_file:running');
  });

  it('renders a scrollable history view with the latest 20 conversations', async () => {
    const historyThreads = Array.from({ length: 25 }, (_value, index) => createThread(index + 1));
    useAiAssistantMock.mockReturnValue(
      createAssistantMock(historyThreads.at(-1)?.messages ?? [], historyThreads),
    );

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: { template: '<div />' },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPlanModePanel: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          AiTaskPlan: { template: '<div />' },
          ...historyDropdownStubs,
          teleport: true,
        },
      },
    });

    await wrapper.get('[aria-label="对话记录"]').trigger('click', { button: 0, ctrlKey: false });
    await nextTick();

    expect(wrapper.findAll('.ai-history-item')).toHaveLength(20);
    expect(wrapper.text()).toContain('对话记录');
    expect(wrapper.text()).not.toContain('最近 20 组');
    expect(wrapper.text()).toContain('第 25 组对话');
    expect(wrapper.text()).not.toContain('第 5 组对话');
    expect(wrapper.text()).not.toContain('请帮我分析第 25 个脚本');
    expect(wrapper.find('.ai-history-list').exists()).toBe(true);
  });

  it('starts a new conversation from the header action', async () => {
    const assistantMock = createAssistantMock([]);
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: { template: '<div />' },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPlanModePanel: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          ...historyDropdownStubs,
          teleport: true,
        },
      },
    });

    await wrapper.get('[aria-label="新建对话"]').trigger('click');

    expect(assistantMock.startNewConversation).toHaveBeenCalledTimes(1);
  });

  it('switches to a selected history conversation', async () => {
    const historyThreads = [createThread(1), createThread(2)];
    const assistantMock = createAssistantMock(historyThreads[1]?.messages ?? [], historyThreads);
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: { template: '<div />' },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPlanModePanel: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          ...historyDropdownStubs,
          teleport: true,
        },
      },
    });

    await wrapper.get('[aria-label="对话记录"]').trigger('click', { button: 0, ctrlKey: false });
    await nextTick();

    const historyButtons = wrapper.findAll('.ai-history-button');
    expect(historyButtons).toHaveLength(2);
    expect(historyButtons[0]?.text()).toContain('第 2 组对话');
    expect(historyButtons[1]?.text()).toContain('第 1 组对话');

    await historyButtons[1]?.trigger('click');
    await nextTick();

    expect(assistantMock.switchConversation).toHaveBeenCalledWith('thread-1');
  });

  it('删除历史记录时保留对话记录弹层，并只删除选中的一条', async () => {
    const historyThreads = [createThread(1), createThread(2)];
    const assistantMock = createAssistantMock(historyThreads[1]?.messages ?? [], historyThreads);
    useAiAssistantMock.mockReturnValue(assistantMock);

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: { template: '<div />' },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPlanModePanel: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          ...historyDropdownStubs,
          teleport: true,
        },
      },
    });

    await wrapper.get('[aria-label="对话记录"]').trigger('click', { button: 0, ctrlKey: false });
    await nextTick();

    expect(wrapper.find('.ai-history-popover').exists()).toBe(true);

    await wrapper.findAll('.ai-history-delete-button')[1]?.trigger('click');
    await nextTick();

    expect(assistantMock.switchConversation).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('删除“第 1 组对话”？');
    expect(wrapper.text()).toContain('只会删除这条对话记录（1 条消息）');
    expect(wrapper.find('.ai-history-popover').exists()).toBe(true);

    await wrapper.get('.ai-dialog .ai-button.is-danger').trigger('click');
    await nextTick();

    expect(assistantMock.deleteConversation).toHaveBeenCalledTimes(1);
    expect(assistantMock.deleteConversation).toHaveBeenCalledWith('thread-1');
    expect(wrapper.find('.ai-dialog').exists()).toBe(false);
    expect(wrapper.find('.ai-history-popover').exists()).toBe(true);
  });

  it('点击弹窗外部时自动关闭对话记录', async () => {
    const historyThreads = [createThread(1), createThread(2)];
    useAiAssistantMock.mockReturnValue(
      createAssistantMock(historyThreads[1]?.messages ?? [], historyThreads),
    );

    const wrapper = mount(AiAssistantPanel, {
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
          AiChatThread: { template: '<div />' },
          AiContextChips: { template: '<div />' },
          AiPatchPreview: { template: '<div />' },
          AiPlanModePanel: { template: '<div />' },
          AiPromptInput: { template: '<div />' },
          AiProviderSettings: { template: '<div />' },
          ...historyDropdownStubs,
          teleport: true,
        },
      },
    });

    await wrapper.get('[aria-label="对话记录"]').trigger('click', { button: 0, ctrlKey: false });
    await nextTick();
    expect(wrapper.find('.ai-history-popover').exists()).toBe(true);

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await nextTick();

    expect(wrapper.find('.ai-history-popover').exists()).toBe(false);
  });
});

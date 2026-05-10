import AiProviderSettings from '@/components/business/ai/AiProviderSettings.vue';
import type {
  IAiConfigPayload,
  IAiProviderProfileDetailPayload,
  IAiProviderProfilePayload,
  IAiProviderSettingsActionFeedback,
} from '@/types/ai';
import { createDefaultAiModelEndpointConfig } from '@/utils/ai-config';
import { mount, type DOMWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

const createGlobalMountOptions = () => ({
  global: {
    plugins: [createPinia()],
    stubs: {
      teleport: true,
    },
  },
});

const createConfig = (overrides: Partial<IAiConfigPayload> = {}): IAiConfigPayload => ({
  providerType: 'litellm',
  selectedModel: 'openai/gpt-5.5',
  baseUrl: 'http://127.0.0.1:4000/v1',
  isBaseUrlConfigured: true,
  hasCredentials: true,
  isConfigured: true,
  inlineCompletionEnabled: true,
  chatEnabled: true,
  agentEnabled: false,
  activeProfileId: null,
  narrator: createDefaultAiModelEndpointConfig('zhipu/glm-4-flash'),
  ...overrides,
});

const createProfile = (
  overrides: Partial<IAiProviderProfilePayload> = {},
): IAiProviderProfilePayload => ({
  id: 'profile-main',
  role: 'main',
  name: 'GPT5.5',
  providerType: 'litellm',
  selectedModel: 'openai/gpt-5.5',
  baseUrl: 'http://127.0.0.1:4000/v1',
  inlineCompletionEnabled: false,
  chatEnabled: true,
  agentEnabled: false,
  hasCredentials: true,
  isConnected: false,
  createdAt: '2026-05-03T00:00:00.000Z',
  updatedAt: '2026-05-03T00:00:00.000Z',
  lastUsedAt: null,
  ...overrides,
});

interface IAiProviderSettingsTestProps {
  open: boolean;
  config: IAiConfigPayload;
  draft: IAiConfigPayload;
  apiKey: string;
  profiles: IAiProviderProfilePayload[];
  loadProfileDetail: (profileId: string) => Promise<IAiProviderProfileDetailPayload>;
}

const createSettingsProps = (
  overrides: Partial<IAiProviderSettingsTestProps> = {},
): IAiProviderSettingsTestProps => ({
  open: true,
  config: createConfig(),
  draft: createConfig(),
  apiKey: '',
  profiles: [],
  loadProfileDetail: vi.fn(),
  ...overrides,
});

const findButtonByText = (buttons: DOMWrapper<Element>[], label: string): DOMWrapper<Element> => {
  const button = buttons.find((item) => item.text().includes(label));

  if (!button) {
    throw new Error(`未找到按钮：${label}`);
  }

  return button;
};

const getEmittedEvent = (events: unknown[][] | undefined, index = 0): unknown[] => {
  const event = events?.[index];

  if (!event) {
    throw new Error(`未找到第 ${index + 1} 个事件`);
  }

  return event;
};

describe('AiProviderSettings', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders vendor platforms while keeping the LiteLLM provider underneath', async () => {
    const draft = createConfig();

    const wrapper = mount(AiProviderSettings, {
      props: createSettingsProps({
        draft,
      }),
      ...createGlobalMountOptions(),
    });

    await wrapper.get('[data-provider-id="deepseek"]').trigger('click');

    expect(draft.providerType).toBe('litellm');
    expect(draft.baseUrl).toBe('http://127.0.0.1:4000/v1');
    expect(draft.selectedModel).toBe('deepseek/deepseek-v4-pro');
    expect(wrapper.find('[data-provider-id="litellm"]').exists()).toBe(false);
  });

  it('switches model options by platform without rendering a custom model input', async () => {
    const draft = createConfig();

    const wrapper = mount(AiProviderSettings, {
      props: createSettingsProps({
        draft,
      }),
      ...createGlobalMountOptions(),
    });

    await wrapper.get('[data-provider-id="anthropic"]').trigger('click');

    expect(draft.providerType).toBe('litellm');
    expect(draft.baseUrl).toBe('http://127.0.0.1:4000/v1');
    expect(draft.selectedModel).toBe('anthropic/claude-opus-4-6');
    expect(wrapper.find('.model-alias-input').exists()).toBe(false);

    await wrapper.get('[data-key="model"] .lr-select-trigger').trigger('click');
    expect(wrapper.text()).toContain('Claude Opus 4.7');
    expect(wrapper.text()).toContain('Claude Sonnet 4.6');
    expect(wrapper.find('.lr-option-meta').exists()).toBe(false);

    await wrapper
      .findAll('[role="option"]')
      .find((option) => option.text().includes('Claude Opus 4.7'))
      ?.trigger('click');

    expect(draft.selectedModel).toBe('anthropic/claude-opus-4-7');
  });

  it('renders latest DeepSeek V4 model options and excludes deprecated aliases', async () => {
    const wrapper = mount(AiProviderSettings, {
      props: createSettingsProps(),
      ...createGlobalMountOptions(),
    });

    await wrapper.get('[data-provider-id="deepseek"]').trigger('click');
    await wrapper.get('[data-key="model"] .lr-select-trigger').trigger('click');

    const text = wrapper.text();
    expect(text).toContain('DeepSeek-v4-pro');
    expect(text).toContain('DeepSeek-v4-flash');
    expect(text).not.toContain('deepseek-chat');
    expect(text).not.toContain('deepseek-reasoner');
  });

  it('keeps narrator model config independent from the main model config', async () => {
    const draft = createConfig();

    const wrapper = mount(AiProviderSettings, {
      props: createSettingsProps({
        draft,
      }),
      ...createGlobalMountOptions(),
    });

    const narratorButton = wrapper
      .findAll('.model-role-card')
      .find((button) => button.text().includes('小模型'));

    if (!narratorButton) {
      throw new Error('未找到小模型切换按钮');
    }

    await narratorButton.trigger('click');
    await wrapper.get('input[type="password"]').setValue('sk-narrator-test');
    await wrapper.get('[data-provider-id="deepseek"]').trigger('click');

    expect(draft.selectedModel).toBe('openai/gpt-5.5');
    expect(draft.narrator.selectedModel).toBe('deepseek/deepseek-v4-pro');

    const saveButton = findButtonByText(wrapper.findAll('button'), '开始连接');

    await saveButton.trigger('click');
    const emitted = wrapper.emitted('save');

    expect(getEmittedEvent(emitted)[2]).toBe('narrator');
  });

  it('opens AI configuration records with main profiles selected by default and allows switching to narrator profiles', async () => {
    const wrapper = mount(AiProviderSettings, {
      props: createSettingsProps(),
      ...createGlobalMountOptions(),
    });

    const narratorButton = wrapper
      .findAll('.model-role-card')
      .find((button) => button.text().includes('小模型'));

    if (!narratorButton) {
      throw new Error('未找到小模型切换按钮');
    }

    await narratorButton.trigger('click');
    await wrapper.get('[aria-label="进入配置记录"]').trigger('click');

    expect(wrapper.text()).toContain('AI 配置记录');
    const mainProfileFilter = findButtonByText(wrapper.findAll('button'), '主力模型');
    const narratorProfileFilter = findButtonByText(wrapper.findAll('button'), '小模型');

    expect(mainProfileFilter.classes()).toContain('is-selected');
    expect(narratorProfileFilter.classes()).not.toContain('is-selected');

    await narratorProfileFilter.trigger('click');
    await nextTick();

    expect(findButtonByText(wrapper.findAll('button'), '小模型').classes()).toContain(
      'is-selected',
    );
  });

  it('filters configuration records by role while preserving connection states', async () => {
    const profiles = [
      createProfile({
        id: 'profile-main-connected',
        role: 'main',
        name: '主力 GPT',
        isConnected: true,
        lastUsedAt: '2026-05-03T01:00:00.000Z',
      }),
      createProfile({
        id: 'profile-narrator-ready',
        role: 'narrator',
        name: '旁白 GLM',
        selectedModel: 'zhipu/glm-4-flash',
        hasCredentials: true,
        isConnected: false,
      }),
      createProfile({
        id: 'profile-narrator-missing',
        role: 'narrator',
        name: '缺少 Key 的旁白',
        selectedModel: 'zhipu/glm-4-flash',
        hasCredentials: false,
        isConnected: false,
        updatedAt: '2026-05-02T00:00:00.000Z',
      }),
    ];

    const wrapper = mount(AiProviderSettings, {
      props: createSettingsProps({
        config: createConfig({ activeProfileId: 'profile-main-connected' }),
        profiles,
      }),
      ...createGlobalMountOptions(),
    });

    await wrapper.get('[aria-label="进入配置记录"]').trigger('click');

    expect(wrapper.text()).toContain('主力 GPT');
    expect(wrapper.text()).toContain('已连接');
    expect(wrapper.text()).not.toContain('旁白 GLM');
    expect(wrapper.text()).not.toContain('缺少 Key 的旁白');

    const narratorProfileFilter = findButtonByText(wrapper.findAll('button'), '小模型');
    await narratorProfileFilter.trigger('click');
    await nextTick();

    const text = wrapper.text();
    expect(text).not.toContain('主力 GPT');
    expect(text).toContain('旁白 GLM');
    expect(text).toContain('缺少 Key 的旁白');
    expect(text).toContain('未连接');
    expect(text).toContain('缺少 API Key');
  });

  it('uses isConnected from profile payload when disabling quick switch', async () => {
    const profiles = [
      createProfile({
        id: 'profile-main-connected',
        name: '当前主力',
        isConnected: true,
        lastUsedAt: '2026-05-03T01:00:00.000Z',
      }),
      createProfile({
        id: 'profile-narrator-ready',
        role: 'narrator',
        name: '可切换旁白',
        selectedModel: 'zhipu/glm-4-flash',
        hasCredentials: true,
        isConnected: false,
      }),
    ];

    const wrapper = mount(AiProviderSettings, {
      props: createSettingsProps({
        config: createConfig({ activeProfileId: 'profile-main-connected' }),
        profiles,
      }),
      ...createGlobalMountOptions(),
    });

    await wrapper.get('[aria-label="进入配置记录"]').trigger('click');

    const narratorProfileFilter = findButtonByText(wrapper.findAll('button'), '小模型');
    await narratorProfileFilter.trigger('click');
    await nextTick();

    const cards = wrapper.findAll('.profile-card');
    const narratorCard = cards[0];

    if (!narratorCard) {
      throw new Error('配置记录列表渲染不完整');
    }

    const narratorSwitchButton = narratorCard.findAll('.profile-action-button')[1];

    if (!narratorSwitchButton) {
      throw new Error('配置记录切换按钮渲染不完整');
    }

    expect(narratorSwitchButton.attributes('disabled')).toBeUndefined();

    await narratorSwitchButton.trigger('click');

    expect(wrapper.emitted('switchProfile')![0][0]).toBe('profile-narrator-ready');
  });

  it('renders inline feedback after the parent resolves the emitted callback', async () => {
    const wrapper = mount(AiProviderSettings, {
      props: createSettingsProps(),
      ...createGlobalMountOptions(),
    });

    const testButton = findButtonByText(wrapper.findAll('button'), '测试连接');

    await testButton.trigger('click');

    const emitted = wrapper.emitted('testProvider');
    expect(emitted).toHaveLength(1);
    const testEvent = getEmittedEvent(emitted);

    expect(testEvent[0]).toMatchObject({ providerType: 'litellm' });
    expect(testEvent[1]).toBe('');
    expect(testEvent[2]).toBe('main');
    const feedback = testEvent[3] as IAiProviderSettingsActionFeedback;
    feedback.onSuccess('连接成功，Provider 已响应');
    await nextTick();

    expect(wrapper.text()).toContain('连接成功，Provider 已响应');
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('renders copy button without exposing the API Key visibility toggle', () => {
    const wrapper = mount(AiProviderSettings, {
      props: createSettingsProps({
        apiKey: 'sk-test-secret-value',
      }),
      ...createGlobalMountOptions(),
    });

    expect(wrapper.find('[aria-label="复制"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="显示 / 隐藏"]').exists()).toBe(false);
    expect(wrapper.find('input[type="password"]').exists()).toBe(true);
  });

  it('renders field-level validation instead of emitting when API Key is required', async () => {
    const draft = createConfig({
      hasCredentials: false,
    });
    const wrapper = mount(AiProviderSettings, {
      props: createSettingsProps({
        config: createConfig({
          hasCredentials: false,
        }),
        draft,
        apiKey: '',
      }),
      ...createGlobalMountOptions(),
    });

    const saveButton = findButtonByText(wrapper.findAll('button'), '开始连接');

    await saveButton.trigger('click');
    await nextTick();

    expect(wrapper.emitted('save')).toBeUndefined();
    expect(wrapper.text()).toContain('请输入 API Key。');
  });

  it('keeps the dialog open after testing connection even after the success toast timeout', async () => {
    vi.useFakeTimers();
    const wrapper = mount(AiProviderSettings, {
      props: createSettingsProps(),
      ...createGlobalMountOptions(),
    });

    const testButton = findButtonByText(wrapper.findAll('button'), '测试连接');

    await testButton.trigger('click');

    const feedback = getEmittedEvent(
      wrapper.emitted('testProvider'),
    )[3] as IAiProviderSettingsActionFeedback;
    feedback.onSuccess('连接测试通过');
    await nextTick();
    vi.advanceTimersByTime(2400);
    await nextTick();

    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('only closes after start connection succeeds', async () => {
    vi.useFakeTimers();
    const wrapper = mount(AiProviderSettings, {
      props: createSettingsProps(),
      ...createGlobalMountOptions(),
    });

    const saveButton = findButtonByText(wrapper.findAll('button'), '开始连接');

    await saveButton.trigger('click');
    const feedback = getEmittedEvent(
      wrapper.emitted('save'),
    )[3] as IAiProviderSettingsActionFeedback;

    feedback.onError('连接失败');
    await nextTick();
    vi.advanceTimersByTime(2000);
    await nextTick();
    expect(wrapper.emitted('close')).toBeUndefined();

    await saveButton.trigger('click');
    const successFeedback = getEmittedEvent(
      wrapper.emitted('save'),
      1,
    )[3] as IAiProviderSettingsActionFeedback;
    successFeedback.onSuccess('连接成功');
    await nextTick();
    expect(wrapper.emitted('close')).toBeUndefined();

    vi.advanceTimersByTime(1200);
    await nextTick();
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('clicks the backdrop to close without rendering an explicit close button', async () => {
    const wrapper = mount(AiProviderSettings, {
      props: createSettingsProps(),
      ...createGlobalMountOptions(),
    });

    expect(wrapper.find('.close-btn').exists()).toBe(false);

    await wrapper.get('.modal').trigger('click');
    expect(wrapper.emitted('close')).toBeUndefined();

    await wrapper.get('.modal-shell').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});

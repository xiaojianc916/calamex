import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import AiPromptInput from '@/components/business/ai/chat/AiPromptInput.vue';
import type { IAiTokenContextProps } from '@/composables/ai/useAiTokenContext';
import { createDefaultAiConfigPayload } from '@/services/ipc/ai-config.service';
import type { IAcpSessionConfigOptionsState } from '@/types/ai/sidecar';

interface IAiPromptInputTestAttachment {
  id: string;
  name: string;
  sizeLabel: string;
  kind: 'text' | 'image';
  status?: 'processing' | 'ready' | 'failed';
  errorMessage?: string;
  detailLabel?: string;
  preview?: {
    src: string;
    width: number | null;
    height: number | null;
    mimeType: string;
  };
}

interface IAiPromptInputTestProps {
  modelValue: string;
  disabled: boolean;
  errorMessage: string;
  submitLabel: string;
  activeMode: 'chat' | 'agent' | 'plan';
  attachments: IAiPromptInputTestAttachment[];
  hasAttachments: boolean;
  config: ReturnType<typeof createDefaultAiConfigPayload>;
  networkPermission: 'ask' | 'allowed-this-run' | 'denied';
  executionMode: 'interactive' | 'autonomous';
  tokenContext?: IAiTokenContextProps;
  agentBackend?: 'builtin' | 'kimi';
  sessionConfigOptions?: IAcpSessionConfigOptionsState | null;
  isSessionConfigOptionSwitching?: boolean;
  resolveAttachment: (file: File) => Promise<boolean>;
  'onUpdate:modelValue': (value: string) => void;
}

const mountPromptInput = (overrides: Partial<IAiPromptInputTestProps> = {}) =>
  mount(AiPromptInput, {
    props: {
      modelValue: '',
      disabled: false,
      errorMessage: '',
      submitLabel: '发送',
      activeMode: 'agent',
      attachments: [],
      hasAttachments: false,
      config: createDefaultAiConfigPayload(),
      networkPermission: 'ask',
      executionMode: 'interactive',
      resolveAttachment: () => Promise.resolve(true),
      'onUpdate:modelValue': () => undefined,
      ...overrides,
    },
  });

describe('AiPromptInput', () => {
  it('routes pasted image files to the attachment resolver', async () => {
    const resolveAttachment = vi.fn(() => Promise.resolve(true));
    const wrapper = mountPromptInput({ resolveAttachment });

    const file = new File(['image-bytes'], 'pasted-image.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => file,
          },
        ],
      },
    });

    wrapper.get('[data-slot="ai-prompt-editor"]').element.dispatchEvent(event);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(resolveAttachment).toHaveBeenCalledTimes(1);
    expect(resolveAttachment).toHaveBeenCalledWith(file);
  });

  it('routes chosen files to the attachment resolver', async () => {
    const resolveAttachment = vi.fn(() => Promise.resolve(true));
    const wrapper = mountPromptInput({ resolveAttachment });
    const file = new File(['readme'], 'README.md', { type: 'text/markdown' });
    const fileInput = wrapper.get('input[type="file"]');

    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [file],
    });

    await fileInput.trigger('change');

    expect(resolveAttachment).toHaveBeenCalledTimes(1);
    expect(resolveAttachment).toHaveBeenCalledWith(file);
  });

  it('shows a processing overlay and blocks submit while an attachment is being prepared', async () => {
    const wrapper = mountPromptInput({
      modelValue: '分析这个附件',
      resolveAttachment: () => new Promise<boolean>(() => undefined),
    });
    const file = new File(['image-bytes'], 'pasted-image.png', { type: 'image/png' });
    const fileInput = wrapper.get('input[type="file"]');

    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [file],
    });

    await fileInput.trigger('change');
    await nextTick();

    expect(wrapper.find('.ai-attachment-processing-overlay').exists()).toBe(true);
    expect(wrapper.get('[aria-label="发送"]').attributes('disabled')).toBeDefined();
  });

  it('renders image attachments as thumbnails and hides metadata text', () => {
    const wrapper = mountPromptInput({
      attachments: [
        {
          id: 'image-1',
          name: 'pasted-image.png',
          kind: 'image',
          sizeLabel: '4.5 KB',
          detailLabel: '665 × 329',
          preview: {
            src: 'data:image/png;base64,ZmFrZQ==',
            width: 665,
            height: 329,
            mimeType: 'image/png',
          },
        },
      ],
      hasAttachments: true,
    });

    expect(wrapper.get('.ai-attachments').element.closest('[data-slot="input-group"]')).toBeNull();
    expect(
      wrapper
        .get('.ai-attachments')
        .element.compareDocumentPosition(wrapper.get('.ai-prompt-shell').element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(wrapper.find('.ai-image-attachment-preview-link').exists()).toBe(true);
    expect(wrapper.find('.ai-image-attachment-preview-link img').attributes('src')).toBe(
      'data:image/png;base64,ZmFrZQ==',
    );
    expect(wrapper.text()).not.toContain('665 × 329');
    expect(wrapper.text()).not.toContain('4.5 KB');
  });

  it('hides file size labels for text attachments', () => {
    const wrapper = mountPromptInput({
      attachments: [
        {
          id: 'file-1',
          name: 'README.md',
          kind: 'text',
          sizeLabel: '2.4 KB',
        },
      ],
      hasAttachments: true,
    });

    expect(wrapper.text()).toContain('README.md');
    expect(wrapper.text()).not.toContain('2.4 KB');
  });

  it('keeps a fixed composer height without writing textarea inline height', async () => {
    const wrapper = mountPromptInput({
      modelValue: '初始化内容',
    });

    const editor = wrapper.get('[data-slot="ai-prompt-editor"]');
    const element = editor.element as HTMLElement;

    expect(wrapper.get('.ai-composer-surface').exists()).toBe(true);
    expect(element.style.height).toBe('');

    element.textContent = '第一行\n第二行\n第三行\n第四行';
    await editor.trigger('input');

    expect(element.style.height).toBe('');
  });

  it('renders the rewritten input-group shell with dropdown mode switch', () => {
    const wrapper = mountPromptInput();

    expect(wrapper.find('.ai-prompt-shell').exists()).toBe(true);
    expect(wrapper.find('.ai-attachment-button').exists()).toBe(true);
    expect(wrapper.find('[aria-label="打开 AI 模式设置"]').exists()).toBe(true);
    expect(wrapper.find('[data-slot="input-group"]').exists()).toBe(true);
  });

  it('keeps the input-group mounted with the dropdown mode trigger', () => {
    const wrapper = mountPromptInput();

    expect(wrapper.find('[aria-label="打开 AI 模式设置"]').exists()).toBe(true);
    expect(wrapper.find('[data-slot="input-group"]').exists()).toBe(true);
  });

  it('uses the full DeepSeek model labels on the outer trigger', () => {
    const baseConfig = createDefaultAiConfigPayload();

    const proWrapper = mountPromptInput({
      config: {
        ...baseConfig,
        selectedModel: 'deepseek/deepseek-v4-pro',
      },
    });
    const flashWrapper = mountPromptInput({
      config: {
        ...baseConfig,
        selectedModel: 'deepseek/deepseek-v4-flash',
      },
    });

    expect(proWrapper.get('.ai-model-trigger__label').text()).toBe('DeepSeek V4 Pro');
    expect(flashWrapper.get('.ai-model-trigger__label').text()).toBe('DeepSeek V4 Flash');
  });

  it('renders token usage before the send button', () => {
    const wrapper = mountPromptInput({
      tokenContext: {
        usedTokens: 32000,
        maxOutputTokens: 128000,
        modelId: 'openai:gpt-5',
        usageSource: 'estimated',
        usage: {
          inputTokens: 32000,
          inputTokenDetails: {
            noCacheTokens: 32000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokens: 0,
          outputTokenDetails: {
            textTokens: 0,
            reasoningTokens: 0,
          },
          totalTokens: 32000,
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
      },
    });

    const tokenTrigger = wrapper.get('[aria-label="Token 消耗"]');
    const sendButton = wrapper.get('[aria-label="发送"]');

    expect(tokenTrigger.find('svg').exists()).toBe(true);
    expect(tokenTrigger.text()).toBe('');
    expect(tokenTrigger.element.compareDocumentPosition(sendButton.element)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('does not render token text when max context is unknown', () => {
    const wrapper = mountPromptInput({
      tokenContext: {
        usedTokens: 0,
        maxOutputTokens: 0,
        usageSource: 'estimated',
        usage: {
          inputTokens: 0,
          inputTokenDetails: {
            noCacheTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokens: 0,
          outputTokenDetails: {
            textTokens: 0,
            reasoningTokens: 0,
          },
          totalTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
      },
    });

    const tokenTrigger = wrapper.get('[aria-label="Token 消耗"]');

    expect(tokenTrigger.find('svg').exists()).toBe(true);
    expect(tokenTrigger.text()).toBe('');
  });

  it('renders a session config option selector per option only for the Kimi agent', () => {
    const sessionConfigOptions: IAcpSessionConfigOptionsState = {
      configOptions: [
        {
          id: 'model',
          name: '模型',
          currentValue: 'kimi-k2',
          options: [{ value: 'kimi-k2', name: 'Kimi K2' }],
        },
        {
          id: 'thinking',
          name: '思考强度',
          currentValue: 'low',
          options: [{ value: 'low', name: '低' }],
        },
      ],
    };

    const builtinWrapper = mountPromptInput({ agentBackend: 'builtin', sessionConfigOptions });
    expect(builtinWrapper.findAll('.ai-agent-trigger')).toHaveLength(0);

    const kimiWrapper = mountPromptInput({ sessionConfigOptions });
    expect(kimiWrapper.findAll('.ai-agent-trigger')).toHaveLength(2);
  });
});

import AiPromptInput from '@/components/business/ai/AiPromptInput.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, nextTick } from 'vue';

interface IAiPromptInputTestAttachment {
  id: string;
  name: string;
  sizeLabel: string;
  kind: 'text' | 'image';
  detailLabel?: string;
}

interface IAiPromptInputTestProps {
  modelValue: string;
  disabled: boolean;
  errorMessage: string;
  submitLabel: string;
  activeMode: 'chat' | 'agent' | 'plan';
  providerLabel: string;
  attachments: IAiPromptInputTestAttachment[];
  hasAttachments: boolean;
  'onUpdate:modelValue': (value: string) => void;
}

const mountPromptInput = (overrides: Partial<IAiPromptInputTestProps> = {}) => mount(AiPromptInput, {
  props: {
    modelValue: '',
    disabled: false,
    errorMessage: '',
    submitLabel: '发送',
    activeMode: 'agent',
    providerLabel: 'DeepSeek',
    attachments: [],
    hasAttachments: false,
    'onUpdate:modelValue': () => undefined,
    ...overrides,
  },
  global: {
    stubs: {
      AppDropdownMenu: defineComponent({
        name: 'AppDropdownMenuStub',
        props: {
          items: {
            type: Array,
            default: () => [],
          },
        },
        template: '<div class="app-dropdown-menu-stub"><slot name="trigger" :open="false" /></div>',
      }),
    },
  },
});

describe('AiPromptInput', () => {
  it('emits pasted image files as attachments', async () => {
    const wrapper = mountPromptInput();

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

    wrapper.get('textarea').element.dispatchEvent(event);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(wrapper.emitted('fileSelected')).toHaveLength(1);
    expect(wrapper.emitted('fileSelected')?.[0]?.[0]).toBe(file);
  });

  it('emits fileSelected when choosing a file from attachments shortcut', async () => {
    const wrapper = mountPromptInput();
    const file = new File(['readme'], 'README.md', { type: 'text/markdown' });
    const fileInput = wrapper.get('.ai-file-input');

    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [file],
    });

    await fileInput.trigger('change');

    expect(wrapper.emitted('fileSelected')).toHaveLength(1);
    expect(wrapper.emitted('fileSelected')?.[0]?.[0]).toBe(file);
  });

  it('switches to plan mode from chain of thought shortcut', async () => {
    const wrapper = mountPromptInput({
      activeMode: 'agent',
    });

    await wrapper.get('.ai-tool-button-thought').trigger('click');

    expect(wrapper.emitted('selectMode')).toEqual([['plan']]);
  });

  it('hides image metadata inside attachment chips', () => {
    const wrapper = mountPromptInput({
      attachments: [
        {
          id: 'image-1',
          name: 'pasted-image.png',
          kind: 'image',
          sizeLabel: '4.5 KB',
          detailLabel: '665 × 329',
        },
      ],
      hasAttachments: true,
    });

    expect(wrapper.text()).toContain('pasted-image.png');
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

    const textarea = wrapper.get('textarea');
    const element = textarea.element as HTMLTextAreaElement;

    expect(wrapper.get('.ai-composer-surface').exists()).toBe(true);
    expect(element.style.height).toBe('');

    await textarea.setValue('第一行\n第二行\n第三行\n第四行');

    expect(element.style.height).toBe('');
  });

  it('renders the shortcut controls without old provider description copy', () => {
    const wrapper = mountPromptInput();

    expect(wrapper.text()).toContain('Attachments');
    expect(wrapper.text()).toContain('Chain of Thought');
    expect(wrapper.text()).not.toContain('Auto Apply');
    expect(wrapper.text()).not.toContain('deepseek/deepseek-v4-pro');
    expect(wrapper.text()).not.toContain('直接对话与问答');
    expect(wrapper.text()).not.toContain('执行工具链与改动');
    expect(wrapper.find('.ai-mode-button-icon').exists()).toBe(false);
    expect(wrapper.text()).toContain('Agent');
  });

  it('assigns icons to chat agent plan menu items', () => {
    const wrapper = mountPromptInput();
    const dropdown = wrapper.findComponent({ name: 'AppDropdownMenuStub' });
    const items = dropdown.props('items') as Array<{ key: string; icon?: string }>;

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'chat', icon: 'message' }),
      expect.objectContaining({ key: 'agent', icon: 'sparkles' }),
      expect.objectContaining({ key: 'plan', icon: 'list' }),
    ]));
  });
});

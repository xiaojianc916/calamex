import AiMessageItem from '@/components/business/ai/AiMessageItem.vue';
import type { TAgentRuntimeEvent } from '@/types/agent-sidecar';
import type { IAiChatMessage } from '@/types/ai';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { successMock, errorMock, warningMock, tryWriteClipboardTextMock } = vi.hoisted(() => ({
  successMock: vi.fn(),
  errorMock: vi.fn(),
  warningMock: vi.fn(),
  tryWriteClipboardTextMock: vi.fn(),
}));

vi.mock('@/composables/useMessage', () => ({
  useMessage: () => ({
    success: successMock,
    error: errorMock,
    warning: warningMock,
  }),
}));

vi.mock('@/utils/clipboard', () => ({
  tryWriteClipboardText: tryWriteClipboardTextMock,
}));

const createMessage = (overrides: Partial<IAiChatMessage>): IAiChatMessage => ({
  id: 'assistant-message',
  role: 'assistant',
  content: '',
  createdAt: '2026-04-28T10:00:00.000Z',
  references: [],
  ...overrides,
});

const createRuntimeEvent = (overrides: Partial<TAgentRuntimeEvent>): TAgentRuntimeEvent => ({
  id: overrides.id ?? 'runtime-event-1',
  type: overrides.type ?? 'agent.reasoning.delta',
  runId: overrides.runId ?? 'run-1',
  sessionId: overrides.sessionId ?? 'session-1',
  agentId: overrides.agentId ?? 'agent-1',
  timestamp: overrides.timestamp ?? '2026-05-03T10:00:00.000Z',
  seq: overrides.seq ?? 1,
  schemaVersion: 1,
  redacted: true,
  visibility: overrides.visibility ?? 'user',
  level: overrides.level ?? 'info',
  text: '我先确认真实工具列表。',
  ...(overrides as object),
}) as TAgentRuntimeEvent;

describe('AiMessageItem', () => {
  beforeEach(() => {
    successMock.mockReset();
    errorMock.mockReset();
    warningMock.mockReset();
    tryWriteClipboardTextMock.mockReset();
    tryWriteClipboardTextMock.mockResolvedValue(true);
  });

  it('空的流式助手消息渲染单条加载行', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          stream: {
            status: 'streaming',
            activityText: '今天有什么新闻',
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub" />' },
        },
      },
    });

    expect(wrapper.find('.ai-message-status-line').exists()).toBe(true);
    expect(wrapper.text()).toContain('今天有什么新闻');
    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(false);
    expect(wrapper.find('.ai-message-bubble').exists()).toBe(false);
  });

  it('sidecar 占位流开始时立即显示新 runtime 时间线，不显示加载行', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          stream: {
            status: 'streaming',
            activityText: '',
            runtimeEvents: [],
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub" />' },
        },
      },
    });

    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(true);
    expect(wrapper.find('.ai-message-status-line').exists()).toBe(false);
    expect(wrapper.text()).toContain('正在思考');
  });

  it('runtimeEvents 流式运行时保持同一条消息并实时显示回答气泡', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '好的，我先检查当前 sidecar 状态。',
          stream: {
            status: 'streaming',
            finalAnswerStarted: true,
            runtimeEvents: [
              createRuntimeEvent({
                id: 'reasoning-1',
                text: '我先确认 sidecar 是否还在使用旧进程。',
              }),
            ],
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">好的，我先检查当前 sidecar 状态。</div>' },
        },
      },
    });

    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(true);
    expect(wrapper.find('.ai-message-status-line').exists()).toBe(false);
    expect(wrapper.find('.ai-message-bubble').exists()).toBe(true);
    expect(wrapper.find('.markdown-stub').exists()).toBe(true);
    expect(wrapper.text()).toContain('我先确认 sidecar 是否还在使用旧进程。');
    expect(wrapper.text()).toContain('好的，我先检查当前 sidecar 状态。');
  });

  it('runtimeEvents 流式运行但最终回答未开始时不渲染阶段性气泡', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '让我补充更多欧洲具体国家的矿产数据。',
          stream: {
            status: 'streaming',
            runtimeEvents: [
              createRuntimeEvent({
                id: 'reasoning-1',
                text: '我需要继续搜索更具体的数据。',
              }),
            ],
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">不应出现</div>' },
        },
      },
    });

    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(true);
    expect(wrapper.find('.ai-message-bubble').exists()).toBe(false);
    expect(wrapper.find('.markdown-stub').exists()).toBe(false);
  });

  it('runtime 时间线完成后最终回答紧跟其后', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '这是最终回答。',
          stream: {
            status: 'completed',
            runtimeEvents: [
              createRuntimeEvent({
                id: 'reasoning-1',
                type: 'agent.reasoning.delta',
                text: '我先确认真实工具列表。',
              }),
              createRuntimeEvent({
                id: 'tool-start-1',
                type: 'agent.tool.started',
                toolName: 'grep_search',
                inputPreview: '{"query":"agent-sidecar"}',
              }),
            ],
            finalAnswerStarted: true,
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">这是最终回答。</div>' },
        },
      },
    });

    const runtimeTimeline = wrapper.find('.ai-runtime-timeline');
    const messageBubble = wrapper.find('.ai-message-bubble');

    expect(runtimeTimeline.exists()).toBe(true);
    expect(messageBubble.exists()).toBe(true);
    expect(wrapper.text()).toContain('我先确认真实工具列表。');
    expect(wrapper.text()).toContain('grep_search');
    expect(runtimeTimeline.element.compareDocumentPosition(messageBubble.element) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('不渲染空的非流式助手占位消息', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({}),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub" />' },
        },
      },
    });

    expect(wrapper.find('.ai-message').exists()).toBe(false);
    expect(wrapper.find('.ai-message-status-line').exists()).toBe(false);
    expect(wrapper.find('.ai-message-bubble').exists()).toBe(false);
  });

  it('流式内容到达后复用同一条回答气泡', async () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          stream: {
            status: 'streaming',
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">内容已到达</div>' },
        },
      },
    });

    await wrapper.setProps({
      message: createMessage({
        content: '你好',
        stream: {
          status: 'streaming',
        },
      }),
    });

    expect(wrapper.find('.ai-message-status-line').exists()).toBe(false);
    expect(wrapper.find('.markdown-stub').exists()).toBe(true);
  });

  it('复制按钮会写入当前对话内容并提示成功', async () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '请解释这段脚本',
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">请解释这段脚本</div>' },
        },
      },
    });

    await wrapper.find('.ai-message-copy-button').trigger('click');

    expect(tryWriteClipboardTextMock).toHaveBeenCalledWith('请解释这段脚本');
    expect(wrapper.find('.ai-message-copy-button').classes()).toContain('is-copied');
    expect(successMock).toHaveBeenCalledWith('已复制对话内容');
  });

  it('用户消息的复制按钮保留 hover 显示模式', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          id: 'user-message',
          role: 'user',
          content: '把这段命令复制给我',
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">把这段命令复制给我</div>' },
        },
      },
    });

    const toolbar = wrapper.find('.ai-message-toolbar');

    expect(toolbar.exists()).toBe(true);
    expect(toolbar.classes()).toContain('is-copy-mode-hover');
  });

  it('AI 回复流式进行中不会显示复制按钮', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '这是还没结束的回复',
          stream: {
            status: 'streaming',
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">这是还没结束的回复</div>' },
        },
      },
    });

    expect(wrapper.find('.ai-message-copy-button').exists()).toBe(false);
  });

  it('AI 回复完成后直接显示复制按钮', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '这是已经完成的回复',
          stream: {
            status: 'completed',
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">这是已经完成的回复</div>' },
        },
      },
    });

    const toolbar = wrapper.find('.ai-message-toolbar');

    expect(toolbar.exists()).toBe(true);
    expect(toolbar.classes()).toContain('is-copy-mode-ready');
    expect(wrapper.find('.ai-message-copy-button').exists()).toBe(true);
  });

  it('AI 回复被取消后也会显示复制按钮', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '这是被取消前已经生成的内容',
          stream: {
            status: 'cancelled',
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">这是被取消前已经生成的内容</div>' },
        },
      },
    });

    const toolbar = wrapper.find('.ai-message-toolbar');

    expect(toolbar.exists()).toBe(true);
    expect(toolbar.classes()).toContain('is-copy-mode-ready');
    expect(wrapper.find('.ai-message-copy-button').exists()).toBe(true);
  });

  it('助手消息不再渲染聊天区头像，并以内联内容形式平铺展示', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '直接把回答铺在对话界面里。',
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">直接把回答铺在对话界面里。</div>' },
        },
      },
    });

    expect(wrapper.find('.ai-logo').exists()).toBe(false);
    expect(wrapper.find('.ai-message-bubble').classes()).toContain('is-assistant-flat');
    expect(wrapper.find('.markdown-stub').exists()).toBe(true);
  });

  it('点击消息选项时向上抛出动作事件', async () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '是否允许 AI 开始执行这个任务？',
          actions: [{
            id: 'allow-agent-execution',
            label: '允许执行',
          }],
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">是否允许 AI 开始执行这个任务？</div>' },
        },
      },
    });

    await wrapper.find('.ai-message-option-button').trigger('click');

    expect(wrapper.emitted('messageAction')).toEqual([
      ['assistant-message', 'allow-agent-execution'],
    ]);
  });

  it('在用户消息气泡上方显示已发送的附件文件标记', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          role: 'user',
          content: '请帮我检查这个文件',
          references: [
            {
              id: 'attachment:README.md:1:2457',
              kind: 'search-result',
              label: '附件 · README.md',
              path: 'README.md',
              range: null,
              contentPreview: 'README content',
              redacted: false,
            },
            {
              id: 'current-file:README.md',
              kind: 'current-file',
              label: 'README.md',
              path: 'README.md',
              range: null,
              contentPreview: 'ignored',
              redacted: false,
            },
          ],
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">请帮我检查这个文件</div>' },
        },
      },
    });

    expect(wrapper.find('.ai-message-attachments').exists()).toBe(true);
    expect(wrapper.findAll('.ai-message-attachment-chip')).toHaveLength(1);
    expect(wrapper.text()).toContain('README.md');
    expect(wrapper.find('.ai-message-attachment-chip svg').exists()).toBe(true);
  });
});

import AiMessageItem from '@/components/business/ai/AiMessageItem.vue';
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

describe('AiMessageItem', () => {
  beforeEach(() => {
    successMock.mockReset();
    errorMock.mockReset();
    warningMock.mockReset();
    tryWriteClipboardTextMock.mockReset();
    tryWriteClipboardTextMock.mockResolvedValue(true);
  });

  it('renders a single inline loader for an empty streaming assistant message', () => {
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
    expect(wrapper.find('.ai-message-bubble').exists()).toBe(false);
    expect(wrapper.find('.markdown-stub').exists()).toBe(false);
  });

  it('有 Streaming Events 轨迹时用树状时间线展示公开进度，不退回普通加载行', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          stream: {
            status: 'streaming',
            activityText: '查询：淘宝网 最新商品',
            activityTrail: [
              '查询：淘宝网 最新商品',
              '站点：taobao.com',
            ],
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

    expect(wrapper.find('.ai-tool-activity-inline').exists()).toBe(true);
    expect(wrapper.find('.ai-message-status-line').exists()).toBe(false);
    expect(wrapper.text()).toContain('查询：淘宝网 最新商品');
    expect(wrapper.text()).toContain('站点：taobao.com');
    expect(wrapper.find('.markdown-stub').exists()).toBe(false);
  });

  it('有 Activity 树时直接渲染活动流，不把公开过程放进回答气泡', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '正在核对最近公开信息',
          stream: {
            status: 'streaming',
            activities: [
              {
                id: 'run-root',
                runId: 'run-1',
                kind: 'run',
                status: 'running',
                title: '联网搜索「伊朗 核设施」',
              },
              {
                id: 'summary-1',
                runId: 'run-1',
                parentId: 'run-root',
                kind: 'reasoning_summary',
                status: 'running',
                title: '正在核对最近公开信息',
              },
            ],
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">正在核对最近公开信息</div>' },
        },
      },
    });

    expect(wrapper.find('.ai-tool-activity-inline').exists()).toBe(true);
    expect(wrapper.text()).toContain('联网搜索「伊朗 核设施」');
    expect(wrapper.text()).toContain('正在核对最近公开信息');
    expect(wrapper.find('.ai-message-bubble').exists()).toBe(false);
    expect(wrapper.find('.markdown-stub').exists()).toBe(false);
  });

  it('只有 activityEvents 也会直接渲染活动流，不把公开过程放进回答气泡', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '正在从 event log 还原活动树',
          stream: {
            status: 'streaming',
            activityEvents: [
              {
                type: 'ACTIVITY_SNAPSHOT',
                timestamp: 1_746_217_200_000,
                messageId: 'run-root',
                activityType: 'RUN',
                replace: true,
                content: {
                  id: 'run-root',
                  runId: 'run-1',
                  kind: 'run',
                  status: 'running',
                  title: '验证内部 AG-UI event log',
                },
              },
              {
                type: 'ACTIVITY_SNAPSHOT',
                timestamp: 1_746_217_200_001,
                messageId: 'summary-1',
                activityType: 'REASONING_SUMMARY',
                replace: true,
                content: {
                  id: 'summary-1',
                  runId: 'run-1',
                  parentId: 'run-root',
                  kind: 'reasoning_summary',
                  status: 'running',
                  title: '正在从 event log 还原活动树',
                },
              },
            ],
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">正在从 event log 还原活动树</div>' },
        },
      },
    });

    expect(wrapper.find('.ai-tool-activity-inline').exists()).toBe(true);
    expect(wrapper.text()).toContain('验证内部 AG-UI event log');
    expect(wrapper.text()).toContain('正在从 event log 还原活动树');
    expect(wrapper.find('.ai-message-bubble').exists()).toBe(false);
    expect(wrapper.find('.markdown-stub').exists()).toBe(false);
  });

  it('does not render a blank non-streaming assistant placeholder', () => {
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

  it('reuses the same bubble when streamed content arrives', async () => {
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

  it('活动树流式运行时把公开过程留在活动 UI，不提前放进回答气泡', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '好的，我需要先联网检索最新信息。',
          stream: {
            status: 'streaming',
            activityText: '联网搜索「伊朗 核设施」',
            activityTrail: [
              '好的，我需要先联网检索最新信息。',
            ],
          },
          toolCalls: [
            {
              id: 'tool-1',
              name: 'tavily_search',
              status: 'running',
              summary: '伊朗 核设施',
              targetPreview: '伊朗 核设施',
            },
          ],
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">好的，我需要先联网检索最新信息。</div>' },
        },
      },
    });

    expect(wrapper.find('.ai-tool-activity-inline').exists()).toBe(true);
    expect(wrapper.text()).toContain('好的，我需要先联网检索最新信息。');
    expect(wrapper.find('.ai-message-bubble').exists()).toBe(false);
    expect(wrapper.find('.markdown-stub').exists()).toBe(false);
  });

  it('活动树流式运行时仍然实时显示真正的回答内容', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '这是我正在流式输出的最终回答第一段。',
          stream: {
            status: 'streaming',
            activityText: '联网搜索「伊朗 核设施」',
            activityTrail: [
              '正在核对最近公开信息',
            ],
          },
          toolCalls: [
            {
              id: 'tool-1',
              name: 'tavily_search',
              status: 'succeeded',
              summary: '伊朗 核设施',
              targetPreview: '伊朗 核设施',
            },
          ],
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">这是我正在流式输出的最终回答第一段。</div>' },
        },
      },
    });

    expect(wrapper.find('.ai-tool-activity-inline').exists()).toBe(true);
    expect(wrapper.text()).toContain('联网搜索「伊朗 核设施」');
    expect(wrapper.find('.ai-message-bubble').exists()).toBe(true);
    expect(wrapper.find('.markdown-stub').exists()).toBe(true);
  });

  it('活动树完成后再显示最终回答气泡', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '这是最终分析结果。',
          stream: {
            status: 'completed',
            activityText: '联网搜索「伊朗 核设施」',
          },
          toolCalls: [
            {
              id: 'tool-1',
              name: 'tavily_search',
              status: 'succeeded',
              summary: '伊朗 核设施',
              targetPreview: '伊朗 核设施',
            },
          ],
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">这是最终分析结果。</div>' },
        },
      },
    });

    expect(wrapper.find('.ai-tool-activity-inline').exists()).toBe(true);
    expect(wrapper.find('.ai-message-bubble').exists()).toBe(true);
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

  it('复制流式代码块时直接保留当前 Markdown 内容', async () => {
    const content = '可以这样写：\n\n```bash\necho hello';
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content,
          stream: {
            status: 'streaming',
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">可以这样写：</div>' },
        },
      },
    });

    await wrapper.find('.ai-message-copy-button').trigger('click');

    expect(tryWriteClipboardTextMock).toHaveBeenCalledWith(content);
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

  it('以时间线样式展示工具调用活动并隐藏临时进度气泡', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: 'AI 正在自动使用工具：搜索项目内容',
          stream: {
            status: 'streaming',
            activityText: '在工作区搜索「项目内容」',
            activityTrail: [
              '项目内容',
              '在工作区搜索「项目内容」',
            ],
          },
          toolCalls: [
            {
              id: 'tool-1',
              name: 'search_text',
              status: 'succeeded',
              summary: '搜索项目内容',
            },
            {
              id: 'tool-2',
              name: 'web_fetch',
              status: 'running',
              summary: 'registry.npmjs.org/mini-cc',
            },
          ],
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

    expect(wrapper.find('.ai-tool-activity-inline').exists()).toBe(true);
    expect(wrapper.text()).toContain('搜索');
    expect(wrapper.text()).toContain('项目内容');
    expect(wrapper.text()).toContain('读取网页');
    expect(wrapper.text()).toContain('registry.npmjs.org/mini-cc');
    expect(wrapper.find('.ai-message-status-line').exists()).toBe(false);
    expect(wrapper.text()).toContain('在工作区搜索「项目内容」');
    expect(wrapper.text()).toContain('项目内容');
    expect(wrapper.find('.ai-tool-running-dots').exists()).toBe(false);
    expect(wrapper.find('.ai-message-bubble').exists()).toBe(false);
  });

  it('工具调用流式更新时显示运行阶段但不额外显示 dots 气泡', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'read_file',
              status: 'running',
              summary: '正在读取 AiMessageItem.vue…',
            },
          ],
          stream: {
            status: 'streaming',
            activityText: '查看文件 AiMessageItem.vue',
            activityTrail: [
              'AiMessageItem',
              '查看文件 AiMessageItem.vue',
            ],
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

    expect(wrapper.find('.ai-tool-activity-inline').exists()).toBe(true);
    expect(wrapper.find('.ai-message-status-line').exists()).toBe(false);
    expect(wrapper.text()).toContain('查看文件 AiMessageItem.vue');
    expect(wrapper.text()).toContain('AiMessageItem');
    expect(wrapper.find('.ai-message-bubble').exists()).toBe(false);
  });
});

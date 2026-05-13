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

const lightboxMock = vi.hoisted(() => {
  const instances: Array<{
    options: Record<string, unknown>;
    init: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    loadAndOpen: ReturnType<typeof vi.fn>;
  }> = [];

  const ctor = vi.fn(function MockPhotoSwipeLightbox(
    this: Record<string, unknown>,
    options: Record<string, unknown>,
  ) {
    const instance = {
      options,
      init: vi.fn(),
      destroy: vi.fn(),
      loadAndOpen: vi.fn(() => true),
    };

    instances.push(instance);
    Object.assign(this, instance);
  });

  return { ctor, instances };
});

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

vi.mock('photoswipe/lightbox', () => ({
  default: lightboxMock.ctor,
}));

const createMessage = (overrides: Partial<IAiChatMessage>): IAiChatMessage => ({
  id: 'assistant-message',
  role: 'assistant',
  content: '',
  createdAt: '2026-04-28T10:00:00.000Z',
  references: [],
  ...overrides,
});

const createRuntimeEvent = (overrides: Partial<TAgentRuntimeEvent>): TAgentRuntimeEvent =>
  ({
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
    lightboxMock.instances.length = 0;
    lightboxMock.ctor.mockClear();
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

  it('空的流式助手消息默认显示脑袋图标和准备回复文案', () => {
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
          AiMarkdown: { template: '<div class="markdown-stub" />' },
        },
      },
    });

    expect(wrapper.find('.ai-thinking-status').exists()).toBe(true);
    expect(wrapper.find('.ai-thinking-status__icon').exists()).toBe(true);
    expect(wrapper.text()).toContain('正在准备回复');
  });

  it('预算诊断事件不会渲染到用户消息时间线，而是继续显示准备回复状态', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          stream: {
            status: 'streaming',
            runtimeEvents: [
              createRuntimeEvent({
                id: 'token-budget-1',
                type: 'acontext.token.checked',
                visibility: 'debug',
                projectedInputTokensAvailable: true,
                projectedInputTokens: 3_865,
              }),
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

    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(false);
    expect(wrapper.find('.ai-message-status-line').exists()).toBe(true);
    expect(wrapper.text()).toContain('正在准备回复');
    expect(wrapper.text()).not.toContain('上下文预算检查');
  });

  it('最终回答开始后不再显示准备回复状态', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '这是最终回答。',
          stream: {
            status: 'streaming',
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

    expect(wrapper.find('.ai-thinking-status').exists()).toBe(false);
    expect(wrapper.find('.ai-message-bubble').exists()).toBe(true);
  });

  it('流式生成时显示输出 token 进度', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '你好',
          stream: {
            status: 'streaming',
            completionTokens: 387,
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

    expect(wrapper.find('.ai-message-token-progress').exists()).toBe(true);
    expect(wrapper.text()).toContain('约已生成 387 token');
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
          AiMarkdown: {
            template: '<div class="markdown-stub">好的，我先检查当前 sidecar 状态。</div>',
          },
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
    expect(wrapper.find('.ai-tool-call-list').exists()).toBe(false);
    expect(
      runtimeTimeline.element.compareDocumentPosition(messageBubble.element) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('runtime 时间线出现时隐藏底部工具摘要列表', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          toolCalls: [
            {
              id: 'tool-call-read-file',
              name: 'read_file',
              status: 'succeeded',
              summary: 'D:/test/heatmap.py',
            },
          ],
          stream: {
            status: 'completed',
            runtimeEvents: [
              createRuntimeEvent({
                id: 'reasoning-1',
                text: '我先确认文件内容。',
              }),
              createRuntimeEvent({
                id: 'tool-start-1',
                type: 'agent.tool.started',
                toolUseId: 'tool-use-1',
                toolName: 'read_file',
                inputPreview: '{"path":"D:/test/heatmap.py"}',
              }),
              createRuntimeEvent({
                id: 'tool-complete-1',
                type: 'agent.tool.completed',
                toolUseId: 'tool-use-1',
                toolName: 'read_file',
                ok: true,
                resultPreview: '{"content":"print(1)"}',
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
          AiMarkdown: { template: '<div class="markdown-stub" />' },
        },
      },
    });

    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(true);
    expect(wrapper.text()).toContain('读取完成 D:/test/heatmap.py');
    expect(wrapper.find('.ai-tool-call-list').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('已读取 D:/test/heatmap.py');
  });

  it('没有 runtime 时间线时仍显示底部工具摘要列表', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          toolCalls: [
            {
              id: 'tool-call-read-file-only',
              name: 'read_file',
              status: 'succeeded',
              summary: 'D:/test/heatmap.py',
            },
          ],
          stream: {
            status: 'completed',
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

    expect(wrapper.find('.ai-runtime-timeline').exists()).toBe(false);
    expect(wrapper.find('.ai-tool-call-list').exists()).toBe(true);
    expect(wrapper.text()).toContain('已读取 D:/test/heatmap.py');
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

  it('在助手消息内联渲染 AED diff 和最终变更摘要，不显示外部 Diff 面板入口', () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '已完成修改。',
          patches: [
            {
              summary: '更新启动提示',
              files: [
                {
                  path: 'D:/repo/src/app.ts',
                  originalHash: 'fnv64:test',
                  hunks: [
                    {
                      oldStart: 1,
                      oldLines: 1,
                      newStart: 1,
                      newLines: 1,
                      lines: ['-const start = true;', '+const start = false;'],
                    },
                  ],
                },
              ],
            },
          ],
          changedFilesSummary: {
            id: 'patch-summary-1',
            runId: 'sidecar:turn-1',
            stepId: 'agent',
            files: [
              {
                path: 'D:/repo/src/app.ts',
                status: 'modified',
                additions: 1,
                deletions: 1,
                diffRef: 'diff:src-app',
              },
            ],
            totalAdditions: 1,
            totalDeletions: 1,
            patchRef: 'aed-patch:thread-1',
            appliedAt: '2026-05-12T10:00:00.000Z',
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
        workspaceRootPath: 'D:/repo',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">已完成修改。</div>' },
        },
      },
    });

    expect(wrapper.find('.ai-message-patch-list').exists()).toBe(false);
    expect(wrapper.find('.ai-message-changed-files').exists()).toBe(true);
    expect(wrapper.text()).toContain('1 个文件已更改');
    expect(wrapper.text()).toContain('D:/repo/src/app.ts');
    expect(wrapper.text()).toContain('+1');
    expect(wrapper.text()).toContain('-1');
    expect(wrapper.text()).not.toContain('打开 Diff 面板');
    expect(wrapper.text()).not.toContain('查看 Diff');
  });

  it('点击最终变更摘要撤销时向外 emit 消息和 summary id', async () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          content: '已完成修改。',
          changedFilesSummary: {
            id: 'patch-summary-1',
            runId: 'sidecar:turn-1',
            stepId: 'agent',
            files: [
              {
                path: 'D:/repo/src/app.ts',
                status: 'modified',
                additions: 1,
                deletions: 1,
                diffRef: 'diff:src-app',
              },
            ],
            totalAdditions: 1,
            totalDeletions: 1,
            patchRef: 'aed-patch:thread-1',
            appliedAt: '2026-05-12T10:00:00.000Z',
          },
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">已完成修改。</div>' },
        },
      },
    });

    await wrapper.find('button.ai-changed-files-action').trigger('click');

    expect(wrapper.emitted('changedFilesRollback')).toEqual([
      ['assistant-message', 'patch-summary-1'],
    ]);
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
          actions: [
            {
              id: 'allow-agent-execution',
              label: '允许执行',
            },
          ],
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: {
            template: '<div class="markdown-stub">是否允许 AI 开始执行这个任务？</div>',
          },
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

    expect(wrapper.find('.ai-message-image-attachments').exists()).toBe(true);
    expect(wrapper.findAll('.ai-attachment-card[data-variant="message"]')).toHaveLength(1);
    expect(wrapper.text()).toContain('README.md');
    expect(wrapper.find('.ai-attachment-card[data-variant="message"] svg').exists()).toBe(true);
    expect(wrapper.find('.ai-attachment-hover-card').exists()).toBe(false);
  });

  it('在用户消息气泡上方显示可点击放大的已发送图片预览', async () => {
    const wrapper = mount(AiMessageItem, {
      props: {
        message: createMessage({
          id: 'user-image-message',
          role: 'user',
          content: '请看这张图',
          references: [
            {
              id: 'attachment:screenshot.png:1:4096',
              kind: 'image-attachment',
              label: '图片附件 · screenshot.png',
              path: 'screenshot.png',
              range: null,
              contentPreview: '图片附件',
              redacted: false,
              attachmentPreview: {
                src: 'blob:attachment-preview-message',
                width: 1280,
                height: 720,
                mimeType: 'image/png',
              },
            },
          ],
        }),
        platformId: 'deepseek',
        providerLabel: 'DeepSeek',
      },
      global: {
        stubs: {
          AiMarkdown: { template: '<div class="markdown-stub">请看这张图</div>' },
        },
      },
    });

    await wrapper.vm.$nextTick();
    expect(lightboxMock.ctor).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.ai-message-image-attachments').exists()).toBe(true);
    expect(wrapper.get('.ai-image-attachment-preview-link img').attributes('src')).toBe(
      'blob:attachment-preview-message',
    );
    expect(wrapper.find('.ai-attachment-hover-card').exists()).toBe(false);

    await wrapper.get('.ai-image-attachment-preview-link').trigger('click');

    expect(lightboxMock.instances[0]?.loadAndOpen).toHaveBeenCalledWith(0, [
      expect.objectContaining({
        src: 'blob:attachment-preview-message',
        width: 1280,
        height: 720,
        alt: 'screenshot.png',
      }),
    ]);
  });
});

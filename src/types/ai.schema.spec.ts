import {
  aiChatPayloadSchema,
  aiChatRequestSchema,
  aiConfigPayloadSchema,
  aiToolDefinitionPayloadSchema,
} from '@/types/ai.schema';
import { describe, expect, it } from 'vitest';

const reference = {
  id: 'current-file:/tmp/a.sh',
  kind: 'current-file',
  label: 'a.sh',
  path: '/tmp/a.sh',
  range: null,
  contentPreview: 'echo ok',
  redacted: false,
};

const message = {
  id: 'm1',
  role: 'user',
  content: '解释一下',
  createdAt: '2026-04-27T00:00:00.000Z',
  references: [reference],
};

describe('AI schema', () => {
  it('校验 AI 配置不包含密钥字段', () => {
    const parsed = aiConfigPayloadSchema.parse({
      providerType: 'mock',
      selectedModel: 'mock-ide-assistant',
      baseUrl: null,
      isBaseUrlConfigured: false,
      hasCredentials: false,
      isConfigured: true,
      inlineCompletionEnabled: false,
      chatEnabled: true,
      agentEnabled: false,
    });

    expect(parsed.providerType).toBe('mock');
    expect('apiKey' in parsed).toBe(false);
  });

  it('校验 chat 请求必须携带结构化引用', () => {
    const parsed = aiChatRequestSchema.parse({
      threadId: null,
      messages: [message],
      references: [reference],
    });

    expect(parsed.references[0]?.kind).toBe('current-file');
  });

  it('拒绝未知 Provider', () => {
    expect(() =>
      aiConfigPayloadSchema.parse({
        providerType: 'unknown',
        selectedModel: null,
        baseUrl: null,
        isBaseUrlConfigured: false,
        hasCredentials: false,
        isConfigured: false,
        inlineCompletionEnabled: false,
        chatEnabled: false,
        agentEnabled: false,
      }),
    ).toThrow();
  });

  it('校验 chat 响应消息', () => {
    const parsed = aiChatPayloadSchema.parse({
      providerType: 'mock',
      model: 'mock-ide-assistant',
      message: {
        ...message,
        id: 'assistant-1',
        role: 'assistant',
        content: 'Mock 回复',
      },
    });

    expect(parsed.message.role).toBe('assistant');
  });

  it('将 Rust 工具白名单字段转换为前端 camelCase', () => {
    const parsed = aiToolDefinitionPayloadSchema.parse({
      name: 'propose_patch',
      read_only: false,
      destructive: false,
      requires_confirmation: true,
    });

    expect(parsed).toEqual({
      name: 'propose_patch',
      readOnly: false,
      destructive: false,
      requiresConfirmation: true,
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  aiChatMessageStreamSnapshotSchema,
  aiChatRequestSchema,
  aiConfigPayloadSchema,
  aiCredentialStatusPayloadSchema,
  aiProviderTypeSchema,
} from '@/types/ai/schema';

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
      providerType: 'mastra',
      selectedModel: 'openai/gpt-5.5',
      baseUrl: 'http://127.0.0.1:4000/v1',
      isBaseUrlConfigured: true,
      hasCredentials: false,
      isConfigured: true,
      inlineCompletionEnabled: false,
      chatEnabled: true,
      agentEnabled: false,
      narrator: {
        providerType: 'mastra',
        selectedModel: 'zhipuai/glm-4.7-flash',
        baseUrl: 'http://127.0.0.1:4000/v1',
        isBaseUrlConfigured: true,
        hasCredentials: false,
        isConfigured: false,
      },
      credentials: [{ providerId: 'openai', hasCredentials: true }],
    });
    expect(parsed.providerType).toBe('mastra');
    expect(parsed.credentials[0]?.providerId).toBe('openai');
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

  it('允许图片附件引用携带预览元数据', () => {
    const parsed = aiChatRequestSchema.parse({
      threadId: null,
      messages: [message],
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
            src: 'blob:attachment-preview',
            width: 1280,
            height: 720,
            mimeType: 'image/png',
          },
        },
      ],
    });
    expect(parsed.references[0]?.attachmentPreview?.mimeType).toBe('image/png');
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
        narrator: {
          providerType: 'mastra',
          selectedModel: 'zhipuai/glm-4.7-flash',
          baseUrl: 'http://127.0.0.1:4000/v1',
          isBaseUrlConfigured: true,
          hasCredentials: false,
          isConfigured: false,
        },
      }),
    ).toThrow();
  });

  it('只允许 Mastra Provider 类型', () => {
    expect(aiProviderTypeSchema.parse('mastra')).toBe('mastra');
    expect(() => aiProviderTypeSchema.parse('litellm')).toThrow();
  });

  it('凭证状态按厂商保存', () => {
    const parsed = aiCredentialStatusPayloadSchema.parse({
      providerId: 'deepseek',
      hasCredentials: true,
    });
    expect(parsed.providerId).toBe('deepseek');
    expect(parsed.hasCredentials).toBe(true);
  });
});

describe('AI 流式快照 interrupted 标记', () => {
  it('interrupted 为可选字段(缺省时解析通过且为 undefined)', () => {
    const parsed = aiChatMessageStreamSnapshotSchema.parse({ status: 'cancelled' });
    expect(parsed.interrupted).toBeUndefined();
  });

  it('接受并保留 interrupted: true', () => {
    const parsed = aiChatMessageStreamSnapshotSchema.parse({
      status: 'cancelled',
      interrupted: true,
    });
    expect(parsed.interrupted).toBe(true);
  });

  it('拒绝非布尔的 interrupted', () => {
    expect(() =>
      aiChatMessageStreamSnapshotSchema.parse({
        status: 'cancelled',
        interrupted: 'yes',
      }),
    ).toThrow();
  });
});
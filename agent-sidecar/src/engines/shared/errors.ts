import { toRecord } from './utils.js';

export const normalizeMastraError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  const message = toRecord(error)?.message;
  return typeof message === 'string' && message.trim().length > 0
    ? message
    : String(error);
};

/**
 * 从 AI SDK（@ai-sdk/openai-compatible / @mastra/core/llm）抛出的结构化错误中
 * 提取稳定的 provider 错误分类码。
 *
 * AI SDK 的错误类型（如 AI_APICallError）携带 `responseStatus`（HTTP 状态码）
 * 等结构化属性。本函数优先从这些属性推导分类码，无法获取时回退到消息文本
 * 子串匹配。返回的分类码与 Rust 侧 classify_provider_test_error_code 对齐。
 */
export const classifyProviderErrorCode = (error: unknown): string | undefined => {
  const record = toRecord(error);

  // AI SDK 错误暴露 `responseStatus`（HTTP 状态码）。
  const responseStatus = typeof record?.responseStatus === 'number'
    ? record.responseStatus
    : undefined;

  if (responseStatus === 401 || responseStatus === 403) {
    return 'AI_PROVIDER_AUTH_FAILED';
  }
  if (responseStatus === 429) {
    return 'AI_PROVIDER_RATE_LIMITED';
  }
  if (responseStatus === 404) {
    return 'AI_PROVIDER_NOT_CONFIGURED';
  }

  // 回退：消息文本子串匹配（镜像 Rust 侧 classify_provider_test_error_code 的逻辑）。
  const message = normalizeMastraError(error).toLowerCase();
  if (message.includes('http 401')
      || message.includes('http 403')
      || message.includes('unauthorized')
      || message.includes('forbidden')) {
    return 'AI_PROVIDER_AUTH_FAILED';
  }
  if (message.includes('http 429')
      || message.includes('too many requests')
      || message.includes('rate limit')) {
    return 'AI_PROVIDER_RATE_LIMITED';
  }
  if (message.includes('http 404') || message.includes('not found')) {
    return 'AI_PROVIDER_NOT_CONFIGURED';
  }

  return undefined;
};

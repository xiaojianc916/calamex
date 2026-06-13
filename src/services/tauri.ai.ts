import { commands } from '@/bindings/tauri';
import type { ITauriService } from '@/types/tauri';
import {
  buildPayloadMetrics,
  buildPayloadMetricsOmittingTextFields,
  measureAiChatInput,
  measureAiInlineCompletionInput,
} from './tauri.ipc-metrics';
import { callSpectaCommand } from './tauri.ipc-runtime';
import type { IIpcCallOptions } from './tauri.ipc-types';

/**
 * AI invoke 层：从手写 Zod 契约迁入 tauri-specta 生成绑定（commands.*）。
 *
 * - 入参 / 出参类型以 Rust 为单一事实源，经 src/bindings/tauri.ts 生成。
 * - 保留薄仪表化外壳（callSpectaCommand：审计 / 超时 / 取消 / 错误归一化）。
 * - Chat 流式事件不再走旧 `ai:chat-stream`，统一由 ACP `ai:sidecar-stream` 消费。
 */

type TAiRequest<K extends keyof ITauriService> = Parameters<ITauriService[K]>[0];
type TAiResult<K extends keyof ITauriService> = Awaited<ReturnType<ITauriService[K]>>;

const aiGetConfigIpc = (options?: IIpcCallOptions): Promise<TAiResult<'aiGetConfig'>> =>
  callSpectaCommand(
    {
      command: 'ai_get_config',
      guardHint: '读取 AI 配置',
      idempotent: true,
      audit: 'sensitive',
      signal: options?.signal,
    },
    () => commands.aiGetConfig(),
  );

const aiSaveConfigIpc = (
  payload: TAiRequest<'aiSaveConfig'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiSaveConfig'>> =>
  callSpectaCommand(
    {
      command: 'ai_save_config',
      guardHint: '保存 AI 配置',
      audit: 'sensitive',
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiSaveConfig(payload),
  );

const aiSaveCredentialsIpc = (
  payload: TAiRequest<'aiSaveCredentials'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiSaveCredentials'>> =>
  callSpectaCommand(
    {
      command: 'ai_save_credentials',
      guardHint: '保存 AI 凭证',
      audit: 'sensitive',
      input: payload,
      measureInput: (value) => buildPayloadMetricsOmittingTextFields(value, ['apiKey']),
      signal: options?.signal,
    },
    () => commands.aiSaveCredentials(payload),
  );

const aiTestProviderConfigIpc = (
  payload: TAiRequest<'aiTestProviderConfig'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiTestProviderConfig'>> =>
  callSpectaCommand(
    {
      command: 'ai_test_provider_config',
      guardHint: '使用草稿配置测试 AI Provider',
      idempotent: true,
      audit: 'sensitive',
      input: payload,
      measureInput: (value) => buildPayloadMetricsOmittingTextFields(value, ['apiKey']),
      signal: options?.signal,
    },
    () => commands.aiTestProviderConfig(payload),
  );

const aiConnectProviderIpc = (
  payload: TAiRequest<'aiConnectProvider'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiConnectProvider'>> =>
  callSpectaCommand(
    {
      command: 'ai_connect_provider',
      guardHint: '连接并保存 AI Provider',
      audit: 'sensitive',
      input: payload,
      measureInput: (value) => buildPayloadMetricsOmittingTextFields(value, ['apiKey']),
      signal: options?.signal,
    },
    () => commands.aiConnectProvider(payload),
  );

const aiClearCredentialsIpc = (options?: IIpcCallOptions): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'ai_clear_credentials',
      guardHint: '清除 AI 凭证',
      audit: 'sensitive',
      signal: options?.signal,
    },
    async () => {
      await commands.aiClearCredentials();
    },
  );

const aiTestProviderIpc = (options?: IIpcCallOptions): Promise<TAiResult<'aiTestProvider'>> =>
  callSpectaCommand(
    {
      command: 'ai_test_provider',
      guardHint: '测试 AI Provider',
      idempotent: true,
      audit: 'sensitive',
      signal: options?.signal,
    },
    () => commands.aiTestProvider(),
  );

const aiGenerateConversationTitleIpc = (
  payload: TAiRequest<'aiGenerateConversationTitle'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiGenerateConversationTitle'>> =>
  callSpectaCommand(
    {
      command: 'ai_generate_conversation_title',
      guardHint: '生成 AI 对话标题',
      audit: 'sensitive',
      timeoutMs: 30_000,
      input: payload,
      measureInput: buildPayloadMetrics,
      signal: options?.signal,
    },
    () => commands.aiGenerateConversationTitle(payload),
  );

const aiGetSuggestionPoolCacheIpc = (
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiGetSuggestionPoolCache'>> =>
  callSpectaCommand(
    {
      command: 'ai_get_suggestion_pool_cache',
      guardHint: '读取 AI 提示词池缓存',
      idempotent: true,
      audit: 'none',
      timeoutMs: 5_000,
      signal: options?.signal,
    },
    () => commands.aiGetSuggestionPoolCache(),
  );

const aiGenerateSuggestionPoolIpc = (
  payload: TAiRequest<'aiGenerateSuggestionPool'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiGenerateSuggestionPool'>> =>
  callSpectaCommand(
    {
      command: 'ai_generate_suggestion_pool',
      guardHint: '生成 AI 提示词池',
      audit: 'info',
      timeoutMs: 30_000,
      input: payload,
      measureInput: buildPayloadMetrics,
      signal: options?.signal,
    },
    () => commands.aiGenerateSuggestionPool(payload),
  );

const aiChatStreamIpc = (
  payload: TAiRequest<'aiChatStream'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiChatStream'>> =>
  callSpectaCommand(
    {
      command: 'ai_chat_stream',
      guardHint: '发送 AI 流式对话请求',
      audit: 'sensitive',
      timeoutMs: 60_000,
      input: payload,
      measureInput: measureAiChatInput,
      signal: options?.signal,
    },
    () => commands.aiChatStream(payload),
  );

const aiCancelIpc = (payload: TAiRequest<'aiCancel'>, options?: IIpcCallOptions): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'ai_cancel',
      guardHint: '取消 AI 流式请求',
      audit: 'sensitive',
      timeoutMs: 15_000,
      input: payload,
      measureInput: buildPayloadMetrics,
      signal: options?.signal,
    },
    async () => {
      await commands.aiCancel(payload);
    },
  );

const aiInlineCompleteIpc = (
  payload: TAiRequest<'aiInlineComplete'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiInlineComplete'>> =>
  callSpectaCommand(
    {
      command: 'ai_inline_complete',
      guardHint: '请求 AI 内联补全',
      audit: 'sensitive',
      timeoutMs: 15_000,
      input: payload,
      measureInput: measureAiInlineCompletionInput,
      signal: options?.signal,
    },
    () => commands.aiInlineComplete(payload),
  );

const aiAgentClassifyTaskIpc = (
  payload: TAiRequest<'aiAgentClassifyTask'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiAgentClassifyTask'>> =>
  callSpectaCommand(
    {
      command: 'ai_agent_classify_task',
      guardHint: '分类 AI Agent 任务复杂度',
      audit: 'sensitive',
      timeoutMs: 30_000,
      input: payload,
      measureInput: measureAiChatInput,
      signal: options?.signal,
    },
    () => commands.aiAgentClassifyTask(payload),
  );

const aiAgentSetNetworkPermissionIpc = (
  payload: TAiRequest<'aiAgentSetNetworkPermission'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiAgentSetNetworkPermission'>> =>
  callSpectaCommand(
    {
      command: 'ai_agent_set_network_permission',
      guardHint: '设置 AI Agent 网络权限',
      audit: 'sensitive',
      timeoutMs: 15_000,
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiAgentSetNetworkPermission(payload),
  );

const aiWebSearchIpc = (
  payload: TAiRequest<'aiWebSearch'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiWebSearch'>> =>
  callSpectaCommand(
    {
      command: 'ai_web_search',
      guardHint: '执行 AI Agent 网络搜索',
      idempotent: true,
      audit: 'sensitive',
      timeoutMs: 30_000,
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiWebSearch(payload),
  );

const aiWebFetchIpc = (
  payload: TAiRequest<'aiWebFetch'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiWebFetch'>> =>
  callSpectaCommand(
    {
      command: 'ai_web_fetch',
      guardHint: '读取 AI Agent 网页来源',
      idempotent: true,
      audit: 'sensitive',
      timeoutMs: 30_000,
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiWebFetch(payload),
  );

const aiProposePatchIpc = (
  payload: TAiRequest<'aiProposePatch'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiProposePatch'>> =>
  callSpectaCommand(
    {
      command: 'ai_propose_patch',
      guardHint: '生成 AI Patch 预览',
      audit: 'sensitive',
      timeoutMs: 30_000,
      input: payload,
      measureInput: (value) =>
        buildPayloadMetricsOmittingTextFields(value, ['originalContent', 'updatedContent']),
      signal: options?.signal,
    },
    () => commands.aiProposePatch(payload),
  );

const aiApplyPatchIpc = (
  payload: TAiRequest<'aiApplyPatch'>,
  options?: IIpcCallOptions,
): Promise<TAiResult<'aiApplyPatch'>> =>
  callSpectaCommand(
    {
      command: 'ai_apply_patch',
      guardHint: '应用 AI Patch',
      audit: 'sensitive',
      timeoutMs: 30_000,
      input: payload,
      measureInput: measureAiChatInput,
      signal: options?.signal,
    },
    () => commands.aiApplyPatch(payload),
  );

type TAiTauriService = Pick<
  ITauriService,
  | 'aiGetConfig'
  | 'aiSaveConfig'
  | 'aiSaveCredentials'
  | 'aiClearCredentials'
  | 'aiTestProvider'
  | 'aiTestProviderConfig'
  | 'aiConnectProvider'
  | 'aiGenerateConversationTitle'
  | 'aiGetSuggestionPoolCache'
  | 'aiGenerateSuggestionPool'
  | 'aiChatStream'
  | 'aiCancel'
  | 'aiInlineComplete'
  | 'aiAgentClassifyTask'
  | 'aiAgentSetNetworkPermission'
  | 'aiWebSearch'
  | 'aiWebFetch'
  | 'aiProposePatch'
  | 'aiApplyPatch'
>;

export const aiTauriService: TAiTauriService = {
  aiGetConfig: () => aiGetConfigIpc(),

  aiSaveConfig: aiSaveConfigIpc,

  aiSaveCredentials: aiSaveCredentialsIpc,

  aiClearCredentials: () => aiClearCredentialsIpc(),

  aiTestProvider: () => aiTestProviderIpc(),

  aiTestProviderConfig: aiTestProviderConfigIpc,

  aiConnectProvider: aiConnectProviderIpc,

  aiGenerateConversationTitle: aiGenerateConversationTitleIpc,

  aiGetSuggestionPoolCache: () => aiGetSuggestionPoolCacheIpc(),

  aiGenerateSuggestionPool: aiGenerateSuggestionPoolIpc,

  aiChatStream: aiChatStreamIpc,

  aiCancel: aiCancelIpc,

  aiInlineComplete: aiInlineCompleteIpc,

  aiAgentClassifyTask: aiAgentClassifyTaskIpc,

  aiAgentSetNetworkPermission: aiAgentSetNetworkPermissionIpc,

  aiWebSearch: aiWebSearchIpc,

  aiWebFetch: aiWebFetchIpc,

  aiProposePatch: aiProposePatchIpc,

  aiApplyPatch: aiApplyPatchIpc,
};

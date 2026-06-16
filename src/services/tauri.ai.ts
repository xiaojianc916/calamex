import { commands } from '@/bindings/tauri';
import type { ITauriService } from '@/types/tauri';
import { type ICommandMeta, runCommand } from './tauri.ipc-define';
import {
  buildPayloadMetrics,
  buildPayloadMetricsOmittingTextFields,
  measureAiChatInput,
  measureAiInlineCompletionInput,
} from './tauri.ipc-metrics';
import type { IIpcCallOptions } from './tauri.ipc-types';

/**
 * AI invoke 层：从手写 Zod 契约迁入 tauri-specta 生成绑定（commands.*）。
 *
 * - 入参 / 出参类型以 Rust 为单一事实源，经 src/bindings/tauri.ts 生成。
 * - 仪表化外壳改用声明式 metadata 表（AI_COMMAND_META + runCommand），运行期行为与原
 *   手写 callSpectaCommand 逐字段一致：审计 / 超时 / 取消 / 错误归一化 / 入参度量。
 * - Chat 流式事件不再走旧 `ai:chat-stream`，统一由 ACP `ai:sidecar-stream` 消费。
 */

/**
 * AI Tauri 命令的声明式包装元数据表。每条语义与原手写 callSpectaCommand 逐字段对齐，
 * 运行期行为不变；只是把重复的 option 字面量集中到一处便于审计。
 */
const AI_COMMAND_META = {
  aiGetConfig: {
    command: 'ai_get_config',
    guardHint: '读取 AI 配置',
    idempotent: true,
    audit: 'sensitive',
  },
  aiSaveConfig: {
    command: 'ai_save_config',
    guardHint: '保存 AI 配置',
    audit: 'sensitive',
  },
  aiSaveCredentials: {
    command: 'ai_save_credentials',
    guardHint: '保存 AI 凭证',
    audit: 'sensitive',
    measureInput: (value) => buildPayloadMetricsOmittingTextFields(value, ['apiKey']),
  },
  aiTestProviderConfig: {
    command: 'ai_test_provider_config',
    guardHint: '使用草稿配置测试 AI Provider',
    idempotent: true,
    audit: 'sensitive',
    measureInput: (value) => buildPayloadMetricsOmittingTextFields(value, ['apiKey']),
  },
  aiConnectProvider: {
    command: 'ai_connect_provider',
    guardHint: '连接并保存 AI Provider',
    audit: 'sensitive',
    measureInput: (value) => buildPayloadMetricsOmittingTextFields(value, ['apiKey']),
  },
  aiClearCredentials: {
    command: 'ai_clear_credentials',
    guardHint: '清除 AI 凭证',
    audit: 'sensitive',
  },
  aiTestProvider: {
    command: 'ai_test_provider',
    guardHint: '测试 AI Provider',
    idempotent: true,
    audit: 'sensitive',
  },
  aiGenerateConversationTitle: {
    command: 'ai_generate_conversation_title',
    guardHint: '生成 AI 对话标题',
    audit: 'sensitive',
    timeoutMs: 30_000,
    measureInput: buildPayloadMetrics,
  },
  aiGetSuggestionPoolCache: {
    command: 'ai_get_suggestion_pool_cache',
    guardHint: '读取 AI 提示词池缓存',
    idempotent: true,
    audit: 'none',
    timeoutMs: 5_000,
  },
  aiGenerateSuggestionPool: {
    command: 'ai_generate_suggestion_pool',
    guardHint: '生成 AI 提示词池',
    audit: 'info',
    timeoutMs: 30_000,
    measureInput: buildPayloadMetrics,
  },
  aiChatStream: {
    command: 'ai_chat_stream',
    guardHint: '发送 AI 流式对话请求',
    audit: 'sensitive',
    timeoutMs: 60_000,
    measureInput: measureAiChatInput,
  },
  aiCancel: {
    command: 'ai_cancel',
    guardHint: '取消 AI 流式请求',
    audit: 'sensitive',
    timeoutMs: 15_000,
    measureInput: buildPayloadMetrics,
  },
  aiInlineComplete: {
    command: 'ai_inline_complete',
    guardHint: '请求 AI 内联补全',
    audit: 'sensitive',
    timeoutMs: 15_000,
    measureInput: measureAiInlineCompletionInput,
  },
  aiAgentClassifyTask: {
    command: 'ai_agent_classify_task',
    guardHint: '分类 AI Agent 任务复杂度',
    audit: 'sensitive',
    timeoutMs: 30_000,
    measureInput: measureAiChatInput,
  },
  aiAgentSetNetworkPermission: {
    command: 'ai_agent_set_network_permission',
    guardHint: '设置 AI Agent 网络权限',
    audit: 'sensitive',
    timeoutMs: 15_000,
  },
  aiWebSearch: {
    command: 'ai_web_search',
    guardHint: '执行 AI Agent 网络搜索',
    idempotent: true,
    audit: 'sensitive',
    timeoutMs: 30_000,
  },
  aiWebFetch: {
    command: 'ai_web_fetch',
    guardHint: '读取 AI Agent 网页来源',
    idempotent: true,
    audit: 'sensitive',
    timeoutMs: 30_000,
  },
  aiProposePatch: {
    command: 'ai_propose_patch',
    guardHint: '生成 AI Patch 预览',
    audit: 'sensitive',
    timeoutMs: 30_000,
    measureInput: (value) =>
      buildPayloadMetricsOmittingTextFields(value, ['originalContent', 'updatedContent']),
  },
  aiApplyPatch: {
    command: 'ai_apply_patch',
    guardHint: '应用 AI Patch',
    audit: 'sensitive',
    timeoutMs: 30_000,
    measureInput: measureAiChatInput,
  },
} satisfies Record<string, ICommandMeta>;

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
  aiGetConfig: () =>
    runCommand(AI_COMMAND_META.aiGetConfig, undefined, undefined, () => commands.aiGetConfig()),

  aiSaveConfig(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiSaveConfig, payload, options, () =>
      commands.aiSaveConfig(payload),
    );
  },

  aiSaveCredentials(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiSaveCredentials, payload, options, () =>
      commands.aiSaveCredentials(payload),
    );
  },

  aiClearCredentials: () =>
    runCommand<void>(AI_COMMAND_META.aiClearCredentials, undefined, undefined, async () => {
      await commands.aiClearCredentials();
    }),

  aiTestProvider: () =>
    runCommand(AI_COMMAND_META.aiTestProvider, undefined, undefined, () =>
      commands.aiTestProvider(),
    ),

  aiTestProviderConfig(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiTestProviderConfig, payload, options, () =>
      commands.aiTestProviderConfig(payload),
    );
  },

  aiConnectProvider(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiConnectProvider, payload, options, () =>
      commands.aiConnectProvider(payload),
    );
  },

  aiGenerateConversationTitle(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiGenerateConversationTitle, payload, options, () =>
      commands.aiGenerateConversationTitle(payload),
    );
  },

  aiGetSuggestionPoolCache: () =>
    runCommand(AI_COMMAND_META.aiGetSuggestionPoolCache, undefined, undefined, () =>
      commands.aiGetSuggestionPoolCache(),
    ),

  aiGenerateSuggestionPool(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiGenerateSuggestionPool, payload, options, () =>
      commands.aiGenerateSuggestionPool(payload),
    );
  },

  aiChatStream(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiChatStream, payload, options, () =>
      commands.aiChatStream(payload),
    );
  },

  aiCancel(payload, options?: IIpcCallOptions) {
    return runCommand<void>(AI_COMMAND_META.aiCancel, payload, options, async () => {
      await commands.aiCancel(payload);
    });
  },

  aiInlineComplete(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiInlineComplete, payload, options, () =>
      commands.aiInlineComplete(payload),
    );
  },

  aiAgentClassifyTask(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiAgentClassifyTask, payload, options, () =>
      commands.aiAgentClassifyTask(payload),
    );
  },

  aiAgentSetNetworkPermission(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiAgentSetNetworkPermission, payload, options, () =>
      commands.aiAgentSetNetworkPermission(payload),
    );
  },

  aiWebSearch(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiWebSearch, payload, options, () =>
      commands.aiWebSearch(payload),
    );
  },

  aiWebFetch(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiWebFetch, payload, options, () =>
      commands.aiWebFetch(payload),
    );
  },

  aiProposePatch(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiProposePatch, payload, options, () =>
      commands.aiProposePatch(payload),
    );
  },

  aiApplyPatch(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiApplyPatch, payload, options, () =>
      commands.aiApplyPatch(payload),
    );
  },
};

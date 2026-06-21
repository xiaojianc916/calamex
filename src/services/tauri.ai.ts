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
    // 连接测试需冷启动 ACP sidecar + 一次上游 LLM 往返，远超默认 10s IPC 超时；
    // 必须大于后端 PROVIDER_TEST_TIMEOUT(45s)，否则前端会在后端给出干净结果前误报“IPC 调用超时”。
    timeoutMs: 60_000,
    measureInput: (value) => buildPayloadMetricsOmittingTextFields(value, ['apiKey']),
  },
  aiConnectProvider: {
    command: 'ai_connect_provider',
    guardHint: '连接并保存 AI Provider',
    audit: 'sensitive',
    // 同 aiTestProviderConfig：连接即保存并做一次在线验证，需给足后端预算（>45s）。
    timeoutMs: 60_000,
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
    // 同上：测试会触发 sidecar 冷启动 + 上游往返，需大于后端 45s 预算。
    timeoutMs: 60_000,
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
  aiResolveApproval: {
    command: 'ai_resolve_approval',
    guardHint: '回投 ACP 工具调用审批决策',
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
  aiGetSessionConfigOptions: {
    command: 'ai_get_session_config_options',
    guardHint: '读取 ACP 会话可用配置项',
    idempotent: true,
    audit: 'info',
    timeoutMs: 15_000,
    measureInput: buildPayloadMetrics,
  },
  aiSetSessionConfigOption: {
    command: 'ai_set_session_config_option',
    guardHint: '切换 ACP 会话配置项',
    audit: 'sensitive',
    timeoutMs: 15_000,
    measureInput: buildPayloadMetrics,
  },
  aiGetSessionModes: {
    command: 'ai_get_session_modes',
    guardHint: '读取 ACP 会话可用模式',
    idempotent: true,
    audit: 'info',
    timeoutMs: 15_000,
    measureInput: buildPayloadMetrics,
  },
  aiSetSessionMode: {
    command: 'ai_set_session_mode',
    guardHint: '切换 ACP 会话模式',
    audit: 'sensitive',
    timeoutMs: 15_000,
    measureInput: buildPayloadMetrics,
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
  | 'aiResolveApproval'
  | 'aiGetSessionConfigOptions'
  | 'aiSetSessionConfigOption'
  | 'aiGetSessionModes'
  | 'aiSetSessionMode'
  | 'aiInlineComplete'
  | 'aiAgentClassifyTask'
  | 'aiAgentSetNetworkPermission'
  | 'aiWebSearch'
  | 'aiWebFetch'
  | 'aiProposePatch'
  | 'aiApplyPatch'
>;

/**
 * 生成一个无入参的 AI Tauri 服务方法：直接转发到绑定的零参命令。
 * 用于 aiGetConfig / aiTestProvider / aiGetSuggestionPoolCache / aiClearCredentials。
 */
const voidCommand =
  <T>(meta: ICommandMeta, invoke: () => Promise<T>) =>
  () =>
    runCommand(meta, undefined, undefined, () => invoke());

/**
 * 生成一个带入参的 AI Tauri 服务方法：转发 payload + options 到绑定命令。
 * 覆盖绝大多数 AI 命令（接受 payload + 可选 IIpcCallOptions）。
 */
const payloadCommand =
  <P, T>(meta: ICommandMeta, invoke: (payload: P) => Promise<T>) =>
  (payload: P, options?: IIpcCallOptions) =>
    runCommand(meta, payload, options, () => invoke(payload));

export const aiTauriService: TAiTauriService = {
  aiGetConfig: voidCommand(AI_COMMAND_META.aiGetConfig, () => commands.aiGetConfig()),

  aiSaveConfig: payloadCommand(AI_COMMAND_META.aiSaveConfig, (payload) =>
    commands.aiSaveConfig(payload),
  ),

  aiSaveCredentials: payloadCommand(AI_COMMAND_META.aiSaveCredentials, (payload) =>
    commands.aiSaveCredentials(payload),
  ),

  aiClearCredentials: voidCommand(AI_COMMAND_META.aiClearCredentials, async () => {
    await commands.aiClearCredentials();
  }),

  aiTestProvider: voidCommand(AI_COMMAND_META.aiTestProvider, () => commands.aiTestProvider()),

  aiTestProviderConfig: payloadCommand(AI_COMMAND_META.aiTestProviderConfig, (payload) =>
    commands.aiTestProviderConfig(payload),
  ),

  aiConnectProvider: payloadCommand(AI_COMMAND_META.aiConnectProvider, (payload) =>
    commands.aiConnectProvider(payload),
  ),

  aiGenerateConversationTitle: payloadCommand(
    AI_COMMAND_META.aiGenerateConversationTitle,
    (payload) => commands.aiGenerateConversationTitle(payload),
  ),

  aiGetSuggestionPoolCache: voidCommand(AI_COMMAND_META.aiGetSuggestionPoolCache, () =>
    commands.aiGetSuggestionPoolCache(),
  ),

  aiGenerateSuggestionPool: payloadCommand(AI_COMMAND_META.aiGenerateSuggestionPool, (payload) =>
    commands.aiGenerateSuggestionPool(payload),
  ),

  aiChatStream: payloadCommand(AI_COMMAND_META.aiChatStream, (payload) =>
    commands.aiChatStream(payload),
  ),

  aiCancel: payloadCommand(AI_COMMAND_META.aiCancel, async (payload) => {
    await commands.aiCancel(payload);
  }),

  aiResolveApproval: payloadCommand(AI_COMMAND_META.aiResolveApproval, (payload) =>
    commands.aiResolveApproval(payload),
  ),

  aiGetSessionConfigOptions: payloadCommand(AI_COMMAND_META.aiGetSessionConfigOptions, (payload) =>
    commands.aiGetSessionConfigOptions(payload),
  ),

  aiSetSessionConfigOption: payloadCommand(AI_COMMAND_META.aiSetSessionConfigOption, (payload) =>
    commands.aiSetSessionConfigOption(payload),
  ),

  aiGetSessionModes: payloadCommand(AI_COMMAND_META.aiGetSessionModes, (payload) =>
    commands.aiGetSessionModes(payload),
  ),

  aiSetSessionMode: payloadCommand(AI_COMMAND_META.aiSetSessionMode, (payload) =>
    commands.aiSetSessionMode(payload),
  ),

  aiInlineComplete: payloadCommand(AI_COMMAND_META.aiInlineComplete, (payload) =>
    commands.aiInlineComplete(payload),
  ),

  aiAgentClassifyTask: payloadCommand(AI_COMMAND_META.aiAgentClassifyTask, (payload) =>
    commands.aiAgentClassifyTask(payload),
  ),

  aiAgentSetNetworkPermission: payloadCommand(
    AI_COMMAND_META.aiAgentSetNetworkPermission,
    (payload) => commands.aiAgentSetNetworkPermission(payload),
  ),

  aiWebSearch: payloadCommand(AI_COMMAND_META.aiWebSearch, (payload) =>
    commands.aiWebSearch(payload),
  ),

  aiWebFetch: payloadCommand(AI_COMMAND_META.aiWebFetch, (payload) => commands.aiWebFetch(payload)),

  aiProposePatch: payloadCommand(AI_COMMAND_META.aiProposePatch, (payload) =>
    commands.aiProposePatch(payload),
  ),

  aiApplyPatch: payloadCommand(AI_COMMAND_META.aiApplyPatch, (payload) =>
    commands.aiApplyPatch(payload),
  ),
};

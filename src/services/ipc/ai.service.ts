import type {
  AiAgentClassifyTaskPayload,
  AiAgentNetworkPermissionPayload,
  AiApplyPatchRequest,
  AiConfigPayload,
  AiInlineCompletionResult,
  AiProviderConnectionPayload,
  AiSetSeededModelsRequest,
  AiWebSearchInput,
  AiWebSearchPayload,
} from '@/bindings/tauri';
import { tauriService } from '@/services/tauri';
import type {
  IAiAgentClassifyTaskRequest,
  IAiAgentSetNetworkPermissionRequest,
  IAiApplyPatchPayload,
  IAiCancelRequest,
  IAiConversationTitlePayload,
  IAiConversationTitleRequest,
  IAiEnsureAcpSessionRequest,
  IAiInlineCompletionRequest,
  IAiProposePatchPayload,
  IAiProposePatchRequest,
  IAiProviderConnectionRequest,
  IAiProviderTestPayload,
  IAiResolveApprovalRequest,
  IAiSaveConfigRequest,
  IAiSaveCredentialsRequest,
  IAiSessionConfigOptionsPayload,
  IAiSetSessionConfigOptionRequest,
  IAiSuggestionPoolPayload,
  IAiSuggestionPoolRequest,
  IAiWebFetchInput,
  IAiWebFetchPayload,
} from '@/types/ai';
import type { IAcpPermissionRequestPayload } from '@/types/ai/acp-permission.schema';
import type { IAiEditGetDiffPayload, IAiEditGetDiffRequest } from '@/types/ai/edit';
import type {
  IAgentExternalChatRequest,
  IAgentExternalChatResultPayload,
  IAgentSidecarCheckpointRestoreRequest,
  IAgentSidecarHealthPayload,
  IAgentSidecarResponsePayload,
  IAgentSidecarStreamEventPayload,
  IAgentSidecarWarmupPayload,
} from '@/types/ai/sidecar';

export const aiService = {
  sidecarHealth(): Promise<IAgentSidecarHealthPayload> {
    return tauriService.agentSidecarHealth();
  },
  sidecarRestart(): Promise<IAgentSidecarHealthPayload> {
    return tauriService.agentSidecarRestart();
  },
  sidecarWarmup(): Promise<IAgentSidecarWarmupPayload> {
    return tauriService.agentSidecarWarmup();
  },
  /**
   * 读取 Tavily（信息源）API Key：直连 OS keyring（与各 LLM 厂商凭证同源）。
   * 未配置 / 为空时后端回传空串。
   */
  loadTavilyApiKey(): Promise<string> {
    return tauriService.getTavilyApiKey();
  },
  /**
   * 写入 Tavily API Key 到 OS keyring（trim 后为空即清除，由后端处理）。
   * 写入后由调用方显式重启 sidecar，使其下次启动从 keyring 读出并注入子进程环境。
   */
  saveTavilyApiKey(apiKey: string): Promise<void> {
    return tauriService.setTavilyApiKey({ apiKey });
  },
  sidecarExternalChat(
    payload: IAgentExternalChatRequest,
  ): Promise<IAgentExternalChatResultPayload> {
    return tauriService.agentSidecarExternalChat(payload);
  },
  sidecarRestoreCheckpoint(
    payload: IAgentSidecarCheckpointRestoreRequest,
  ): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarRestoreCheckpoint(payload);
  },
  onSidecarStream(
    handler: (payload: IAgentSidecarStreamEventPayload) => void,
  ): Promise<() => void> {
    return tauriService.onAgentSidecarStream(handler);
  },
  onAcpApproval(handler: (payload: IAcpPermissionRequestPayload) => void): Promise<() => void> {
    return tauriService.onAcpApproval(handler);
  },
  resolveAcpApproval(payload: IAiResolveApprovalRequest): Promise<boolean> {
    return tauriService.aiResolveApproval(payload);
  },
  ensureAcpSession(
    payload: IAiEnsureAcpSessionRequest,
  ): Promise<IAiSessionConfigOptionsPayload | null> {
    return tauriService.aiEnsureAcpSession(payload);
  },
  setSessionConfigOption(
    payload: IAiSetSessionConfigOptionRequest,
  ): Promise<IAiSessionConfigOptionsPayload | null> {
    return tauriService.aiSetSessionConfigOption(payload);
  },
  getConfig(): Promise<AiConfigPayload> {
    return tauriService.aiGetConfig();
  },
  saveConfig(payload: IAiSaveConfigRequest): Promise<AiConfigPayload> {
    return tauriService.aiSaveConfig(payload);
  },
  setSeededModels(payload: AiSetSeededModelsRequest): Promise<AiConfigPayload> {
    return tauriService.aiSetSeededModels(payload);
  },
  saveCredentials(payload: IAiSaveCredentialsRequest): Promise<AiConfigPayload> {
    return tauriService.aiSaveCredentials(payload);
  },
  clearCredentials(): Promise<void> {
    return tauriService.aiClearCredentials();
  },
  testProvider(): Promise<IAiProviderTestPayload> {
    return tauriService.aiTestProvider();
  },
  testProviderConfig(payload: IAiProviderConnectionRequest): Promise<IAiProviderTestPayload> {
    return tauriService.aiTestProviderConfig(payload);
  },
  connectProvider(payload: IAiProviderConnectionRequest): Promise<AiProviderConnectionPayload> {
    return tauriService.aiConnectProvider(payload);
  },
  generateConversationTitle(
    payload: IAiConversationTitleRequest,
  ): Promise<IAiConversationTitlePayload> {
    return tauriService.aiGenerateConversationTitle(payload);
  },
  getSuggestionPoolCache(): Promise<IAiSuggestionPoolPayload | null> {
    return tauriService.aiGetSuggestionPoolCache();
  },
  generateSuggestionPool(payload: IAiSuggestionPoolRequest): Promise<IAiSuggestionPoolPayload> {
    return tauriService.aiGenerateSuggestionPool(payload);
  },
  cancel(payload: IAiCancelRequest): Promise<void> {
    return tauriService.aiCancel(payload);
  },
  inlineComplete(payload: IAiInlineCompletionRequest): Promise<AiInlineCompletionResult> {
    return tauriService.aiInlineComplete(payload);
  },
  classifyTask(payload: IAiAgentClassifyTaskRequest): Promise<AiAgentClassifyTaskPayload> {
    return tauriService.aiAgentClassifyTask(payload);
  },
  setNetworkPermission(
    payload: IAiAgentSetNetworkPermissionRequest,
  ): Promise<AiAgentNetworkPermissionPayload> {
    return tauriService.aiAgentSetNetworkPermission(payload);
  },
  webSearch(payload: AiWebSearchInput): Promise<AiWebSearchPayload> {
    return tauriService.aiWebSearch(payload);
  },
  webFetch(payload: IAiWebFetchInput): Promise<IAiWebFetchPayload> {
    return tauriService.aiWebFetch(payload);
  },
  proposePatch(payload: IAiProposePatchRequest): Promise<IAiProposePatchPayload> {
    return tauriService.aiProposePatch(payload);
  },
  applyPatch(payload: AiApplyPatchRequest): Promise<IAiApplyPatchPayload> {
    return tauriService.aiApplyPatch(payload);
  },
  getEditDiff(payload: IAiEditGetDiffRequest): Promise<IAiEditGetDiffPayload> {
    return tauriService.aiEditGetDiff(payload);
  },
};

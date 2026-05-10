import { tauriService } from '@/services/tauri';
import type {
  IAgentSidecarApprovalResolveRequest,
  IAgentSidecarChatRequest,
  IAgentSidecarCheckpointRestoreRequest,
  IAgentSidecarExecuteRequest,
  IAgentSidecarHealthPayload,
  IAgentSidecarPlanApproveRequest,
  IAgentSidecarPlanFinishRequest,
  IAgentSidecarPlanQueryRequest,
  IAgentSidecarPlanRequest,
  IAgentSidecarPlanRejectRequest,
  IAgentSidecarResponsePayload,
  IAgentSidecarStreamEventPayload,
} from '@/types/agent-sidecar';
import type {
  IAiAgentClassifyTaskPayload,
  IAiAgentClassifyTaskRequest,
  IAiAgentNetworkPermissionPayload,
  IAiAgentSetNetworkPermissionRequest,
  IAiApplyPatchPayload,
  IAiApplyPatchRequest,
  IAiBuildIndexPayload,
  IAiBuildIndexRequest,
  IAiChatPayload,
  IAiChatRequest,
  IAiChatStreamEventPayload,
  IAiChatStreamPayload,
  IAiCodeActionRequest,
  IAiCodeActionResult,
  IAiConfigPayload,
  IAiConversationTitlePayload,
  IAiConversationTitleRequest,
  IAiInlineCompletionRequest,
  IAiInlineCompletionResult,
  IAiNarratorRequest,
  IAiNarratorResponse,
  IAiNarratorStreamEventPayload,
  IAiNarratorStreamPayload,
  IAiProposePatchPayload,
  IAiProposePatchRequest,
  IAiProviderConnectionPayload,
  IAiProviderConnectionRequest,
  IAiProviderProfileDetailPayload,
  IAiProviderProfilePayload,
  IAiProviderProfileSwitchRequest,
  IAiProviderTestPayload,
  IAiQueryIndexPayload,
  IAiQueryIndexRequest,
  IAiSaveConfigRequest,
  IAiSaveCredentialsRequest,
  IAiSuggestionPoolPayload,
  IAiSuggestionPoolRequest,
  IAiToolDefinitionPayload,
  IAiWebFetchInput,
  IAiWebFetchPayload,
  IAiWebSearchInput,
  IAiWebSearchPayload,
} from '@/types/ai';
import type {
  IAiEditGetDiffPayload,
  IAiEditGetDiffRequest,
} from '@/types/ai-edit';

export const aiService = {
  sidecarHealth(): Promise<IAgentSidecarHealthPayload> {
    return tauriService.agentSidecarHealth();
  },
  sidecarChat(payload: IAgentSidecarChatRequest): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarChat(payload);
  },
  sidecarPlan(payload: IAgentSidecarPlanRequest): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarPlan(payload);
  },
  sidecarPlanApprove(payload: IAgentSidecarPlanApproveRequest): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarPlanApprove(payload);
  },
  sidecarPlanQuery(payload: IAgentSidecarPlanQueryRequest): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarPlanQuery(payload);
  },
  sidecarPlanReject(payload: IAgentSidecarPlanRejectRequest): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarPlanReject(payload);
  },
  sidecarPlanFinish(payload: IAgentSidecarPlanFinishRequest): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarPlanFinish(payload);
  },
  sidecarExecute(payload: IAgentSidecarExecuteRequest): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarExecute(payload);
  },
  sidecarResolveApproval(
    payload: IAgentSidecarApprovalResolveRequest,
  ): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarResolveApproval(payload);
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
  getConfig(): Promise<IAiConfigPayload> {
    return tauriService.aiGetConfig();
  },
  saveConfig(payload: IAiSaveConfigRequest): Promise<IAiConfigPayload> {
    return tauriService.aiSaveConfig(payload);
  },
  saveCredentials(payload: IAiSaveCredentialsRequest): Promise<IAiConfigPayload> {
    return tauriService.aiSaveCredentials(payload);
  },
  clearCredentials(): Promise<void> {
    return tauriService.aiClearCredentials();
  },
  listProviderProfiles(): Promise<IAiProviderProfilePayload[]> {
    return tauriService.aiListProviderProfiles();
  },
  getProviderProfileDetail(
    payload: IAiProviderProfileSwitchRequest,
  ): Promise<IAiProviderProfileDetailPayload> {
    return tauriService.aiGetProviderProfileDetail(payload);
  },
  switchProviderProfile(payload: IAiProviderProfileSwitchRequest): Promise<IAiConfigPayload> {
    return tauriService.aiSwitchProviderProfile(payload);
  },
  testProvider(): Promise<IAiProviderTestPayload> {
    return tauriService.aiTestProvider();
  },
  testProviderConfig(payload: IAiProviderConnectionRequest): Promise<IAiProviderTestPayload> {
    return tauriService.aiTestProviderConfig(payload);
  },
  connectProvider(payload: IAiProviderConnectionRequest): Promise<IAiProviderConnectionPayload> {
    return tauriService.aiConnectProvider(payload);
  },
  chat(payload: IAiChatRequest, options: { signal?: AbortSignal } = {}): Promise<IAiChatPayload> {
    return tauriService.aiChat(payload, options);
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
  narrateActivity(payload: IAiNarratorRequest): Promise<IAiNarratorResponse> {
    return tauriService.aiNarrateActivity(payload);
  },
  narrateActivityStream(payload: IAiNarratorRequest): Promise<IAiNarratorStreamPayload> {
    return tauriService.aiNarrateActivityStream(payload);
  },
  chatStream(payload: IAiChatRequest): Promise<IAiChatStreamPayload> {
    return tauriService.aiChatStream(payload);
  },
  cancel(payload: { streamId: string }): Promise<void> {
    return tauriService.aiCancel(payload);
  },
  onChatStream(handler: (payload: IAiChatStreamEventPayload) => void): Promise<() => void> {
    return tauriService.onAiChatStream(handler);
  },
  onNarratorStream(
    handler: (payload: IAiNarratorStreamEventPayload) => void,
  ): Promise<() => void> {
    return tauriService.onAiNarratorStream(handler);
  },
  inlineComplete(payload: IAiInlineCompletionRequest): Promise<IAiInlineCompletionResult> {
    return tauriService.aiInlineComplete(payload);
  },
  codeAction(payload: IAiCodeActionRequest): Promise<IAiCodeActionResult> {
    return tauriService.aiCodeAction(payload);
  },
  classifyTask(payload: IAiAgentClassifyTaskRequest): Promise<IAiAgentClassifyTaskPayload> {
    return tauriService.aiAgentClassifyTask(payload);
  },
  setNetworkPermission(
    payload: IAiAgentSetNetworkPermissionRequest,
  ): Promise<IAiAgentNetworkPermissionPayload> {
    return tauriService.aiAgentSetNetworkPermission(payload);
  },
  webSearch(payload: IAiWebSearchInput): Promise<IAiWebSearchPayload> {
    return tauriService.aiWebSearch(payload);
  },
  webFetch(payload: IAiWebFetchInput): Promise<IAiWebFetchPayload> {
    return tauriService.aiWebFetch(payload);
  },
  buildIndex(payload: IAiBuildIndexRequest): Promise<IAiBuildIndexPayload> {
    return tauriService.aiBuildIndex(payload);
  },
  queryIndex(payload: IAiQueryIndexRequest): Promise<IAiQueryIndexPayload> {
    return tauriService.aiQueryIndex(payload);
  },
  proposePatch(payload: IAiProposePatchRequest): Promise<IAiProposePatchPayload> {
    return tauriService.aiProposePatch(payload);
  },
  applyPatch(payload: IAiApplyPatchRequest): Promise<IAiApplyPatchPayload> {
    return tauriService.aiApplyPatch(payload);
  },
  getEditDiff(payload: IAiEditGetDiffRequest): Promise<IAiEditGetDiffPayload> {
    return tauriService.aiEditGetDiff(payload);
  },
  listTools(): Promise<IAiToolDefinitionPayload[]> {
    return tauriService.aiListTools();
  },
};

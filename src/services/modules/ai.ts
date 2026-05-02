import { tauriService } from '@/services/tauri';
import type {
  IAgentSidecarApprovalResolveRequest,
  IAgentSidecarChatRequest,
  IAgentSidecarExecuteRequest,
  IAgentSidecarHealthPayload,
  IAgentSidecarPlanRequest,
  IAgentSidecarResponsePayload,
  IAgentSidecarStreamEventPayload,
} from '@/types/agent-sidecar';
import type {
  IAiEditGetDiffPayload,
  IAiEditGetDiffRequest,
} from '@/types/ai-edit';
import type {
  IAiAgentApprovePlanPayload,
  IAiAgentApprovePlanRequest,
  IAiAgentClassifyTaskPayload,
  IAiAgentClassifyTaskRequest,
  IAiAgentListRunsPayload,
  IAiAgentNetworkPermissionPayload,
  IAiAgentPlanPayload,
  IAiAgentPlanRequest,
  IAiAgentRunIdRequest,
  IAiAgentRunPayload,
  IAiAgentRunPlanRequest,
  IAiAgentRunStepRequest,
  IAiAgentResolveToolConfirmationRequest,
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
  TAiAgentStreamEvent,
  IAiInlineCompletionRequest,
  IAiInlineCompletionResult,
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
  IAiToolDefinitionPayload,
  IAiWebFetchInput,
  IAiWebFetchPayload,
  IAiWebSearchInput,
  IAiWebSearchPayload,
} from '@/types/ai';

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
  sidecarExecute(payload: IAgentSidecarExecuteRequest): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarExecute(payload);
  },
  sidecarResolveApproval(
    payload: IAgentSidecarApprovalResolveRequest,
  ): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarResolveApproval(payload);
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
  chatStream(payload: IAiChatRequest): Promise<IAiChatStreamPayload> {
    return tauriService.aiChatStream(payload);
  },
  cancel(payload: { streamId: string }): Promise<void> {
    return tauriService.aiCancel(payload);
  },
  onChatStream(handler: (payload: IAiChatStreamEventPayload) => void): Promise<() => void> {
    return tauriService.onAiChatStream(handler);
  },
  onAgentStream(handler: (payload: TAiAgentStreamEvent) => void): Promise<() => void> {
    return tauriService.onAiAgentStream(handler);
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
  planTask(payload: IAiAgentPlanRequest): Promise<IAiAgentPlanPayload> {
    return tauriService.aiPlanTask(payload);
  },
  approvePlan(payload: IAiAgentApprovePlanRequest): Promise<IAiAgentApprovePlanPayload> {
    return tauriService.aiAgentApprovePlan(payload);
  },
  runPlan(payload: IAiAgentRunPlanRequest): Promise<IAiAgentRunPayload> {
    return tauriService.aiAgentRunPlan(payload);
  },
  runStep(payload: IAiAgentRunStepRequest): Promise<IAiAgentRunPayload> {
    return tauriService.aiAgentRunStep(payload);
  },
  pauseRun(payload: IAiAgentRunIdRequest): Promise<IAiAgentRunPayload> {
    return tauriService.aiAgentPause(payload);
  },
  resumeRun(payload: IAiAgentRunIdRequest): Promise<IAiAgentRunPayload> {
    return tauriService.aiAgentResume(payload);
  },
  cancelRun(payload: IAiAgentRunIdRequest): Promise<IAiAgentRunPayload> {
    return tauriService.aiAgentCancel(payload);
  },
  getRun(payload: IAiAgentRunIdRequest): Promise<IAiAgentRunPayload> {
    return tauriService.aiAgentGetRun(payload);
  },
  listRuns(): Promise<IAiAgentListRunsPayload> {
    return tauriService.aiAgentListRuns();
  },
  setNetworkPermission(
    payload: IAiAgentSetNetworkPermissionRequest,
  ): Promise<IAiAgentNetworkPermissionPayload> {
    return tauriService.aiAgentSetNetworkPermission(payload);
  },
  resolveToolConfirmation(
    payload: IAiAgentResolveToolConfirmationRequest,
  ): Promise<IAiAgentRunPayload> {
    return tauriService.aiAgentResolveToolConfirmation(payload);
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

import type {
  AiAgentClassifyTaskPayload,
  AiAgentNetworkPermissionPayload,
  AiApplyPatchRequest,
  AiChatStreamPayload,
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
  IAiChatRequest,
  IAiConversationTitlePayload,
  IAiConversationTitleRequest,
  IAiEnsureAcpSessionRequest,
  IAiGetSessionModesRequest,
  IAiInlineCompletionRequest,
  IAiProposePatchPayload,
  IAiProposePatchRequest,
  IAiProviderConnectionRequest,
  IAiProviderTestPayload,
  IAiResolveApprovalRequest,
  IAiSaveConfigRequest,
  IAiSaveCredentialsRequest,
  IAiSessionConfigOptionsPayload,
  IAiSessionModesPayload,
  IAiSetSessionConfigOptionRequest,
  IAiSetSessionModeRequest,
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
  IAgentSidecarApprovalResolveRequest,
  IAgentSidecarAskUserResumeRequest,
  IAgentSidecarChatRequest,
  IAgentSidecarCheckpointRestoreRequest,
  IAgentSidecarHealthPayload,
  IAgentSidecarOrchestratePayload,
  IAgentSidecarOrchestrateRequest,
  IAgentSidecarOrchestrateResumeRequest,
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
    return tauriService.agentSidecarWarmup
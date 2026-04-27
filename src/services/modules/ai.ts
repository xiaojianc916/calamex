import { tauriService } from '@/services/tauri';
import type {
  IAiChatPayload,
  IAiChatRequest,
  IAiChatStreamEventPayload,
  IAiChatStreamPayload,
  IAiAgentPlanPayload,
  IAiAgentPlanRequest,
  IAiApplyPatchPayload,
  IAiApplyPatchRequest,
  IAiBuildIndexPayload,
  IAiBuildIndexRequest,
  IAiCodeActionRequest,
  IAiCodeActionResult,
  IAiConfigPayload,
  IAiInlineCompletionRequest,
  IAiInlineCompletionResult,
  IAiProviderTestPayload,
  IAiProposePatchPayload,
  IAiProposePatchRequest,
  IAiQueryIndexPayload,
  IAiQueryIndexRequest,
  IAiSaveCredentialsRequest,
  IAiSaveConfigRequest,
  IAiToolDefinitionPayload,
} from '@/types/ai';

export const aiService = {
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
  testProvider(): Promise<IAiProviderTestPayload> {
    return tauriService.aiTestProvider();
  },
  chat(payload: IAiChatRequest, options: { signal?: AbortSignal } = {}): Promise<IAiChatPayload> {
    return tauriService.aiChat(payload, options);
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
  inlineComplete(payload: IAiInlineCompletionRequest): Promise<IAiInlineCompletionResult> {
    return tauriService.aiInlineComplete(payload);
  },
  codeAction(payload: IAiCodeActionRequest): Promise<IAiCodeActionResult> {
    return tauriService.aiCodeAction(payload);
  },
  planTask(payload: IAiAgentPlanRequest): Promise<IAiAgentPlanPayload> {
    return tauriService.aiPlanTask(payload);
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
  listTools(): Promise<IAiToolDefinitionPayload[]> {
    return tauriService.aiListTools();
  },
};

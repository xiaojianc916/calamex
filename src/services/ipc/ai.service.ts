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
  IAgentSidecarPlanRejectRequest,
  IAgentSidecarPlanReplanRequest,
  IAgentSidecarPlanRequest,
  IAgentSidecarPlanValidateRequest,
  IAgentSidecarResponsePayload,
  IAgentSidecarStreamEventPayload,
  IAgentSidecarWarmupPayload,
} from '@/types/ai/sidecar';
import type {
  IAiAgentClassifyTaskPayload,
  IAiAgentClassifyTaskRequest,
  IAiAgentNetworkPermissionPayload,
  IAiAgentSetNetworkPermissionRequest,
  IAiApplyPatchPayload,
  IAiApplyPatchRequest,
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
  IAiProposePatchPayload,
  IAiProposePatchRequest,
  IAiProviderConnectionPayload,
  IAiProviderConnectionRequest,
  IAiProviderTestPayload,
  IAiSaveConfigRequest,
  IAiSaveCredentialsRequest,
  IAiSuggestionPoolPayload,
  IAiSuggestionPoolRequest,
  IAiWebFetchInput,
  IAiWebFetchPayload,
  IAiWebSearchInput,
  IAiWebSearchPayload,
} from '@/types/ai';
import type {
  IAiEditGetDiffPayload,
  IAiEditGetDiffRequest,
} from '@/types/ai/edit';
import { normalizeFileSystemPath } from '@/utils/path';

const SIDECAR_DOTENV_RELATIVE_PATH = 'agent-sidecar/.env';
const TAVILY_API_KEY_ENV = 'TAVILY_API_KEY';
const MISSING_FILE_ERROR_PATTERN = /不存在|找不到|not found|cannot find|no such file/iu;

const resolveSidecarDotenvPath = (workspaceRootPath: string): string =>
  `${normalizeFileSystemPath(workspaceRootPath, {
    collapseDuplicateSeparators: true,
    trimTrailingSeparator: true,
    foldWindowsCase: false,
  })}/${SIDECAR_DOTENV_RELATIVE_PATH}`;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildDotenvLinePattern = (key: string): RegExp =>
  new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=.*$`, 'u');

const readOptionalScript = async (path: string) => {
  try {
    return await tauriService.loadScript(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (MISSING_FILE_ERROR_PATTERN.test(message)) {
      return null;
    }
    throw error;
  }
};

const parseDotenvValue = (rawValue: string): string => {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return '';
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed.replace(/\s+#.*$/u, '');
};

const readDotenvAssignment = (content: string, key: string): string => {
  const linePattern = new RegExp(
    `^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*(.*)\\s*$`,
    'u',
  );

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = line.match(linePattern);
    if (match) {
      return parseDotenvValue(match[1] ?? '');
    }
  }

  return '';
};

const formatDotenvValue = (value: string): string =>
  /[\s#"']/u.test(value) ? JSON.stringify(value) : value;

const updateDotenvAssignment = (
  content: string,
  key: string,
  nextValue: string | null,
): string => {
  const lineBreak = content.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = content.endsWith('\n');
  const linePattern = buildDotenvLinePattern(key);
  const nextLines: string[] = [];
  let replaced = false;

  for (const line of content.split(/\r?\n/u)) {
    if (linePattern.test(line)) {
      if (!replaced && nextValue !== null) {
        nextLines.push(`${key}=${formatDotenvValue(nextValue)}`);
        replaced = true;
      }
      continue;
    }

    if (!line && !content) {
      continue;
    }

    nextLines.push(line);
  }

  if (!replaced && nextValue !== null) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1]?.trim() !== '') {
      nextLines.push('');
    }
    nextLines.push(`${key}=${formatDotenvValue(nextValue)}`);
  }

  let nextContent = nextLines.join(lineBreak);

  if (!nextContent) {
    return '';
  }

  if (hadTrailingNewline || nextValue !== null) {
    nextContent = `${nextContent}${lineBreak}`;
  }

  return nextContent;
};

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
  async loadTavilyApiKey(workspaceRootPath: string): Promise<string> {
    const sidecarDotenvPath = resolveSidecarDotenvPath(workspaceRootPath);
    const script = await readOptionalScript(sidecarDotenvPath);
    return script ? readDotenvAssignment(script.content, TAVILY_API_KEY_ENV) : '';
  },
  async saveTavilyApiKey(workspaceRootPath: string, apiKey: string): Promise<void> {
    const sidecarDotenvPath = resolveSidecarDotenvPath(workspaceRootPath);
    const script = await readOptionalScript(sidecarDotenvPath);
    const nextValue = apiKey.trim();

    if (!script && !nextValue) {
      return;
    }

    await tauriService.saveScript({
      path: sidecarDotenvPath,
      content: updateDotenvAssignment(
        script?.content ?? '',
        TAVILY_API_KEY_ENV,
        nextValue || null,
      ),
      encoding: script?.encoding ?? 'utf-8',
    });
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
  sidecarPlanValidate(payload: IAgentSidecarPlanValidateRequest): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarPlanValidate(payload);
  },
  sidecarPlanReplan(payload: IAgentSidecarPlanReplanRequest): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarPlanReplan(payload);
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
  testProvider(): Promise<IAiProviderTestPayload> {
    return tauriService.aiTestProvider();
  },
  testProviderConfig(payload: IAiProviderConnectionRequest): Promise<IAiProviderTestPayload> {
    return tauriService.aiTestProviderConfig(payload);
  },
  connectProvider(payload: IAiProviderConnectionRequest): Promise<IAiProviderConnectionPayload> {
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
  proposePatch(payload: IAiProposePatchRequest): Promise<IAiProposePatchPayload> {
    return tauriService.aiProposePatch(payload);
  },
  applyPatch(payload: IAiApplyPatchRequest): Promise<IAiApplyPatchPayload> {
    return tauriService.aiApplyPatch(payload);
  },
  getEditDiff(payload: IAiEditGetDiffRequest): Promise<IAiEditGetDiffPayload> {
    return tauriService.aiEditGetDiff(payload);
  },
};

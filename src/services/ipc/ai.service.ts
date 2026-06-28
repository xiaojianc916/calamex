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
import { escapeRegExp } from '@/utils/core/regex';
import { normalizeFileSystemPath } from '@/utils/file/path';

/**
 * Tavily（信息源）API Key 的落盘策略 —— 与API Key 不同的「受控例外」。
 *
 * API Key 走 `ai_save_credentials`/`ai_connect_provider` 存入操作系统 keyring，
 * store 与前端不持有明文。但 Tavily Key 由 agent-sidecar（独立子进程）在启动时从
 * **进程环境变量**读取，拿不到桌面端的 OS keyring，因此只能以明文写入 sidecar 的
 * `agent-sidecar/.env`（下方常量）。
 *
 * 安全前提：仓库根 `.gitignore` 已忽略 `.env` 与 `.env.*`，该明文 Key 不会被提交，
 * 只存在于用户本地工作区。改动此处时务必维持上述 gitignore 约束，不要把 Tavily Key
 * 写到任何会被纳入版本控制的路径。
 */
const SIDECAR_DOTENV_RELATIVE_PATH = 'agent-sidecar/.env';
const TAVILY_API_KEY_ENV = 'TAVILY_API_KEY';
const MISSING_FILE_ERROR_PATTERN = /不存在|找不到|not found|cannot find|no such file/iu;

const resolveSidecarDotenvPath = (workspaceRootPath: string): string =>
  `${normalizeFileSystemPath(workspaceRootPath, {
    collapseDuplicateSeparators: true,
    trimTrailingSeparator: true,
    foldWindowsCase: false,
  })}/${SIDECAR_DOTENV_RELATIVE_PATH}`;

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
  const linePattern = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*(.*)\\s*$`, 'u');

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

const updateDotenvAssignment = (content: string, key: string, nextValue: string | null): string => {
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
      workspaceRootPath,
      content: updateDotenvAssignment(script?.content ?? '', TAVILY_API_KEY_ENV, nextValue || null),
      encoding: script?.encoding ?? 'utf-8',
    });
  },
  sidecarChat(payload: IAgentSidecarChatRequest): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarChat(payload);
  },
  sidecarExternalChat(
    payload: IAgentExternalChatRequest,
  ): Promise<IAgentExternalChatResultPayload> {
    return tauriService.agentSidecarExternalChat(payload);
  },
  sidecarResolveApproval(
    payload: IAgentSidecarApprovalResolveRequest,
  ): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarResolveApproval(payload);
  },
  sidecarResolveAskUser(
    payload: IAgentSidecarAskUserResumeRequest,
  ): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarResolveAskUser(payload);
  },
  sidecarRestoreCheckpoint(
    payload: IAgentSidecarCheckpointRestoreRequest,
  ): Promise<IAgentSidecarResponsePayload> {
    return tauriService.agentSidecarRestoreCheckpoint(payload);
  },
  sidecarOrchestrate(
    payload: IAgentSidecarOrchestrateRequest,
  ): Promise<IAgentSidecarOrchestratePayload> {
    return tauriService.agentSidecarOrchestrate(payload);
  },
  sidecarOrchestrateResume(
    payload: IAgentSidecarOrchestrateResumeRequest,
  ): Promise<IAgentSidecarOrchestratePayload> {
    return tauriService.agentSidecarOrchestrateResume(payload);
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
  ensureAcpSession(payload: IAiEnsureAcpSessionRequest): Promise<void> {
    return tauriService.aiEnsureAcpSession(payload);
  },
  setSessionConfigOption(
    payload: IAiSetSessionConfigOptionRequest,
  ): Promise<IAiSessionConfigOptionsPayload | null> {
    return tauriService.aiSetSessionConfigOption(payload);
  },
  getSessionModes(payload: IAiGetSessionModesRequest): Promise<IAiSessionModesPayload | null> {
    return tauriService.aiGetSessionModes(payload);
  },
  setSessionMode(payload: IAiSetSessionModeRequest): Promise<boolean> {
    return tauriService.aiSetSessionMode(payload);
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
  chatStream(payload: IAiChatRequest): Promise<AiChatStreamPayload> {
    return tauriService.aiChatStream(payload);
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

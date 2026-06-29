// d1s2.mjs — D1 切片 2:useAiAssistant.ts 收敛到唯一标准管线
// 删:legacy 三件套前端实现 + plan 子系统接线 + 连带孤儿;import 按真实使用面收敛
// 跑完执行 pnpm typecheck,把残留发我(预期落在 AiAssistantPanel.vue / store / spec)
import fs from 'node:fs';
import path from 'node:path';

const REL = 'src/composables/ai/useAiAssistant.ts';
const p = path.join(process.cwd(), REL);
const raw = fs.readFileSync(p, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let t = raw.split('\r\n').join('\n');

const L = (arr) => arr.join('\n');

function replaceOnce(from, to, label) {
  const i = t.indexOf(from);
  if (i === -1) throw new Error('[D1-S2] 锚点未命中: ' + label);
  if (t.indexOf(from, i + from.length) !== -1) throw new Error('[D1-S2] 锚点多次命中: ' + label);
  t = t.slice(0, i) + to + t.slice(i + from.length);
}
function cutBetween(from, to, label) {
  const i = t.indexOf(from);
  if (i === -1) throw new Error('[D1-S2] from 未命中: ' + label);
  if (t.indexOf(from, i + from.length) !== -1) throw new Error('[D1-S2] from 多次命中: ' + label);
  const j = t.indexOf(to);
  if (j === -1) throw new Error('[D1-S2] to 未命中: ' + label);
  if (t.indexOf(to, j + to.length) !== -1) throw new Error('[D1-S2] to 多次命中: ' + label);
  if (j <= i) throw new Error('[D1-S2] to 在 from 之前: ' + label);
  t = t.slice(0, i) + t.slice(j);
}
const del = (anchor, label) => replaceOnce(anchor, '', label);

// ── 1) imports 收敛 ────────────────────────────────────────────────
replaceOnce(
  L([
    'import {',
    '  buildAiAgentPatchSummaryFromAedDiffs,',
    '  buildAiAgentPatchSummaryFromApplyResult,',
    '  buildAiPatchSetFromAedDiff,',
    '  mergeAiAgentPatchSummaries,',
    '  parseAiAedPatchRef,',
    "} from '@/components/business/ai/edit/patch-summary';",
  ]),
  "import { parseAiAedPatchRef } from '@/components/business/ai/edit/patch-summary';",
  'import patch-summary',
);

del(
  L([
    'import {',
    '  buildAskUserResumeRequest,',
    '  extractPendingAskUser,',
    '  type IAgentSidecarPendingAskUser,',
    "} from '@/composables/ai/sidecar-ask-user';",
    '',
  ]),
  'import sidecar-ask-user',
);

replaceOnce(
  L([
    'import {',
    '  extractVisibleAgentRuntimeEvents,',
    '  projectSidecarEventsToToolState,',
    '  projectSidecarExecuteResponse,',
    "} from '@/composables/ai/sidecar-events';",
  ]),
  L([
    'import {',
    '  extractVisibleAgentRuntimeEvents,',
    '  projectSidecarEventsToToolState,',
    "} from '@/composables/ai/sidecar-events';",
  ]),
  'import sidecar-events',
);

del("import { useAiAgentPlan } from '@/composables/ai/useAiAgentPlan';\n", 'import useAiAgentPlan');

del("import { buildCurrentFileReference } from '@/services/ipc/ai-context.service';\n", 'import ai-context.service');

replaceOnce(
  L([
    'import type {',
    '  IAiAgentPatchSummary,',
    '  IAiApplyPatchMetadata,',
    '  IAiAttachedFile,',
    '  IAiChatMessage,',
    '  IAiContextReference,',
    '  IAiImageAttachmentPreview,',
    '  IAiPatchSet,',
    '  IAiToolConfirmationRequest,',
    '  TAiToolConfirmationDecision,',
    "} from '@/types/ai';",
  ]),
  L([
    'import type {',
    '  IAiAgentPatchSummary,',
    '  IAiAttachedFile,',
    '  IAiChatMessage,',
    '  IAiContextReference,',
    '  IAiImageAttachmentPreview,',
    '  IAiPatchSet,',
    "} from '@/types/ai';",
  ]),
  'import @/types/ai',
);

del("import type { IAiEditGetDiffPayload, IAiEditOperation } from '@/types/ai/edit';\n", 'import @/types/ai/edit');

replaceOnce(
  L([
    'import type {',
    '  IAgentSidecarMessage,',
    '  IAskUserResult,',
    '  TAgentBackendKind,',
    '  TAgentRuntimeEvent,',
    '  TAgentUiEvent,',
    "} from '@/types/ai/sidecar';",
  ]),
  L([
    'import type {',
    '  TAgentBackendKind,',
    '  TAgentRuntimeEvent,',
    '  TAgentUiEvent,',
    "} from '@/types/ai/sidecar';",
  ]),
  'import @/types/ai/sidecar',
);

del("import { areFileSystemPathsEqual, normalizeFileSystemPath } from '@/utils/file/path';\n", 'import @/utils/file/path');

del("import { runShellCheckForAppliedPatch } from './useAiAssistant.shellcheck';\n", 'import shellcheck');

replaceOnce(
  L([
    'import {',
    '  createSidecarLiveEventBuffer,',
    '  getLatestSidecarLiveEvents,',
    '  getOperationAppliedTime,',
    '  hasMeaningfulAssistantText,',
    '  type ISidecarAnswerStreamMetadata,',
    '  isAiEditOperationEntry,',
    '  mapToolConfirmationDecisionToSidecarDecision,',
    '  resolveSidecarDoneStreamTokenSnapshot,',
    '  resolveSidecarToolProjectionStatus,',
    '  resolveSidecarWaitingStreamStatus,',
    "} from './useAiAssistant.stream';",
  ]),
  L([
    'import {',
    '  createSidecarLiveEventBuffer,',
    '  getLatestSidecarLiveEvents,',
    '  hasMeaningfulAssistantText,',
    '  resolveSidecarDoneStreamTokenSnapshot,',
    "} from './useAiAssistant.stream';",
  ]),
  'import stream',
);

// ── 2) 模块级常量 / 接口 ───────────────────────────────────────────
del('const SIDECAR_EXPLICIT_CONTEXT_MESSAGE_LIMIT = 12;\n\n', 'const SIDECAR_EXPLICIT_CONTEXT_MESSAGE_LIMIT');
del('const AI_EDIT_ROLLBACK_TIMELINE_LIMIT = 24;\n', 'const AI_EDIT_ROLLBACK_TIMELINE_LIMIT');

del(
  L(['interface IActiveAgentPatchTarget {', '  runId: string;', '  stepId: string;', '}', '', '']),
  'interface IActiveAgentPatchTarget',
);
del(
  L([
    'interface ISidecarPatchApplyResult {',
    '  appliedPaths: string[];',
    '  runtimeEvents: TAgentRuntimeEvent[];',
    '  patches: IAiPatchSet[];',
    '  summaries: IAiAgentPatchSummary[];',
    '}',
    '',
    '',
  ]),
  'interface ISidecarPatchApplyResult',
);
del(
  L([
    'interface IAedDiffPatchState {',
    '  patches: IAiPatchSet[];',
    '  changedFilesSummary: IAiAgentPatchSummary | null;',
    '}',
    '',
    '',
  ]),
  'interface IAedDiffPatchState',
);

// ── 3) agentPlan 实例 + return 出口 ────────────────────────────────
del('  const agentPlan = useAiAgentPlan();\n', 'const agentPlan = useAiAgentPlan()');
del('    agentPlan,\n', 'return: agentPlan');
replaceOnce(
  L([
    '    restoreConversationCheckpoint,',
    '    resolveSidecarToolConfirmation,',
    '    resolveSidecarUserQuestion,',
    '    clearConversation,',
  ]),
  L(['    restoreConversationCheckpoint,', '    clearConversation,']),
  'return: resolve*',
);

// ── 4) agentPlan.resetPlan() 调用点 ────────────────────────────────
replaceOnce(
  L(['      activeAgentMessageId.value = null;', '      agentPlan.resetPlan();', "      errorMessage.value = '';"]),
  L(['      activeAgentMessageId.value = null;', "      errorMessage.value = '';"]),
  'resetPlan@restoreConversationCheckpoint',
);
replaceOnce(
  L(['    conversationStore.clearActiveThread();', '    resetConversationUiState();', '    agentPlan.resetPlan();', '  };']),
  L(['    conversationStore.clearActiveThread();', '    resetConversationUiState();', '  };']),
  'resetPlan@clearConversation',
);
replaceOnce(
  L(['      resetConversationUiState();', '      agentPlan.resetPlan();', '    }']),
  L(['      resetConversationUiState();', '    }']),
  'resetPlan@deleteConversation',
);
replaceOnce(
  L(['    conversationStore.startNewThread();', '    resetConversationUiState();', '    agentPlan.resetPlan();', '  };']),
  L(['    conversationStore.startNewThread();', '    resetConversationUiState();', '  };']),
  'resetPlan@startNewConversation',
);

// ── 5) 删除 legacy 函数/接口体(按 KEEP 边界整段切除) ───────────────
cutBetween(
  '  const persistSidecarToolConfirmation = (',
  '  const clearSidecarToolConfirmation = (confirmationId?: string): void => {',
  'persistSidecarToolConfirmation',
);
cutBetween(
  '  const persistSidecarUserQuestion = (',
  '  const clearSidecarUserQuestion = (requestId?: string): void => {',
  'persistSidecarUserQuestion',
);
cutBetween(
  '  const resolveActiveAgentPatchTarget = (): IActiveAgentPatchTarget | null => {',
  '  const getAssistantEntry = (messageId: string): IAiThreadAssistantMessageEntry | null => {',
  'resolveActiveAgentPatchTarget+buildActiveAgentPatchMetadata',
);
cutBetween(
  '  const operationTouchesChangedPath = (',
  '  const mapSidecarToolCallStatusToStepStatus = (',
  'operationTouchesChangedPath..loadAedDiffPatchStateForChangedFiles',
);
cutBetween(
  '  const appendRuntimeTimelineEvents = (events: readonly TAgentUiEvent[]): void => {',
  '  const buildLiveAppliedPatchState = (',
  'appendRuntimeTimelineEvents+toSidecarMessages+applySidecarPatchSets',
);
cutBetween(
  '  interface IFinalizeSidecarTurnContext {',
  '  const failSidecarAgentMessage = (messageId: string, message: string): void => {',
  'IFinalizeSidecarTurnContext+finalizeSidecarTurn',
);
cutBetween(
  '  const executeSidecarAgentRequest = async (',
  L(['  // -----------------------------------------------------------------------', '  // Computed']),
  'executeSidecarAgentRequest+resolveSidecarToolConfirmation+resolveSidecarUserQuestion',
);
cutBetween(
  '  const executeAiRequest = async (',
  '  const restoreConversationCheckpoint = async (checkpointId: string): Promise<void> => {',
  'executeAiRequest(+stale section comment)',
);
cutBetween(
  '  const buildSidecarToolReferences = (): IAiContextReference[] => {',
  L(['  // -----------------------------------------------------------------------', '  // Quick actions / attachments']),
  'buildSidecarToolReferences+buildSidecarContextReferences',
);

// ── write ──────────────────────────────────────────────────────────
fs.writeFileSync(p, eol === '\r\n' ? t.split('\n').join('\r\n') : t, 'utf8');
console.log('✓ 改写: ' + REL + '  (EOL=' + (eol === '\r\n' ? 'CRLF' : 'LF') + ')');
console.log('[D1-S2] 完成。下一步:pnpm typecheck —— 把残留贴给我,我出切片 3。');
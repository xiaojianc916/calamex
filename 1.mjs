// apply-kimi-modes.mjs
// 当使用 Kimi Code 时，模式切换改为 Kimi 内置 ACP session modes（参照 agent-client-protocol
// session-modes 协议），而非硬编码 chat/agent/plan。后端命令(ai_get_session_modes /
// ai_set_session_mode)与 specta 绑定均已就绪，本脚本只补前端：新增投影/composable/service
// /tauri 包装/类型/事件/UI，并把 Rust ui_event.rs 接上 current_mode_update（回灌）。
// 幂等：每条编辑带 marker，已应用则跳过；每个 old 必须在文件中恰好匹配 1 次。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DRY = process.argv.includes("--dry");
const ROOT = process.cwd();
const j = (...lines) => lines.join("\n");

/* ---------------------------------------------------------------- new files */
const NEW_FILES = [
  {
    file: "src/components/business/ai/thread/projection/from-acp-session-modes.ts",
    content: `import type { IAcpSessionMode, IAcpSessionModesState } from '@/types/ai/sidecar';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 解析单个 SessionMode（{ id, name, description? }）。缺 id/name 时返回 null。 */
function parseSessionMode(raw: unknown): IAcpSessionMode | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw.id);
  const name = readString(raw.name);
  if (id === null || name === null) return null;
  const mode: IAcpSessionMode = { id, name };
  const description = readOptionalString(raw.description);
  if (description !== undefined) mode.description = description;
  return mode;
}

/** 解析 SessionMode[]。非数组 => null；逐项过滤无效与重复 id。 */
function parseSessionModeList(raw: unknown): IAcpSessionMode[] | null {
  if (!Array.isArray(raw)) return null;
  const modes: IAcpSessionMode[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const mode = parseSessionMode(entry);
    if (mode === null) continue;
    if (seen.has(mode.id)) continue;
    seen.add(mode.id);
    modes.push(mode);
  }
  return modes;
}

/**
 * 从 ai_get_session_modes 的原始 modes（ACP SessionModeState）解析为 VM。
 * 非对象（含 null）=> null；availableModes 非数组 => null；合法但为空 =>
 * { currentModeId, availableModes: [] }（已加载、agent 未公示模式）。
 */
export function parseAcpSessionModesState(raw: unknown): IAcpSessionModesState | null {
  if (!isRecord(raw)) return null;
  const availableModes = parseSessionModeList(raw.availableModes);
  if (availableModes === null) return null;
  const currentModeId = readString(raw.currentModeId);
  return { currentModeId, availableModes };
}

/**
 * 应用 current_mode_update：仅回灌 currentModeId（agent 回合中自行切换模式时），
 * 不触碰 availableModes（沿用 ai_get_session_modes 拉取的完整列表）。state 为 null 时不动。
 */
export function applyAcpCurrentModeUpdate(
  state: IAcpSessionModesState | null,
  currentModeId: string | null,
): IAcpSessionModesState | null {
  if (state === null) return null;
  return { ...state, currentModeId };
}
`,
  },
  {
    file: "src/composables/ai/useAcpSessionModes.ts",
    content: `import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';

import {
  applyAcpCurrentModeUpdate,
  parseAcpSessionModesState,
} from '@/components/business/ai/thread/projection/from-acp-session-modes';
import { aiService } from '@/services/ipc/ai.service';
import type { IAcpSessionMode, IAcpSessionModesState } from '@/types/ai/sidecar';

export interface IUseAcpSessionModesReturn {
  state: Ref<IAcpSessionModesState | null>;
  modes: ComputedRef<IAcpSessionMode[]>;
  currentModeId: ComputedRef<string | null>;
  hasModes: ComputedRef<boolean>;
  isSwitching: Ref<boolean>;
  loadModes: (threadId: string) => Promise<void>;
  selectMode: (threadId: string, modeId: string) => Promise<boolean>;
  applyCurrentModeUpdate: (currentModeId: string | null) => void;
  reset: () => void;
}

/**
 * ACP session modes 选择器 composable（镜像 useAcpSessionConfigOptions 的加载/乐观切换/回滚结构）。
 * - loadModes：拉取并解析，await 期间 thread 切换则丢弃过期结果。
 * - selectMode：乐观更新 currentModeId，IPC 返回 false 或抛错则回滚。
 * - applyCurrentModeUpdate：current_mode_update 事件仅回灌 currentModeId。
 * 复用 Kimi 内置模式语义（绝不本地伪造 chat/agent/plan）。
 */
export function useAcpSessionModes(): IUseAcpSessionModesReturn {
  const state = ref<IAcpSessionModesState | null>(null);
  const isSwitching = ref(false);

  // 最近一次 loadModes 的目标 thread：用于丢弃过期（thread 已切换）的异步结果。
  let activeThreadId: string | null = null;

  const modes = computed<IAcpSessionMode[]>(() => state.value?.availableModes ?? []);
  const currentModeId = computed<string | null>(() => state.value?.currentModeId ?? null);
  const hasModes = computed(() => modes.value.length > 0);

  async function loadModes(threadId: string): Promise<void> {
    activeThreadId = threadId;
    const payload = await aiService.getSessionModes({ threadId });
    if (activeThreadId !== threadId) return;
    state.value = payload ? parseAcpSessionModesState(payload.modes) : null;
  }

  async function selectMode(threadId: string, modeId: string): Promise<boolean> {
    const current = state.value;
    if (current === null) return false;
    if (current.currentModeId === modeId) return true;
    // 越界保护：modeId 必须是 agent 公示的合法模式。
    if (!current.availableModes.some((mode) => mode.id === modeId)) return false;

    const previous = current;
    state.value = { ...current, currentModeId: modeId };
    isSwitching.value = true;
    try {
      const ok = await aiService.setSessionMode({ threadId, modeId });
      if (!ok) {
        state.value = previous;
        return false;
      }
      return true;
    } catch (error) {
      state.value = previous;
      throw error;
    } finally {
      isSwitching.value = false;
    }
  }

  function applyCurrentModeUpdate(currentModeId: string | null): void {
    state.value = applyAcpCurrentModeUpdate(state.value, currentModeId);
  }

  function reset(): void {
    state.value = null;
    isSwitching.value = false;
    activeThreadId = null;
  }

  return {
    state,
    modes,
    currentModeId,
    hasModes,
    isSwitching,
    loadModes,
    selectMode,
    applyCurrentModeUpdate,
    reset,
  };
}
`,
  },
];

/* -------------------------------------------------------------------- edits */
const EDITS = [
  /* ---- src/types/ai/index.ts : 新增 modes 请求/负载类型 ---- */
  {
    file: "src/types/ai/index.ts",
    label: "types/ai: IAiGetSessionModesRequest / IAiSetSessionModeRequest / IAiSessionModesPayload",
    marker: "IAiGetSessionModesRequest",
    old: j(
      "export interface IAiSessionConfigOptionsPayload {",
      "  configOptions: unknown;",
      "}",
    ),
    new: j(
      "export interface IAiSessionConfigOptionsPayload {",
      "  configOptions: unknown;",
      "}",
      "",
      "/**",
      " * ACP 会话模式查询 / 切换请求与负载（session/set_mode 协议）。",
      " * thread 维度；与生成绑定 AiGetSessionModesRequest / AiSetSessionModeRequest /",
      " * AiSessionModesPayload 结构一致（全 camelCase、全必填）。modeId 为 ACP SessionModeId 原值",
      " * 逐字透传，跨层不做语义映射。modes 为 ACP SessionModeState（currentModeId + availableModes）",
      " * 原始负载逐字透传（形状 unknown），由前端 ACL（from-acp-session-modes）解析为选择器 VM。",
      " */",
      "export interface IAiGetSessionModesRequest {",
      "  threadId: string;",
      "}",
      "",
      "export interface IAiSetSessionModeRequest {",
      "  threadId: string;",
      "  modeId: string;",
      "}",
      "",
      "export interface IAiSessionModesPayload {",
      "  modes: unknown;",
      "}",
    ),
  },

  /* ---- src/types/tauri/index.ts : 导入 + ITauriService 方法 ---- */
  {
    file: "src/types/tauri/index.ts",
    label: "types/tauri: import IAiGetSessionModesRequest",
    marker: "  IAiGetSessionModesRequest,",
    old: j("  IAiGetSessionConfigOptionsRequest,", "  IAiInlineCompletionRequest,"),
    new: j(
      "  IAiGetSessionConfigOptionsRequest,",
      "  IAiGetSessionModesRequest,",
      "  IAiInlineCompletionRequest,",
    ),
  },
  {
    file: "src/types/tauri/index.ts",
    label: "types/tauri: import IAiSessionModesPayload / IAiSetSessionModeRequest",
    marker: "  IAiSessionModesPayload,",
    old: j(
      "  IAiSessionConfigOptionsPayload,",
      "  IAiSetSessionConfigOptionRequest,",
      "  IAiSuggestionPoolPayload,",
    ),
    new: j(
      "  IAiSessionConfigOptionsPayload,",
      "  IAiSessionModesPayload,",
      "  IAiSetSessionConfigOptionRequest,",
      "  IAiSetSessionModeRequest,",
      "  IAiSuggestionPoolPayload,",
    ),
  },
  {
    file: "src/types/tauri/index.ts",
    label: "types/tauri: ITauriService.aiGetSessionModes / aiSetSessionMode",
    marker: "aiGetSessionModes(",
    old: j(
      "  aiSetSessionConfigOption(payload: IAiSetSessionConfigOptionRequest): Promise<boolean>;",
      "  aiInlineComplete(payload: IAiInlineCompletionRequest): Promise<AiInlineCompletionResult>;",
    ),
    new: j(
      "  aiSetSessionConfigOption(payload: IAiSetSessionConfigOptionRequest): Promise<boolean>;",
      "  aiGetSessionModes(",
      "    payload: IAiGetSessionModesRequest,",
      "  ): Promise<IAiSessionModesPayload | null>;",
      "  aiSetSessionMode(payload: IAiSetSessionModeRequest): Promise<boolean>;",
      "  aiInlineComplete(payload: IAiInlineCompletionRequest): Promise<AiInlineCompletionResult>;",
    ),
  },

  /* ---- src/services/ipc/ai.service.ts : 导入 + aiService 方法 ---- */
  {
    file: "src/services/ipc/ai.service.ts",
    label: "ai.service: import IAiGetSessionModesRequest",
    marker: "  IAiGetSessionModesRequest,",
    old: j("  IAiGetSessionConfigOptionsRequest,", "  IAiInlineCompletionRequest,"),
    new: j(
      "  IAiGetSessionConfigOptionsRequest,",
      "  IAiGetSessionModesRequest,",
      "  IAiInlineCompletionRequest,",
    ),
  },
  {
    file: "src/services/ipc/ai.service.ts",
    label: "ai.service: import IAiSessionModesPayload / IAiSetSessionModeRequest",
    marker: "  IAiSessionModesPayload,",
    old: j(
      "  IAiSessionConfigOptionsPayload,",
      "  IAiSetSessionConfigOptionRequest,",
      "  IAiSuggestionPoolPayload,",
    ),
    new: j(
      "  IAiSessionConfigOptionsPayload,",
      "  IAiSessionModesPayload,",
      "  IAiSetSessionConfigOptionRequest,",
      "  IAiSetSessionModeRequest,",
      "  IAiSuggestionPoolPayload,",
    ),
  },
  {
    file: "src/services/ipc/ai.service.ts",
    label: "ai.service: getSessionModes / setSessionMode",
    marker: "  getSessionModes(",
    old: j(
      "  setSessionConfigOption(payload: IAiSetSessionConfigOptionRequest): Promise<boolean> {",
      "    return tauriService.aiSetSessionConfigOption(payload);",
      "  },",
    ),
    new: j(
      "  setSessionConfigOption(payload: IAiSetSessionConfigOptionRequest): Promise<boolean> {",
      "    return tauriService.aiSetSessionConfigOption(payload);",
      "  },",
      "  getSessionModes(payload: IAiGetSessionModesRequest): Promise<IAiSessionModesPayload | null> {",
      "    return tauriService.aiGetSessionModes(payload);",
      "  },",
      "  setSessionMode(payload: IAiSetSessionModeRequest): Promise<boolean> {",
      "    return tauriService.aiSetSessionMode(payload);",
      "  },",
    ),
  },

  /* ---- src/services/tauri.ai.ts : 命令元数据 + Pick + 实现 ---- */
  {
    file: "src/services/tauri.ai.ts",
    label: "tauri.ai: AI_COMMAND_META.aiGetSessionModes / aiSetSessionMode",
    marker: "  aiGetSessionModes: {",
    old: j(
      "  aiSetSessionConfigOption: {",
      "    command: 'ai_set_session_config_option',",
      "    guardHint: '切换 ACP 会话配置项',",
      "    audit: 'sensitive',",
      "    timeoutMs: 15_000,",
      "    measureInput: buildPayloadMetrics,",
      "  },",
      "} satisfies Record<string, ICommandMeta>;",
    ),
    new: j(
      "  aiSetSessionConfigOption: {",
      "    command: 'ai_set_session_config_option',",
      "    guardHint: '切换 ACP 会话配置项',",
      "    audit: 'sensitive',",
      "    timeoutMs: 15_000,",
      "    measureInput: buildPayloadMetrics,",
      "  },",
      "  aiGetSessionModes: {",
      "    command: 'ai_get_session_modes',",
      "    guardHint: '读取 ACP 会话可用模式',",
      "    idempotent: true,",
      "    audit: 'info',",
      "    timeoutMs: 15_000,",
      "    measureInput: buildPayloadMetrics,",
      "  },",
      "  aiSetSessionMode: {",
      "    command: 'ai_set_session_mode',",
      "    guardHint: '切换 ACP 会话模式',",
      "    audit: 'sensitive',",
      "    timeoutMs: 15_000,",
      "    measureInput: buildPayloadMetrics,",
      "  },",
      "} satisfies Record<string, ICommandMeta>;",
    ),
  },
  {
    file: "src/services/tauri.ai.ts",
    label: "tauri.ai: TAiTauriService Pick union",
    marker: "  | 'aiGetSessionModes'",
    old: j(
      "  | 'aiGetSessionConfigOptions'",
      "  | 'aiSetSessionConfigOption'",
      "  | 'aiInlineComplete'",
    ),
    new: j(
      "  | 'aiGetSessionConfigOptions'",
      "  | 'aiSetSessionConfigOption'",
      "  | 'aiGetSessionModes'",
      "  | 'aiSetSessionMode'",
      "  | 'aiInlineComplete'",
    ),
  },
  {
    file: "src/services/tauri.ai.ts",
    label: "tauri.ai: aiTauriService impls",
    marker: "  aiGetSessionModes: payloadCommand(",
    old: j(
      "  aiSetSessionConfigOption: payloadCommand(AI_COMMAND_META.aiSetSessionConfigOption, (payload) =>",
      "    commands.aiSetSessionConfigOption(payload),",
      "  ),",
    ),
    new: j(
      "  aiSetSessionConfigOption: payloadCommand(AI_COMMAND_META.aiSetSessionConfigOption, (payload) =>",
      "    commands.aiSetSessionConfigOption(payload),",
      "  ),",
      "",
      "  aiGetSessionModes: payloadCommand(AI_COMMAND_META.aiGetSessionModes, (payload) =>",
      "    commands.aiGetSessionModes(payload),",
      "  ),",
      "",
      "  aiSetSessionMode: payloadCommand(AI_COMMAND_META.aiSetSessionMode, (payload) =>",
      "    commands.aiSetSessionMode(payload),",
      "  ),",
    ),
  },

  /* ---- src/types/ai/sidecar.ts : current_mode_update 事件类型 + 并入 union ---- */
  {
    file: "src/types/ai/sidecar.ts",
    label: "sidecar.ts: TAgentUiEventCurrentModeUpdate",
    marker: "TAgentUiEventCurrentModeUpdate",
    old: j(
      "export interface IAcpSessionModesState {",
      "  currentModeId: string | null;",
      "  availableModes: IAcpSessionMode[];",
      "}",
    ),
    new: j(
      "export interface IAcpSessionModesState {",
      "  currentModeId: string | null;",
      "  availableModes: IAcpSessionMode[];",
      "}",
      "",
      "/* ----------------------------------------------------------------------------",
      " * ACP 会话当前模式变更 UI 事件（session/update 的 current_mode_update）",
      " *",
      " * 当外部 agent（如 Kimi）在回合中自行切换模式时，经 session/update 下发",
      " * current_mode_update（仅携带新的 currentModeId）。前端据此回灌模式选择器高亮，",
      " * 不整份替换 availableModes（沿用 ai_get_session_modes 拉取的完整列表）。",
      " * -------------------------------------------------------------------------- */",
      "export type TAgentUiEventCurrentModeUpdate = {",
      "  type: 'current_mode_update';",
      "  currentModeId: string | null;",
      "};",
    ),
  },
  {
    file: "src/types/ai/sidecar.ts",
    label: "sidecar.ts: 并入 TAgentUiEvent union",
    marker: "  | TAgentUiEventCurrentModeUpdate",
    old: j(
      "  | TAgentUiEventConfigOptionUpdate",
      "  | { type: 'approval_required'; request: IApprovalRequest }",
    ),
    new: j(
      "  | TAgentUiEventConfigOptionUpdate",
      "  | TAgentUiEventCurrentModeUpdate",
      "  | { type: 'approval_required'; request: IApprovalRequest }",
    ),
  },

  /* ---- src/types/ai/sidecar.schema.ts : 流式 zod discriminatedUnion 加入 current_mode_update ---- */
  {
    file: "src/types/ai/sidecar.schema.ts",
    label: "sidecar.schema: current_mode_update 变体",
    marker: "z.literal('current_mode_update')",
    old: j(
      "  z.object({",
      "    type: z.literal('error'),",
      "    message: z.string().min(1),",
      "  }),",
      "]);",
    ),
    new: j(
      "  z.object({",
      "    type: z.literal('current_mode_update'),",
      "    currentModeId: z.string().nullable(),",
      "  }),",
      "  z.object({",
      "    type: z.literal('error'),",
      "    message: z.string().min(1),",
      "  }),",
      "]);",
    ),
  },

  /* ---- src/composables/ai/useAiAssistant.ts : import / 实例化 / switch / reset / 公开返回 ---- */
  {
    file: "src/composables/ai/useAiAssistant.ts",
    label: "useAiAssistant: import useAcpSessionModes",
    marker: "import { useAcpSessionModes }",
    old: "import { useAcpSessionConfigOptions } from '@/composables/ai/useAcpSessionConfigOptions';",
    new: j(
      "import { useAcpSessionConfigOptions } from '@/composables/ai/useAcpSessionConfigOptions';",
      "import { useAcpSessionModes } from '@/composables/ai/useAcpSessionModes';",
    ),
  },
  {
    file: "src/composables/ai/useAiAssistant.ts",
    label: "useAiAssistant: 实例化 acpSessionModes",
    marker: "const acpSessionModes = useAcpSessionModes();",
    old: "  const acpSessionConfigOptions = useAcpSessionConfigOptions();",
    new: j(
      "  const acpSessionConfigOptions = useAcpSessionConfigOptions();",
      "  const acpSessionModes = useAcpSessionModes();",
    ),
  },
  {
    file: "src/composables/ai/useAiAssistant.ts",
    label: "useAiAssistant: applyAcpReceiveSideEvents current_mode_update",
    marker: "case 'current_mode_update':",
    old: j(
      "        case 'config_option_update':",
      "          acpSessionConfigOptions.applyConfigOptionUpdate(event.configOptions);",
      "          break;",
    ),
    new: j(
      "        case 'config_option_update':",
      "          acpSessionConfigOptions.applyConfigOptionUpdate(event.configOptions);",
      "          break;",
      "        case 'current_mode_update':",
      "          acpSessionModes.applyCurrentModeUpdate(event.currentModeId);",
      "          break;",
    ),
  },
  {
    file: "src/composables/ai/useAiAssistant.ts",
    label: "useAiAssistant: resetConversationUiState reset()",
    marker: "    acpSessionModes.reset();",
    old: j(
      "    acpUsage.reset();",
      "    acpSessionConfigOptions.reset();",
      "    isClearDialogOpen.value = false;",
    ),
    new: j(
      "    acpUsage.reset();",
      "    acpSessionConfigOptions.reset();",
      "    acpSessionModes.reset();",
      "    isClearDialogOpen.value = false;",
    ),
  },
  {
    file: "src/composables/ai/useAiAssistant.ts",
    label: "useAiAssistant: 公开返回 acpSessionModes",
    marker: "    acpSessionModes,",
    old: j(
      "    acpSessionConfigOptions,",
      "    config,",
      "    messages,",
    ),
    new: j(
      "    acpSessionConfigOptions,",
      "    acpSessionModes,",
      "    config,",
      "    messages,",
    ),
  },

  /* ---- src/components/business/ai/shell/AiAssistantPanel.vue ---- */
  {
    file: "src/components/business/ai/shell/AiAssistantPanel.vue",
    label: "Panel: kimi 后端切换时 loadModes",
    marker: "acpSessionModes.loadModes(",
    old: j(
      "    if (threadId) {",
      "      void assistant.acpSessionConfigOptions.loadConfigOptions(threadId).catch(() => undefined);",
      "    }",
    ),
    new: j(
      "    if (threadId) {",
      "      void assistant.acpSessionConfigOptions.loadConfigOptions(threadId).catch(() => undefined);",
      "      void assistant.acpSessionModes.loadModes(threadId).catch(() => undefined);",
      "    }",
    ),
  },
  {
    file: "src/components/business/ai/shell/AiAssistantPanel.vue",
    label: "Panel: handleSessionModeChange",
    marker: "const handleSessionModeChange =",
    old: j(
      "const handleSessionConfigOptionChange = async (",
      "  configId: string,",
      "  valueId: string,",
      "): Promise<void> => {",
      "  const threadId = assistant.activeConversationId.value;",
      "  if (!threadId) {",
      "    return;",
      "  }",
      "  try {",
      "    await assistant.acpSessionConfigOptions.selectConfigOption(threadId, configId, valueId);",
      "  } catch (error) {",
      "    assistant.error.value = toErrorMessage(error, '切换会话配置失败。');",
      "  }",
      "};",
    ),
    new: j(
      "const handleSessionConfigOptionChange = async (",
      "  configId: string,",
      "  valueId: string,",
      "): Promise<void> => {",
      "  const threadId = assistant.activeConversationId.value;",
      "  if (!threadId) {",
      "    return;",
      "  }",
      "  try {",
      "    await assistant.acpSessionConfigOptions.selectConfigOption(threadId, configId, valueId);",
      "  } catch (error) {",
      "    assistant.error.value = toErrorMessage(error, '切换会话配置失败。');",
      "  }",
      "};",
      "",
      "// ACP 会话模式切换（session/set_mode）：选择器回投透传给 useAcpSessionModes.selectMode",
      "// （乐观更新 + setSessionMode 回投，失败回滚并提示）。复用 Kimi 内置模式语义。",
      "const handleSessionModeChange = async (modeId: string): Promise<void> => {",
      "  const threadId = assistant.activeConversationId.value;",
      "  if (!threadId) {",
      "    return;",
      "  }",
      "  try {",
      "    await assistant.acpSessionModes.selectMode(threadId, modeId);",
      "  } catch (error) {",
      "    assistant.error.value = toErrorMessage(error, '切换会话模式失败。');",
      "  }",
      "};",
    ),
  },
  {
    file: "src/components/business/ai/shell/AiAssistantPanel.vue",
    label: "Panel: 下传 session-modes props",
    marker: ':session-modes="assistant.acpSessionModes.state.value"',
    old: j(
      '          :session-config-options="assistant.acpSessionConfigOptions.state.value"',
      '          :is-session-config-option-switching="assistant.acpSessionConfigOptions.isSwitching.value"',
    ),
    new: j(
      '          :session-config-options="assistant.acpSessionConfigOptions.state.value"',
      '          :is-session-config-option-switching="assistant.acpSessionConfigOptions.isSwitching.value"',
      '          :session-modes="assistant.acpSessionModes.state.value"',
      '          :is-session-mode-switching="assistant.acpSessionModes.isSwitching.value"',
    ),
  },
  {
    file: "src/components/business/ai/shell/AiAssistantPanel.vue",
    label: "Panel: 监听 session-mode-change",
    marker: '@session-mode-change="handleSessionModeChange"',
    old: '          @session-config-option-change="handleSessionConfigOptionChange"',
    new: j(
      '          @session-config-option-change="handleSessionConfigOptionChange"',
      '          @session-mode-change="handleSessionModeChange"',
    ),
  },

  /* ---- src/components/business/ai/chat/AiPromptInput.vue ---- */
  {
    file: "src/components/business/ai/chat/AiPromptInput.vue",
    label: "PromptInput: 导入 IAcpSessionMode / IAcpSessionModesState",
    marker: "  IAcpSessionMode,",
    old: "import type { IAcpSessionConfigOption, IAcpSessionConfigOptionsState } from '@/types/ai/sidecar';",
    new: j(
      "import type {",
      "  IAcpSessionConfigOption,",
      "  IAcpSessionConfigOptionsState,",
      "  IAcpSessionMode,",
      "  IAcpSessionModesState,",
      "} from '@/types/ai/sidecar';",
    ),
  },
  {
    file: "src/components/business/ai/chat/AiPromptInput.vue",
    label: "PromptInput: props sessionModes / isSessionModeSwitching",
    marker: "sessionModes?: IAcpSessionModesState",
    old: j(
      "  sessionConfigOptions?: IAcpSessionConfigOptionsState | null;",
      "  isSessionConfigOptionSwitching?: boolean;",
      "  resolveAttachment: (file: File) => Promise<boolean>;",
    ),
    new: j(
      "  sessionConfigOptions?: IAcpSessionConfigOptionsState | null;",
      "  isSessionConfigOptionSwitching?: boolean;",
      "  sessionModes?: IAcpSessionModesState | null;",
      "  isSessionModeSwitching?: boolean;",
      "  resolveAttachment: (file: File) => Promise<boolean>;",
    ),
  },
  {
    file: "src/components/business/ai/chat/AiPromptInput.vue",
    label: "PromptInput: emit sessionModeChange",
    marker: "sessionModeChange: [modeId: string]",
    old: j(
      "  sessionConfigOptionChange: [configId: string, valueId: string];",
      "  informationSourcesOpen: [];",
    ),
    new: j(
      "  sessionConfigOptionChange: [configId: string, valueId: string];",
      "  sessionModeChange: [modeId: string];",
      "  informationSourcesOpen: [];",
    ),
  },
  {
    file: "src/components/business/ai/chat/AiPromptInput.vue",
    label: "PromptInput: modes 计算属性 + 回投 handler",
    marker: "const sessionModesVisible = computed(",
    old: j(
      "const handleSessionConfigOptionChange = (configId: string, value: unknown): void => {",
      "  if (typeof value !== 'string' || !value.trim()) {",
      "    return;",
      "  }",
      "  const option = sessionConfigOptionList.value.find((item) => item.id === configId);",
      "  if (!option || value === option.currentValue) {",
      "    return;",
      "  }",
      "  emit('sessionConfigOptionChange', configId, value);",
      "};",
    ),
    new: j(
      "const handleSessionConfigOptionChange = (configId: string, value: unknown): void => {",
      "  if (typeof value !== 'string' || !value.trim()) {",
      "    return;",
      "  }",
      "  const option = sessionConfigOptionList.value.find((item) => item.id === configId);",
      "  if (!option || value === option.currentValue) {",
      "    return;",
      "  }",
      "  emit('sessionConfigOptionChange', configId, value);",
      "};",
      "",
      "// ACP 会话模式选择器（session/set_mode）：仅 Kimi ACP agent 且后端公示 availableModes 时显示，",
      "// 复用 Kimi 内置模式语义（绝不本地伪造 chat/agent/plan）。currentModeId 默认高亮 agent 公示值。",
      "const sessionModeList = computed<IAcpSessionMode[]>(() => props.sessionModes?.availableModes ?? []);",
      "",
      "const sessionModesVisible = computed(",
      "  () => selectedAgent.value === 'kimi' && sessionModeList.value.length > 0,",
      ");",
      "",
      "const sessionModeCurrentId = computed(() => props.sessionModes?.currentModeId ?? '');",
      "",
      "const resolveSessionModeLabel = (): string => {",
      "  const current = sessionModeList.value.find((mode) => mode.id === sessionModeCurrentId.value);",
      "  return current?.name ?? '模式';",
      "};",
      "",
      "const handleSessionModeChange = (value: unknown): void => {",
      "  if (typeof value !== 'string' || !value.trim()) {",
      "    return;",
      "  }",
      "  if (value === sessionModeCurrentId.value) {",
      "    return;",
      "  }",
      "  emit('sessionModeChange', value);",
      "};",
    ),
  },
  {
    file: "src/components/business/ai/chat/AiPromptInput.vue",
    label: "PromptInput: Kimi 模式可见时隐藏硬编码 chat/agent/plan 子菜单",
    marker: 'v-if="!sessionModesVisible"',
    old: j(
      "                <DropdownMenuItem",
      '                  class="ai-settings-menu-item is-mode"',
      '                  @pointerenter="handleModeMenuItemPointerEnter"',
    ),
    new: j(
      "                <DropdownMenuItem",
      '                  v-if="!sessionModesVisible"',
      '                  class="ai-settings-menu-item is-mode"',
      '                  @pointerenter="handleModeMenuItemPointerEnter"',
    ),
  },
  {
    file: "src/components/business/ai/chat/AiPromptInput.vue",
    label: "PromptInput: Kimi 内置模式选择器（替换硬编码段）",
    marker: 'aria-label="选择模式"',
    old: j(
      '            <template v-if="sessionConfigOptionsVisible">',
      "              <Select",
      '                v-for="configOption in sessionConfigOptionList"',
    ),
    new: j(
      '            <Select',
      '              v-if="sessionModesVisible"',
      '              :model-value="sessionModeCurrentId"',
      '              :disabled="disabled || isSessionModeSwitching"',
      '              @update:model-value="handleSessionModeChange"',
      "            >",
      '              <SelectTrigger aria-label="选择模式" class="ai-agent-trigger">',
      '                <SlidersHorizontal class="ai-agent-trigger__icon" :stroke-width="1.6" />',
      '                <span class="ai-agent-trigger__label" v-text="resolveSessionModeLabel()"></span>',
      "              </SelectTrigger>",
      '              <SelectContent side="top" align="start" :side-offset="8" class="ai-agent-content">',
      '                <SelectLabel class="ai-agent-section-label">模式</SelectLabel>',
      "                <SelectGroup>",
      "                  <SelectItem",
      '                    v-for="mode in sessionModeList"',
      '                    :key="mode.id"',
      '                    class="ai-agent-item"',
      '                    :value="mode.id"',
      "                  >",
      '                    <span class="ai-agent-item__label" v-text="mode.name"></span>',
      "                  </SelectItem>",
      "                </SelectGroup>",
      "              </SelectContent>",
      "            </Select>",
      '            <template v-if="sessionConfigOptionsVisible">',
      "              <Select",
      '                v-for="configOption in sessionConfigOptionList"',
    ),
  },

  /* ---- src-tauri/src/acp/ui_event.rs : current_mode_update 投影（回灌） ---- */
  {
    file: "src-tauri/src/acp/ui_event.rs",
    label: "ui_event.rs: current_mode_update_ui_event helper",
    marker: "fn current_mode_update_ui_event",
    old: j(
      "fn usage_update_ui_event(usage: &Value) -> Value {",
      '    json!({ "type": "usage_update", "usage": usage.clone() })',
      "}",
    ),
    new: j(
      "fn usage_update_ui_event(usage: &Value) -> Value {",
      '    json!({ "type": "usage_update", "usage": usage.clone() })',
      "}",
      "",
      "/// 构造会话当前模式变更 `TAgentUiEvent`（`type` 为 `current_mode_update`）。",
      "///",
      "/// 投影 ACP `current_mode_update`（外部 agent 在回合中自行切换模式时下发新的 currentModeId）：",
      "/// 仅透传 `currentModeId`（可为 null），交前端回灌模式选择器高亮（见 src/types/ai/sidecar.ts 的",
      "/// TAgentUiEventCurrentModeUpdate 与 from-acp-session-modes.ts）。",
      "fn current_mode_update_ui_event(current_mode_id: &Value) -> Value {",
      '    json!({ "type": "current_mode_update", "currentModeId": current_mode_id.clone() })',
      "}",
    ),
  },
  {
    file: "src-tauri/src/acp/ui_event.rs",
    label: "ui_event.rs: current_mode_update match arm",
    marker: '"current_mode_update" =>',
    old: j(
      '        "usage_update" => {',
      '            let usage = update.get("usage")?;',
      "            Some(usage_update_ui_event(usage))",
      "        }",
    ),
    new: j(
      '        "usage_update" => {',
      '            let usage = update.get("usage")?;',
      "            Some(usage_update_ui_event(usage))",
      "        }",
      "        // 外部 agent 在回合中自行切换模式（标准 current_mode_update）：透传 currentModeId，",
      "        // 交前端回灌模式选择器高亮（session/set_mode 协议）。",
      '        "current_mode_update" => {',
      '            let current_mode_id = update.get("currentModeId")?;',
      "            Some(current_mode_update_ui_event(current_mode_id))",
      "        }",
    ),
  },
  {
    file: "src-tauri/src/acp/ui_event.rs",
    label: "ui_event.rs: current_mode_update 单测",
    marker: "current_mode_update_passes_through_current_mode_id",
    old: j(
      "    #[test]",
      "    fn usage_update_without_field_yields_none() {",
      '        let n = notif(json!({ "sessionUpdate": "usage_update" }));',
      "        assert!(session_notification_to_ui_event(&n).is_none());",
      "    }",
    ),
    new: j(
      "    #[test]",
      "    fn usage_update_without_field_yields_none() {",
      '        let n = notif(json!({ "sessionUpdate": "usage_update" }));',
      "        assert!(session_notification_to_ui_event(&n).is_none());",
      "    }",
      "",
      "    #[test]",
      "    fn current_mode_update_passes_through_current_mode_id() {",
      "        let n = notif(json!({",
      '            "sessionUpdate": "current_mode_update",',
      '            "currentModeId": "agent"',
      "        }));",
      "        let ui = session_notification_to_ui_event(&n).unwrap();",
      '        assert_eq!(ui["type"], "current_mode_update");',
      '        assert_eq!(ui["currentModeId"], "agent");',
      "    }",
      "",
      "    #[test]",
      "    fn current_mode_update_without_field_yields_none() {",
      '        let n = notif(json!({ "sessionUpdate": "current_mode_update" }));',
      "        assert!(session_notification_to_ui_event(&n).is_none());",
      "    }",
    ),
  },
];

/* ------------------------------------------------------------------- runner */
let created = 0, applied = 0, skipped = 0, failed = 0;

for (const f of NEW_FILES) {
  const abs = join(ROOT, f.file);
  if (existsSync(abs)) {
    console.log(`SKIP  (exists) ${f.file}`);
    skipped++;
    continue;
  }
  console.log(`${DRY ? "DRY  CREATE" : "CREATE"}     ${f.file}`);
  if (!DRY) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
  }
  created++;
}

for (const e of EDITS) {
  const abs = join(ROOT, e.file);
  if (!existsSync(abs)) {
    console.error(`FAIL  (missing file) ${e.file} :: ${e.label}`);
    failed++;
    continue;
  }
  let content = readFileSync(abs, "utf8");
  if (content.includes(e.marker)) {
    console.log(`SKIP  (done) ${e.file} :: ${e.label}`);
    skipped++;
    continue;
  }
  const count = content.split(e.old).length - 1;
  if (count !== 1) {
    console.error(`FAIL  (${count} matches, expected 1) ${e.file} :: ${e.label}`);
    failed++;
    continue;
  }
  console.log(`${DRY ? "DRY  EDIT  " : "EDIT  "}     ${e.file} :: ${e.label}`);
  if (!DRY) {
    content = content.replace(e.old, () => e.new);
    writeFileSync(abs, content, "utf8");
  }
  applied++;
}

console.log(
  `\n${DRY ? "[DRY RUN] " : ""}created=${created} applied=${applied} skipped=${skipped} failed=${failed}`,
);
if (failed > 0) process.exitCode = 1;
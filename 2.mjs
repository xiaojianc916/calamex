#!/usr/bin/env node
// acp-refactor.mjs
// 一次性把「ACP Session Config Options v3 · 唯一标准管线」迁移补齐到当前 HEAD。
// 用法：
//   node acp-refactor.mjs            # dry-run，仅预览将改哪些文件
//   node acp-refactor.mjs --write    # 落盘
//   node acp-refactor.mjs --write --force   # 跳过 git 干净检查（不推荐）
// 安全：git 不干净则中止；任一锚点 drift/重复 则原子中止，不写任何文件；可重复运行（幂等跳过）。
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

/* ===================== 整文件重写内容 ===================== */

const PROJECTION = `import type {
  IAcpSessionConfigOption,
  IAcpSessionConfigSelectOption,
  TAcpSessionConfigOptions,
} from '@/types/ai/sidecar';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseSelectOption(raw: unknown, group?: string): IAcpSessionConfigSelectOption | null {
  if (!isRecord(raw)) return null;
  const value = readString(raw.value);
  const name = readString(raw.name);
  if (value === null || name === null) return null;
  const option: IAcpSessionConfigSelectOption = { value, name };
  const description = readOptionalString(raw.description);
  if (description !== undefined) option.description = description;
  if (group !== undefined) option.group = group;
  return option;
}

function parseSelectOptions(raw: unknown): IAcpSessionConfigSelectOption[] | null {
  if (!Array.isArray(raw)) return null;
  const options: IAcpSessionConfigSelectOption[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    if (Array.isArray(entry.options)) {
      const groupName = readString(entry.name) ?? readString(entry.group) ?? undefined;
      for (const child of entry.options) {
        const option = parseSelectOption(child, groupName);
        if (option !== null) options.push(option);
      }
      continue;
    }
    const option = parseSelectOption(entry);
    if (option !== null) options.push(option);
  }
  return options;
}

function parseConfigOption(raw: unknown): IAcpSessionConfigOption | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'select') return null;
  const id = readString(raw.id);
  const name = readString(raw.name);
  const currentValue = readString(raw.currentValue);
  if (id === null || name === null || currentValue === null) return null;
  const options = parseSelectOptions(raw.options);
  if (options === null || options.length === 0) return null;
  const option: IAcpSessionConfigOption = { id, name, currentValue, options };
  const description = readOptionalString(raw.description);
  if (description !== undefined) option.description = description;
  const category = readOptionalString(raw.category);
  if (category !== undefined) option.category = category;
  return option;
}

function parseConfigOptionList(raw: unknown): IAcpSessionConfigOption[] | null {
  if (!Array.isArray(raw)) return null;
  const configOptions: IAcpSessionConfigOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const option = parseConfigOption(entry);
    if (option === null) continue;
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    configOptions.push(option);
  }
  return configOptions;
}

/**
 * 解析 ACP configOptions（SessionConfigOption[]）为 v3 判别式「ready」态。
 * 非数组（含 null）=> null（坏帧 / 非法负载，由调用方决定保留旧态）；
 * 合法但为空 => { kind: 'ready', configOptions: [] }（已公示、无可选项）。
 */
export function parseAcpSessionConfigOptions(
  raw: unknown,
): Extract<TAcpSessionConfigOptions, { kind: 'ready' }> | null {
  const configOptions = parseConfigOptionList(raw);
  if (configOptions === null) return null;
  return { kind: 'ready', configOptions };
}

/**
 * 应用 config_option_update（完整快照）：成功解析则整体替换为 ready 态；
 * 坏帧（非数组）保留旧状态，避免单帧异常清空 UI。唯一标准事件入口。
 */
export function applyAcpConfigOptionUpdate(
  state: TAcpSessionConfigOptions,
  raw: unknown,
): TAcpSessionConfigOptions {
  const next = parseAcpSessionConfigOptions(raw);
  return next ?? state;
}
`;

const COMPOSABLE = `import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';

import {
  applyAcpConfigOptionUpdate,
  parseAcpSessionConfigOptions,
} from '@/components/business/ai/thread/projection/from-acp-session-config-options';
import { aiService } from '@/services/ipc/ai.service';
import type {
  IAcpSessionConfigOption,
  TAcpSessionConfigOptions,
  TAgentBackendKind,
} from '@/types/ai/sidecar';
import { toErrorMessage } from '@/utils/error/error';

/** 握手后短等 agent 首帧 config_option_update 的宽限窗口（ms）：到期判定为「已公示、空」。 */
const READY_GRACE_MS = 1200;

export interface IUseAcpSessionConfigOptionsReturn {
  state: Ref<TAcpSessionConfigOptions>;
  configOptions: ComputedRef<IAcpSessionConfigOption[]>;
  hasConfigOptions: ComputedRef<boolean>;
  isSwitching: Ref<boolean>;
  ensureAcpSession: (
    threadId: string,
    backend: TAgentBackendKind,
    workspaceRootPath?: string | null,
  ) => Promise<void>;
  selectConfigOption: (threadId: string, configId: string, valueId: string) => Promise<boolean>;
  applyConfigOptionUpdate: (raw: unknown) => void;
  reset: () => void;
}

/**
 * ACP config_options 选择器 composable（v3 · 唯一标准管线 / 判别式状态机）。
 *
 * 取代 v2 的 get-工作区 + 乐观切换/回滚：
 * - ensureAcpSession：握手建立会话（void），置 discovering 并武装宽限计时器；配置项发现统一
 *   走事件通道（config_option_update）。
 * - applyConfigOptionUpdate：唯一写入点——完整快照整体替换为 ready；坏帧保留旧态。
 * - selectConfigOption：仅触发 set；权威新值由 agent 的 config_option_update 回推，不乐观、不回滚；
 *   set 响应若携带即时快照则并入（best-effort），最终仍以事件为准。
 */
export function useAcpSessionConfigOptions(): IUseAcpSessionConfigOptionsReturn {
  const state = ref<TAcpSessionConfigOptions>({ kind: 'idle' });
  const isSwitching = ref(false);

  let activeThreadId: string | null = null;
  let readyGraceTimer: ReturnType<typeof setTimeout> | null = null;

  const configOptions = computed<IAcpSessionConfigOption[]>(() =>
    state.value.kind === 'ready' ? state.value.configOptions : [],
  );
  const hasConfigOptions = computed(() => configOptions.value.length > 0);

  function clearReadyGrace(): void {
    if (readyGraceTimer !== null) {
      clearTimeout(readyGraceTimer);
      readyGraceTimer = null;
    }
  }

  function armReadyGrace(threadId: string): void {
    clearReadyGrace();
    readyGraceTimer = setTimeout(() => {
      readyGraceTimer = null;
      // 宽限到期仍停在 discovering（未收到任何 config_option_update）：判定无可切换配置项。
      if (activeThreadId === threadId && state.value.kind === 'discovering') {
        state.value = { kind: 'ready', configOptions: [] };
      }
    }, READY_GRACE_MS);
  }

  function applyConfigOptionUpdate(raw: unknown): void {
    clearReadyGrace();
    state.value = applyAcpConfigOptionUpdate(state.value, raw);
  }

  async function ensureAcpSession(
    threadId: string,
    backend: TAgentBackendKind,
    workspaceRootPath?: string | null,
  ): Promise<void> {
    activeThreadId = threadId;
    clearReadyGrace();
    state.value = { kind: 'discovering' };
    try {
      await aiService.ensureAcpSession({
        threadId,
        backend,
        ...(workspaceRootPath ? { workspaceRootPath } : {}),
      });
      if (activeThreadId !== threadId) return;
      // 握手只确保会话建立；配置项发现走事件通道，短等首帧 config_option_update 兜底。
      if (state.value.kind === 'discovering') {
        armReadyGrace(threadId);
      }
    } catch (error) {
      if (activeThreadId !== threadId) return;
      clearReadyGrace();
      state.value = {
        kind: 'unavailable',
        reason: 'handshake_failed',
        message: toErrorMessage(error, 'ACP 会话握手失败'),
      };
    }
  }

  async function selectConfigOption(
    threadId: string,
    configId: string,
    valueId: string,
  ): Promise<boolean> {
    if (state.value.kind !== 'ready') return false;
    const target = state.value.configOptions.find((option) => option.id === configId);
    if (target === undefined) return false;
    if (target.currentValue === valueId) return true;
    // 越界保护：valueId 必须是该选择器的合法候选值。
    if (!target.options.some((option) => option.value === valueId)) return false;

    isSwitching.value = true;
    try {
      const payload = await aiService.setSessionConfigOption({ threadId, configId, valueId });
      if (activeThreadId === threadId && payload) {
        applyConfigOptionUpdate(payload.configOptions);
      }
      return true;
    } finally {
      isSwitching.value = false;
    }
  }

  function reset(): void {
    clearReadyGrace();
    activeThreadId = null;
    isSwitching.value = false;
    state.value = { kind: 'idle' };
  }

  return {
    state,
    configOptions,
    hasConfigOptions,
    isSwitching,
    ensureAcpSession,
    selectConfigOption,
    applyConfigOptionUpdate,
    reset,
  };
}
`;

const SPEC = `import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

const { ensureAcpSession, setSessionConfigOption } = vi.hoisted(() => ({
  ensureAcpSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
}));

vi.mock('@/services/ipc/ai.service', () => ({
  aiService: {
    ensureAcpSession,
    setSessionConfigOption,
  },
}));

import { useAcpSessionConfigOptions } from '@/composables/ai/useAcpSessionConfigOptions';

function buildConfigOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'k2',
      options: [
        { value: 'k2', name: 'Kimi K2' },
        { value: 'k1', name: 'Kimi K1', description: 'Legacy' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'ask',
      options: [
        {
          group: 'standard',
          name: 'Standard',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'code', name: 'Code' },
          ],
        },
      ],
    },
  ];
}

function withScope<T>(fn: () => T): T {
  const scope = effectScope();
  const result = scope.run(fn);
  if (result === undefined) throw new Error('scope.run returned undefined');
  return result;
}

describe('useAcpSessionConfigOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('handshakes, enters discovering, then resolves to empty ready after grace', async () => {
    vi.useFakeTimers();
    ensureAcpSession.mockResolvedValue(undefined);
    const vm = withScope(() => useAcpSessionConfigOptions());

    await vm.ensureAcpSession('thread-1', 'kimi');

    expect(ensureAcpSession).toHaveBeenCalledWith({ threadId: 'thread-1', backend: 'kimi' });
    expect(vm.state.value.kind).toBe('discovering');

    await vi.advanceTimersByTimeAsync(1200);
    expect(vm.state.value).toEqual({ kind: 'ready', configOptions: [] });
    expect(vm.hasConfigOptions.value).toBe(false);
  });

  it('marks unavailable when the handshake throws', async () => {
    ensureAcpSession.mockRejectedValue(new Error('boom'));
    const vm = withScope(() => useAcpSessionConfigOptions());

    await vm.ensureAcpSession('thread-1', 'kimi');

    expect(vm.state.value.kind).toBe('unavailable');
  });

  it('parses config_option_update into ready, flattening grouped options', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());

    vm.applyConfigOptionUpdate(buildConfigOptions());

    expect(vm.state.value.kind).toBe('ready');
    expect(vm.configOptions.value).toHaveLength(2);
    const mode = vm.configOptions.value.find((o) => o.id === 'mode');
    expect(mode?.options).toEqual([
      { value: 'ask', name: 'Ask', group: 'Standard' },
      { value: 'code', name: 'Code', group: 'Standard' },
    ]);
  });

  it('keeps previous state when config_option_update carries a bad frame', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    vm.applyConfigOptionUpdate('not-an-array');

    expect(vm.configOptions.value).toHaveLength(2);
  });

  it('fires set without optimistic mutation and merges the returned snapshot', async () => {
    setSessionConfigOption.mockResolvedValue({
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'k1',
          options: [
            { value: 'k2', name: 'Kimi K2' },
            { value: 'k1', name: 'Kimi K1' },
          ],
        },
      ],
    });
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    const ok = await vm.selectConfigOption('thread-1', 'model', 'k1');

    expect(ok).toBe(true);
    expect(setSessionConfigOption).toHaveBeenCalledWith({
      threadId: 'thread-1',
      configId: 'model',
      valueId: 'k1',
    });
    expect(vm.configOptions.value.find((o) => o.id === 'model')?.currentValue).toBe('k1');
  });

  it('rejects unknown configId / valueId without calling the IPC', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    expect(await vm.selectConfigOption('thread-1', 'missing', 'k1')).toBe(false);
    expect(await vm.selectConfigOption('thread-1', 'model', 'nope')).toBe(false);
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('returns true without IPC when selecting the current value', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    expect(await vm.selectConfigOption('thread-1', 'model', 'k2')).toBe(true);
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('resets state to idle', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    vm.reset();

    expect(vm.state.value).toEqual({ kind: 'idle' });
    expect(vm.hasConfigOptions.value).toBe(false);
  });
});
`;

/* ===================== OPS ===================== */

const OPS = [
  // ---------- Rust：契约层 ----------
  {
    file: 'src-tauri/src/commands/contracts/ai_chat.rs',
    label: 'AiGetSessionConfigOptionsRequest -> AiEnsureAcpSessionRequest',
    find: `/// ACP 会话可用配置项清单的查询请求（契约层）。
///
/// 对齐 acp::AcpRuntime::session_config_options(thread_id)：thread_id 定位目标会话（宿主持有
/// thread_id ↔ SessionId 映射，并在会话建立时登记 agent 公示的可用配置项）。必填且非空，
/// 空白校验由接线层负责。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiGetSessionConfigOptionsRequest {
    pub(crate) thread_id: String,
}`,
    replace: `/// ACP 会话握手请求（契约层，v3 · 唯一标准管线）。
///
/// 对齐 ai_ensure_acp_session：thread_id 定位/复用会话；backend 指定后端（builtin/kimi/codex）；
/// workspace_root_path 为新建会话的 cwd。握手仅建立/复用会话（触发外部 agent 在 session/new
/// 之后下发一次性 config_option_update 通知），不返回快照——配置项发现统一走事件通道。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiEnsureAcpSessionRequest {
    pub(crate) thread_id: String,
    pub(crate) backend: String,
    pub(crate) workspace_root_path: Option<String>,
}`,
  },

  // ---------- Rust：gateway ----------
  {
    file: 'src-tauri/src/commands/ai/gateway.rs',
    label: 'gateway import rename',
    find: `    AiConversationTitlePayload, AiConversationTitleRequest, AiGetSessionConfigOptionsRequest,`,
    replace: `    AiConversationTitlePayload, AiConversationTitleRequest, AiEnsureAcpSessionRequest,`,
  },
  {
    file: 'src-tauri/src/commands/ai/gateway.rs',
    label: 'ai_set_session_config_option -> 返回全集',
    find: `pub async fn ai_set_session_config_option(
    app: AppHandle,
    payload: AiSetSessionConfigOptionRequest,
) -> Result<bool, String> {
    let thread_id = payload.thread_id.trim();
    if thread_id.is_empty() {
        return Err("AI_SET_SESSION_CONFIG_OPTION_INVALID: threadId 不能为空。".to_string());
    }
    let config_id = payload.config_id.trim();
    if config_id.is_empty() {
        return Err("AI_SET_SESSION_CONFIG_OPTION_INVALID: configId 不能为空。".to_string());
    }
    let value_id = payload.value_id.trim();
    if value_id.is_empty() {
        return Err("AI_SET_SESSION_CONFIG_OPTION_INVALID: valueId 不能为空。".to_string());
    }

    use tauri::Manager as _;
    let applied = app
        .state::<crate::acp::AcpRuntime>()
        .set_session_config_option(thread_id, config_id, value_id)
        .await
        .map_err(|error| format!("AI_SET_SESSION_CONFIG_OPTION_FAILED: {error}"))?;
    Ok(applied)
}`,
    replace: `pub async fn ai_set_session_config_option(
    app: AppHandle,
    payload: AiSetSessionConfigOptionRequest,
) -> Result<Option<AiSessionConfigOptionsPayload>, String> {
    let thread_id = payload.thread_id.trim();
    if thread_id.is_empty() {
        return Err("AI_SET_SESSION_CONFIG_OPTION_INVALID: threadId 不能为空。".to_string());
    }
    let config_id = payload.config_id.trim();
    if config_id.is_empty() {
        return Err("AI_SET_SESSION_CONFIG_OPTION_INVALID: configId 不能为空。".to_string());
    }
    let value_id = payload.value_id.trim();
    if value_id.is_empty() {
        return Err("AI_SET_SESSION_CONFIG_OPTION_INVALID: valueId 不能为空。".to_string());
    }

    use tauri::Manager as _;
    let runtime = app.state::<crate::acp::AcpRuntime>();
    let applied = runtime
        .set_session_config_option(thread_id, config_id, value_id)
        .await
        .map_err(|error| format!("AI_SET_SESSION_CONFIG_OPTION_FAILED: {error}"))?;
    // v3：权威新值由 agent 的 config_option_update 帧回推前端 ACL；此处命中已绑定会话时回传
    // 当前缓存的配置项全集作为即时快照（未命中则 None）。
    if !applied {
        return Ok(None);
    }
    Ok(runtime
        .session_config_options(thread_id)
        .map(|config_options| AiSessionConfigOptionsPayload { config_options }))
}`,
  },
  {
    file: 'src-tauri/src/commands/ai/gateway.rs',
    label: 'ai_get_session_config_options -> ai_ensure_acp_session',
    find: `/// 取某线程会话建立时 agent 公示的可用配置项清单（ACP session/new 的
/// NewSessionResponse.config_options 原样 JSON：Vec SessionConfigOption），供前端配置项选择器在
/// 会话建立后填充候选项。
///
/// 与 ai_get_session_modes 同构地委托给 Tauri 托管的 AcpRuntime：由 runtime 向全部已建立宿主
/// 查询并返回首个命中。thread_id 先行空白校验；返回 None 表示尚无该线程会话或 agent 未公示
/// 配置项（前端据此隐藏选择器）。config_options 为最小透传的原样 JSON（导出 TS 为 unknown）。
#[tauri::command]
#[specta::specta]
pub fn ai_get_session_config_options(
    app: AppHandle,
    payload: AiGetSessionConfigOptionsRequest,
) -> Result<Option<AiSessionConfigOptionsPayload>, String> {
    let thread_id = payload.thread_id.trim();
    if thread_id.is_empty() {
        return Err("AI_GET_SESSION_CONFIG_OPTIONS_INVALID: threadId 不能为空。".to_string());
    }

    use tauri::Manager as _;
    let config_options = app
        .state::<crate::acp::AcpRuntime>()
        .session_config_options(thread_id)
        .map(|config_options| AiSessionConfigOptionsPayload { config_options });
    Ok(config_options)
}`,
    replace: `/// 握手并复用/建立某线程在指定后端上的 ACP 会话（v3 · 唯一标准管线）。
///
/// 取代 ai_get_session_config_options：配置项发现统一走事件通道，握手不再返回快照。经
/// get_or_spawn_backend 懒建立目标后端宿主后 ensure_session 建立/复用会话——这会触发外部 agent
/// （如 Kimi）在 session/new 之后下发一次性 config_option_update 通知（宿主缓存、回合发起时以
/// 前端键重放），前端据此填充选择器。thread_id / backend 先行校验；未知 backend 报错。
#[tauri::command]
#[specta::specta]
pub async fn ai_ensure_acp_session(
    app: AppHandle,
    payload: AiEnsureAcpSessionRequest,
) -> Result<(), String> {
    let thread_id = payload.thread_id.trim();
    if thread_id.is_empty() {
        return Err("AI_ENSURE_ACP_SESSION_INVALID: threadId 不能为空。".to_string());
    }
    let backend = match payload.backend.trim() {
        "builtin" => crate::acp::AcpBackendId::Builtin,
        "kimi" => crate::acp::AcpBackendId::Kimi,
        "codex" => crate::acp::AcpBackendId::Codex,
        other => {
            return Err(format!("AI_ENSURE_ACP_SESSION_INVALID: 未知 backend：{other}"));
        }
    };
    let workspace_root_path = payload
        .workspace_root_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    use tauri::Manager as _;
    let host = app
        .state::<crate::acp::AcpRuntime>()
        .get_or_spawn_backend(&app, backend)
        .map_err(|error| format!("AI_ENSURE_ACP_SESSION_FAILED: {error}"))?;
    host.ensure_session(thread_id, workspace_root_path)
        .await
        .map_err(|error| format!("AI_ENSURE_ACP_SESSION_FAILED: {error}"))?;
    Ok(())
}`,
  },

  // ---------- Rust：specta 命令注册 ----------
  {
    file: 'src-tauri/src/tauri_bindings.rs',
    label: 'register ai_ensure_acp_session',
    find: `            ai::gateway::ai_get_session_config_options,`,
    replace: `            ai::gateway::ai_ensure_acp_session,`,
  },

  // ---------- FE：类型 barrel ----------
  {
    file: 'src/types/ai/index.ts',
    label: 'IAiGetSessionConfigOptionsRequest -> IAiEnsureAcpSessionRequest',
    find: `/**
 * ACP 会话配置项查询 / 切换请求与负载（ADR-20260617 · D7-③，对齐 D7-③-c 的会话模式管线）。
 *
 * thread 维度；与生成绑定 AiGetSessionConfigOptionsRequest / AiSetSessionConfigOptionRequest /
 * AiSessionConfigOptionsPayload 结构一致（全 camelCase、全必填）。configId / valueId 为 ACP
 * SessionConfigOption.id / SessionConfigValueId 原值逐字透传，跨层不做语义映射。configOptions
 * 为 ACP NewSessionResponse.config_options（Vec<SessionConfigOption>）原始负载逐字透传（形状
 * unknown），由前端 ACL（from-acp-session-config-options）解析为选择器 VM。
 */
export interface IAiGetSessionConfigOptionsRequest {
  threadId: string;
}`,
    replace: `/**
 * ACP 会话握手请求（v3 · 唯一标准管线）。
 *
 * thread 维度；与生成绑定 AiEnsureAcpSessionRequest 结构一致（全 camelCase）。backend 指定后端
 * （builtin / kimi / codex），workspaceRootPath 为新建会话的 cwd。握手仅建立/复用会话（触发
 * agent 在 session/new 之后下发一次性 config_option_update 通知），不返回快照——配置项发现统一
 * 走 config_option_update 事件通道（取代旧 ai_get_session_config_options get-工作区）。
 */
export interface IAiEnsureAcpSessionRequest {
  threadId: string;
  backend: 'builtin' | 'kimi' | 'codex';
  workspaceRootPath?: string | null;
}`,
  },

  // ---------- FE：ITauriService ----------
  {
    file: 'src/types/tauri/index.ts',
    label: 'ITauriService import rename',
    find: `  IAiGetSessionConfigOptionsRequest,`,
    replace: `  IAiEnsureAcpSessionRequest,`,
  },
  {
    file: 'src/types/tauri/index.ts',
    label: 'ITauriService method rename + set 返回类型',
    find: `  aiGetSessionConfigOptions(
    payload: IAiGetSessionConfigOptionsRequest,
  ): Promise<IAiSessionConfigOptionsPayload | null>;
  aiSetSessionConfigOption(payload: IAiSetSessionConfigOptionRequest): Promise<boolean>;`,
    replace: `  aiEnsureAcpSession(payload: IAiEnsureAcpSessionRequest): Promise<void>;
  aiSetSessionConfigOption(
    payload: IAiSetSessionConfigOptionRequest,
  ): Promise<IAiSessionConfigOptionsPayload | null>;`,
  },

  // ---------- FE：tauri-specta 包装层 ----------
  {
    file: 'src/services/tauri/ai.ts',
    label: 'AI_COMMAND_META rename',
    find: `  aiGetSessionConfigOptions: {
    command: 'ai_get_session_config_options',
    guardHint: '读取 ACP 会话可用配置项',
    idempotent: true,
    audit: 'info',
    timeoutMs: 15_000,
    measureInput: buildPayloadMetrics,
  },`,
    replace: `  aiEnsureAcpSession: {
    command: 'ai_ensure_acp_session',
    guardHint: '握手并建立 ACP 会话',
    audit: 'info',
    timeoutMs: 15_000,
    measureInput: buildPayloadMetrics,
  },`,
  },
  {
    file: 'src/services/tauri/ai.ts',
    label: 'TAiTauriService Pick rename',
    find: `  | 'aiGetSessionConfigOptions'`,
    replace: `  | 'aiEnsureAcpSession'`,
  },
  {
    file: 'src/services/tauri/ai.ts',
    label: 'aiTauriService impl rename',
    find: `  aiGetSessionConfigOptions: payloadCommand(AI_COMMAND_META.aiGetSessionConfigOptions, (payload) =>
    commands.aiGetSessionConfigOptions(payload),
  ),`,
    replace: `  aiEnsureAcpSession: payloadCommand(AI_COMMAND_META.aiEnsureAcpSession, async (payload) => {
    await commands.aiEnsureAcpSession(payload);
  }),`,
  },

  // ---------- FE：投影 / composable / 测试（整文件重写） ----------
  {
    file: 'src/components/business/ai/thread/projection/from-acp-session-config-options.ts',
    whole: true,
    requireIncludes: ['parseAcpSessionConfigOptionsState'],
    replace: PROJECTION,
  },
  {
    file: 'src/composables/ai/useAcpSessionConfigOptions.ts',
    whole: true,
    requireIncludes: ['parseAcpSessionConfigOptionsState', 'loadConfigOptions'],
    replace: COMPOSABLE,
  },
  {
    file: 'src/composables/ai/useAcpSessionConfigOptions.spec.ts',
    whole: true,
    requireIncludes: ['getSessionConfigOptions'],
    replace: SPEC,
  },

  // ---------- FE：AiPromptInput.vue（union prop） ----------
  {
    file: 'src/components/business/ai/chat/AiPromptInput.vue',
    label: 'import union type',
    find: `import type {
  IAcpAvailableCommand,
  IAcpSessionConfigOption,
  IAcpSessionConfigOptionsState,
} from '@/types/ai/sidecar';`,
    replace: `import type {
  IAcpAvailableCommand,
  IAcpSessionConfigOption,
  TAcpSessionConfigOptions,
} from '@/types/ai/sidecar';`,
  },
  {
    file: 'src/components/business/ai/chat/AiPromptInput.vue',
    label: 'prop type -> union',
    find: `  sessionConfigOptions?: IAcpSessionConfigOptionsState | null;`,
    replace: `  sessionConfigOptions?: TAcpSessionConfigOptions | null;`,
  },
  {
    file: 'src/components/business/ai/chat/AiPromptInput.vue',
    label: 'sessionConfigOptionList from ready',
    find: `// Kimi(ACP) 会话级配置项：父级下传 configOptions。
const sessionConfigOptionList = computed<readonly IAcpSessionConfigOption[]>(
  () => props.sessionConfigOptions?.configOptions ?? [],
);`,
    replace: `// Kimi(ACP) 会话级配置项：父级下传判别式状态，仅 ready 态有 configOptions。
const sessionConfigOptionList = computed<readonly IAcpSessionConfigOption[]>(() =>
  props.sessionConfigOptions?.kind === 'ready' ? props.sessionConfigOptions.configOptions : [],
);`,
  },
  {
    file: 'src/components/business/ai/chat/AiPromptInput.vue',
    label: 'isKimiModelLocked 仅 ready 态',
    find: `// kimi 但未公示任何可切换模型 → 锁定主选择器并明示，避免「选了没反应」的无声失败。
const isKimiModelLocked = computed(
  () => selectedAgent.value === 'kimi' && kimiModelConfigOption.value === null,
);`,
    replace: `// kimi 已就绪（ready）但未公示任何可切换模型 → 锁定主选择器并明示；discovering/unavailable 不锁。
const isKimiModelLocked = computed(
  () =>
    selectedAgent.value === 'kimi' &&
    kimiModelConfigOption.value === null &&
    props.sessionConfigOptions?.kind === 'ready',
);`,
  },
];

/* ===================== 引擎 ===================== */

const postRunNotes = `
后续（非脚本能代劳，必走的编译/codegen 闭环）：
  1) cd src-tauri && cargo test --features acp_client   # 触发 specta 重新导出 src/bindings/tauri.ts
  2) pnpm biome check --write
  3) pnpm vue-tsc --noEmit  &&  cd src-tauri && cargo check --features acp_client
  4) pnpm vitest run src/composables/ai/useAcpSessionConfigOptions.spec.ts
验证零残留：
  git grep -nE "ai_get_session_config_options|aiGetSessionConfigOptions|IAcpSessionConfigOptionsState|IAiGetSessionConfigOptionsRequest|parseAcpSessionConfigOptionsState|loadConfigOptions"
（应只剩本脚本自身；若 AiAssistantPanel/useAiAssistant 仍有 ensureAcpSession 调用缺口，按 vue-tsc 报错补 1 处接线即可。）`;

function gitClean() {
  try {
    return execSync('git status --porcelain', { encoding: 'utf8' }).trim() === '';
  } catch (e) {
    console.error('无法运行 git status（请在仓库根执行）：', e.message);
    process.exit(2);
  }
}
const count = (hay, needle) => hay.split(needle).length - 1;

function main() {
  // ── CRLF 兼容：Windows 下 .mjs 本身可能保存为 CRLF，模板字面量里含 \r\n ──
const normalize = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
for (const op of OPS) {
  if (op.find)    op.find    = normalize(op.find);
  if (op.replace) op.replace = normalize(op.replace);
  if (op.requireIncludes) op.requireIncludes = op.requireIncludes.map(normalize);
}
  if (!gitClean() && !FORCE) {
    console.error('✗ 工作区不干净。请先提交/暂存，或加 --force（不推荐）。');
    process.exit(2);
  }
  const byFile = new Map();
  for (const op of OPS) {
    if (!byFile.has(op.file)) byFile.set(op.file, []);
    byFile.get(op.file).push(op);
  }
  const planned = [];
  let errors = 0;
  for (const [file, ops] of byFile) {
    let content;
    try {
      content = normalize(readFileSync(resolve(file), 'utf8'));
    } catch {
      console.error(`✗ 读不到文件：${file}`);
      errors++;
      continue;
    }
    let next = content;
    let changed = false;
    for (const op of ops) {
      if (op.whole) {
        if (next === op.replace) {
          console.log(`· 跳过(已重写)：${file}`);
          continue;
        }
        const missing = (op.requireIncludes || []).filter((s) => !next.includes(s));
        if (missing.length) {
          console.error(`✗ ${file}: 整文件守卫缺 ${JSON.stringify(missing)}（已变更/已迁移？）`);
          errors++;
          continue;
        }
        next = op.replace;
        changed = true;
        console.log(`✓ 整文件重写：${file}`);
        continue;
      }
      const n = count(next, op.find);
      const want = op.count ?? 1;
      if (n === 0) {
        if (next.includes(op.replace)) {
          console.log(`· 跳过(已应用)：${file} :: ${op.label}`);
          continue;
        }
        console.error(`✗ ${file}: 锚点未命中（drift）：${op.label}`);
        errors++;
        continue;
      }
      if (n !== want) {
        console.error(`✗ ${file}: 锚点出现 ${n} 次（期望 ${want}）：${op.label}`);
        errors++;
        continue;
      }
      next = next.split(op.find).join(op.replace);
      changed = true;
      console.log(`✓ ${file} :: ${op.label}`);
    }
    if (changed) planned.push({ file, next });
  }
  if (errors) {
    console.error(`\n✗ 共 ${errors} 处失败 —— 原子中止，未写入任何文件。`);
    process.exit(1);
  }
  if (!WRITE) {
    console.log(`\n[dry-run] ${planned.length} 个文件将被修改。确认后加 --write 落盘。`);
    return;
  }
  for (const { file, next } of planned) writeFileSync(resolve(file), next, 'utf8');
  console.log(`\n✓ 已写入 ${planned.length} 个文件。`);
  console.log(postRunNotes);
}
main();
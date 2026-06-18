// D7-③-c-1: ACP 会话模式 前端数据层（VM 类型 + ACL + IPC 管线）。
//
// 幂等、CRLF 容忍、每处锚点必须命中且唯一。从仓库根运行：
//   node scripts/acp-session-modes-frontend-data.mjs
//
// 前置：src/bindings/tauri.ts 须已包含 commands.aiGetSessionModes /
// commands.aiSetSessionMode（③-a、③-b-2-2 已注册 Rust 命令，cargo 构建/导出后生成）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = process.cwd();
const abs = (rel) => join(ROOT, rel);

let changed = 0;
let skipped = 0;

const applyEdit = ({ file, label, marker, anchor, replacement }) => {
  const original = readFileSync(abs(file), 'utf8');
  const text = original.replace(/\r\n/g, '\n');
  if (text.includes(marker)) {
    console.log(`skip   ${file}  ::  ${label}`);
    skipped += 1;
    return;
  }
  const count = text.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(
      `expected exactly 1 anchor in ${file} (${label}), found ${count}:\n--- anchor ---\n${anchor}\n--- /anchor ---`,
    );
  }
  const next = text.replace(anchor, () => replacement);
  const hadCRLF = /\r\n/.test(original);
  writeFileSync(abs(file), hadCRLF ? next.replace(/\n/g, '\r\n') : next, 'utf8');
  changed += 1;
  console.log(`edit   ${file}  ::  ${label}`);
};

const createFile = ({ file, content }) => {
  const target = abs(file);
  if (existsSync(target)) {
    console.log(`skip   ${file}  ::  exists`);
    skipped += 1;
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  changed += 1;
  console.log(`create ${file}`);
};

const edits = [
  // ---------------------------------------------------------------------------
  // 1) src/types/ai/index.ts —— 手写 request/payload 类型（对齐生成绑定）
  // ---------------------------------------------------------------------------
  {
    file: 'src/types/ai/index.ts',
    label: 'session-mode request/payload types',
    marker: 'IAiGetSessionModesRequest',
    anchor: `export interface IAiResolveApprovalRequest {
  sessionId: string;
  toolCallId: string;
  decision: string;
}`,
    replacement: `export interface IAiResolveApprovalRequest {
  sessionId: string;
  toolCallId: string;
  decision: string;
}

/**
 * ACP 会话模式查询 / 切换请求与负载（ADR-20260617 · D7-③-c）。
 *
 * thread 维度；与生成绑定 AiGetSessionModesRequest / AiSetSessionModeRequest /
 * AiSessionModesPayload 结构一致（全 camelCase、全必填）。\`modes\` 为 ACP
 * \`SessionModeState\` 原始负载逐字透传（形状 unknown），由前端 ACL
 * （from-acp-session-modes）解析为选择器 VM。
 */
export interface IAiGetSessionModesRequest {
  threadId: string;
}

export interface IAiSetSessionModeRequest {
  threadId: string;
  modeId: string;
}

export interface IAiSessionModesPayload {
  modes: unknown;
}`,
  },
  // ---------------------------------------------------------------------------
  // 2) src/types/tauri/index.ts —— ITauriService 接口
  // ---------------------------------------------------------------------------
  {
    file: 'src/types/tauri/index.ts',
    label: 'import IAiGetSessionModesRequest',
    marker: 'IAiGetSessionModesRequest',
    anchor: `  IAiConversationTitleRequest,
  IAiInlineCompletionRequest,`,
    replacement: `  IAiConversationTitleRequest,
  IAiGetSessionModesRequest,
  IAiInlineCompletionRequest,`,
  },
  {
    file: 'src/types/tauri/index.ts',
    label: 'import IAiSessionModesPayload/IAiSetSessionModeRequest',
    marker: 'IAiSessionModesPayload',
    anchor: `  IAiSaveCredentialsRequest,
  IAiSuggestionPoolPayload,`,
    replacement: `  IAiSaveCredentialsRequest,
  IAiSessionModesPayload,
  IAiSetSessionModeRequest,
  IAiSuggestionPoolPayload,`,
  },
  {
    file: 'src/types/tauri/index.ts',
    label: 'ITauriService session-mode methods',
    marker: 'aiGetSessionModes(payload: IAiGetSessionModesRequest)',
    anchor: `  aiResolveApproval(payload: IAiResolveApprovalRequest): Promise<boolean>;`,
    replacement: `  aiResolveApproval(payload: IAiResolveApprovalRequest): Promise<boolean>;
  aiGetSessionModes(payload: IAiGetSessionModesRequest): Promise<IAiSessionModesPayload | null>;
  aiSetSessionMode(payload: IAiSetSessionModeRequest): Promise<boolean>;`,
  },
  // ---------------------------------------------------------------------------
  // 3) src/services/tauri.ai.ts —— AI_COMMAND_META + Pick + impl
  // ---------------------------------------------------------------------------
  {
    file: 'src/services/tauri.ai.ts',
    label: 'AI_COMMAND_META session-mode entries',
    marker: 'ai_get_session_modes',
    anchor: `  aiApplyPatch: {
    command: 'ai_apply_patch',
    guardHint: '应用 AI Patch',
    audit: 'sensitive',
    timeoutMs: 30_000,
    measureInput: measureAiChatInput,
  },
} satisfies Record<string, ICommandMeta>;`,
    replacement: `  aiApplyPatch: {
    command: 'ai_apply_patch',
    guardHint: '应用 AI Patch',
    audit: 'sensitive',
    timeoutMs: 30_000,
    measureInput: measureAiChatInput,
  },
  aiGetSessionModes: {
    command: 'ai_get_session_modes',
    guardHint: '读取 ACP 会话可用模式',
    idempotent: true,
    audit: 'info',
    timeoutMs: 15_000,
    measureInput: buildPayloadMetrics,
  },
  aiSetSessionMode: {
    command: 'ai_set_session_mode',
    guardHint: '切换 ACP 会话模式',
    audit: 'sensitive',
    timeoutMs: 15_000,
    measureInput: buildPayloadMetrics,
  },
} satisfies Record<string, ICommandMeta>;`,
  },
  {
    file: 'src/services/tauri.ai.ts',
    label: 'TAiTauriService Pick session-mode',
    marker: `'aiGetSessionModes'`,
    anchor: `  | 'aiResolveApproval'
  | 'aiInlineComplete'`,
    replacement: `  | 'aiResolveApproval'
  | 'aiGetSessionModes'
  | 'aiSetSessionMode'
  | 'aiInlineComplete'`,
  },
  {
    file: 'src/services/tauri.ai.ts',
    label: 'aiTauriService session-mode impl',
    marker: 'AI_COMMAND_META.aiGetSessionModes,',
    anchor: `  aiResolveApproval(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiResolveApproval, payload, options, () =>
      commands.aiResolveApproval(payload),
    );
  },`,
    replacement: `  aiResolveApproval(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiResolveApproval, payload, options, () =>
      commands.aiResolveApproval(payload),
    );
  },

  aiGetSessionModes(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiGetSessionModes, payload, options, () =>
      commands.aiGetSessionModes(payload),
    );
  },

  aiSetSessionMode(payload, options?: IIpcCallOptions) {
    return runCommand(AI_COMMAND_META.aiSetSessionMode, payload, options, () =>
      commands.aiSetSessionMode(payload),
    );
  },`,
  },
  // ---------------------------------------------------------------------------
  // 4) src/services/ipc/ai.service.ts —— 薄封装委托
  // ---------------------------------------------------------------------------
  {
    file: 'src/services/ipc/ai.service.ts',
    label: 'import IAiGetSessionModesRequest',
    marker: 'IAiGetSessionModesRequest',
    anchor: `  IAiConversationTitleRequest,
  IAiInlineCompletionRequest,`,
    replacement: `  IAiConversationTitleRequest,
  IAiGetSessionModesRequest,
  IAiInlineCompletionRequest,`,
  },
  {
    file: 'src/services/ipc/ai.service.ts',
    label: 'import IAiSessionModesPayload/IAiSetSessionModeRequest',
    marker: 'IAiSessionModesPayload',
    anchor: `  IAiSaveCredentialsRequest,
  IAiSuggestionPoolPayload,`,
    replacement: `  IAiSaveCredentialsRequest,
  IAiSessionModesPayload,
  IAiSetSessionModeRequest,
  IAiSuggestionPoolPayload,`,
  },
  {
    file: 'src/services/ipc/ai.service.ts',
    label: 'aiService session-mode methods',
    marker: 'getSessionModes(',
    anchor: `  resolveAcpApproval(payload: IAiResolveApprovalRequest): Promise<boolean> {
    return tauriService.aiResolveApproval(payload);
  },`,
    replacement: `  resolveAcpApproval(payload: IAiResolveApprovalRequest): Promise<boolean> {
    return tauriService.aiResolveApproval(payload);
  },
  getSessionModes(payload: IAiGetSessionModesRequest): Promise<IAiSessionModesPayload | null> {
    return tauriService.aiGetSessionModes(payload);
  },
  setSessionMode(payload: IAiSetSessionModeRequest): Promise<boolean> {
    return tauriService.aiSetSessionMode(payload);
  },`,
  },
  // ---------------------------------------------------------------------------
  // 5) src/types/ai/sidecar.ts —— 选择器 VM
  // ---------------------------------------------------------------------------
  {
    file: 'src/types/ai/sidecar.ts',
    label: 'IAcpSessionMode VM types',
    marker: 'IAcpSessionModeState',
    anchor: `export type TAgentUiEventModeUpdate = {
  type: 'mode_update';
  modeId: string;
};`,
    replacement: `export type TAgentUiEventModeUpdate = {
  type: 'mode_update';
  modeId: string;
};

/* ----------------------------------------------------------------------------
 * ACP 会话模式选择器 VM（ADR-20260617 · D7-③-c）
 *
 * 由前端 ACL（components/business/ai/thread/projection/from-acp-session-modes）从
 * \`ai_get_session_modes\` 的原始 \`modes\`（ACP SessionModeState）解析而来；
 * \`mode_update\` UI 事件仅更新 \`currentModeId\`。VM 与 ACP wire 解耦：UI 只消费
 * 此结构，不直接触碰 ACP 原始负载。
 * -------------------------------------------------------------------------- */
export interface IAcpSessionModeOption {
  id: string;
  name: string;
  description?: string;
}

export interface IAcpSessionModeState {
  currentModeId: string | null;
  availableModes: IAcpSessionModeOption[];
}`,
  },
];

const files = [
  {
    file: 'src/components/business/ai/thread/projection/from-acp-session-modes.ts',
    content: `import type { IAcpSessionModeOption, IAcpSessionModeState } from '@/types/ai/sidecar';

/**
 * ACP 会话模式 ACL（ADR-20260617 · D7-③-c）。
 *
 * 把 \`ai_get_session_modes\` 返回的原始 \`modes\`（ACP \`SessionModeState\`，逐字透传、
 * 形状 unknown）归一到前端模式选择器 VM。ACP 形状（camelCase，见
 * agentclientprotocol.com/protocol/session-modes）：
 *   { currentModeId: string, availableModes: { id, name, description? }[] }
 *
 * 解析失败 / 非对象 / 无可用模式 一律返回 null（选择器据此整体隐藏），不抛错、
 * 不伪造默认项。currentModeId 缺失或不在 availableModes 中时回退到首项。
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const parseModeOption = (raw: unknown): IAcpSessionModeOption | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const id = readString(raw.id);
  const name = readString(raw.name);
  if (!id || !name) {
    return null;
  }
  const description = readString(raw.description);
  return description ? { id, name, description } : { id, name };
};

export const parseAcpSessionModeState = (raw: unknown): IAcpSessionModeState | null => {
  if (!isRecord(raw) || !Array.isArray(raw.availableModes)) {
    return null;
  }
  const availableModes = raw.availableModes
    .map(parseModeOption)
    .filter((mode): mode is IAcpSessionModeOption => mode !== null);
  if (availableModes.length === 0) {
    return null;
  }
  const requestedModeId = readString(raw.currentModeId);
  const currentModeId =
    requestedModeId && availableModes.some((mode) => mode.id === requestedModeId)
      ? requestedModeId
      : (availableModes[0]?.id ?? null);
  return { currentModeId, availableModes };
};

/**
 * 应用 \`mode_update\` UI 事件：仅当 modeId 命中既有可用模式时更新当前项，否则原样
 * 返回（忽略未知模式，避免选择器进入无对应项的空状态）。
 */
export const applyAcpModeUpdate = (
  state: IAcpSessionModeState,
  modeId: string,
): IAcpSessionModeState =>
  state.availableModes.some((mode) => mode.id === modeId)
    ? { ...state, currentModeId: modeId }
    : state;
`,
  },
  {
    file: 'src/components/business/ai/thread/projection/from-acp-session-modes.spec.ts',
    content: `import { describe, expect, it } from 'vitest';
import { applyAcpModeUpdate, parseAcpSessionModeState } from './from-acp-session-modes';

describe('parseAcpSessionModeState', () => {
  it('parses a well-formed ACP SessionModeState', () => {
    const state = parseAcpSessionModeState({
      currentModeId: 'code',
      availableModes: [
        { id: 'ask', name: 'Ask' },
        { id: 'code', name: 'Code', description: 'Full autonomy' },
      ],
    });
    expect(state).toEqual({
      currentModeId: 'code',
      availableModes: [
        { id: 'ask', name: 'Ask' },
        { id: 'code', name: 'Code', description: 'Full autonomy' },
      ],
    });
  });

  it('falls back to the first mode when currentModeId is missing or unknown', () => {
    expect(
      parseAcpSessionModeState({
        currentModeId: 'ghost',
        availableModes: [{ id: 'ask', name: 'Ask' }],
      })?.currentModeId,
    ).toBe('ask');
    expect(
      parseAcpSessionModeState({
        availableModes: [{ id: 'ask', name: 'Ask' }],
      })?.currentModeId,
    ).toBe('ask');
  });

  it('drops malformed mode entries', () => {
    const state = parseAcpSessionModeState({
      currentModeId: 'code',
      availableModes: [
        { id: 'code', name: 'Code' },
        { id: '', name: 'Bad' },
        { name: 'NoId' },
        'nope',
        { id: 'plan' },
      ],
    });
    expect(state?.availableModes).toEqual([{ id: 'code', name: 'Code' }]);
  });

  it('returns null for non-objects, empty lists, or missing availableModes', () => {
    expect(parseAcpSessionModeState(null)).toBeNull();
    expect(parseAcpSessionModeState('modes')).toBeNull();
    expect(parseAcpSessionModeState({})).toBeNull();
    expect(parseAcpSessionModeState({ availableModes: [] })).toBeNull();
    expect(parseAcpSessionModeState({ availableModes: [{ id: '', name: '' }] })).toBeNull();
  });
});

describe('applyAcpModeUpdate', () => {
  const base = {
    currentModeId: 'ask',
    availableModes: [
      { id: 'ask', name: 'Ask' },
      { id: 'code', name: 'Code' },
    ],
  };

  it('updates currentModeId when the mode is available', () => {
    expect(applyAcpModeUpdate(base, 'code').currentModeId).toBe('code');
  });

  it('ignores unknown mode ids', () => {
    expect(applyAcpModeUpdate(base, 'ghost')).toBe(base);
  });
});
`,
  },
];

for (const e of edits) applyEdit(e);
for (const f of files) createFile(f);

console.log(`\nD7-③-c-1 done: ${changed} change(s), ${skipped} skip(s).`);

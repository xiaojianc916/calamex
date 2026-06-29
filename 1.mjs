// 1.mjs — Slice B-front：删除前端 session/set_mode 全链路（零兼容层）
// 唯一标准管线 = config_option（session/set_config_option）。本切片仅动前端 TS：
//   删 2 文件 + 改 9 文件 + 全 src 残留扫描安全网（写盘前一票否决）。
// 运行：repo 根目录 `node 1.mjs`
import {
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, sep } from 'node:path';

const ROOT = process.cwd();

/* ---------- 基础工具 ---------- */
const toLf = (s) => s.replace(/\r\n/g, '\n');
const t = (...lines) => lines.join('\n');

function replaceOnce(content, oldStr, newStr, rel, label) {
  const idx = content.indexOf(oldStr);
  if (idx === -1) throw new Error(`[中止] 锚点未找到:${rel} · ${label}`);
  if (content.indexOf(oldStr, idx + oldStr.length) !== -1) {
    throw new Error(`[中止] 锚点不唯一:${rel} · ${label}`);
  }
  return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
}

function applyFile(rel, edits, checks) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw new Error(`[中止] 文件不存在:${rel}`);
  let content = toLf(readFileSync(abs, 'utf8'));
  for (const e of edits) content = replaceOnce(content, e.oldStr, e.newStr, rel, e.label);
  for (const c of checks) {
    if (!c.predicate(content)) throw new Error(`[中止] 自检失败:${rel} · ${c.label}`);
  }
  return { rel, abs, content };
}

const absent = (token) => ({ predicate: (c) => !c.includes(token), label: `无残留 ${token}` });
const present = (token) => ({ predicate: (c) => c.includes(token), label: `保留 ${token}` });

/* ---------- 删除目标 ---------- */
const DELETE_FILES = [
  'src/composables/ai/useAcpSessionModes.ts',
  'src/components/business/ai/thread/projection/from-acp-session-modes.ts',
];

/* ---------- 1) src/services/ipc/ai.service.ts ---------- */
const aiServiceIpc = applyFile(
  'src/services/ipc/ai.service.ts',
  [
    {
      label: 'import:去 IAiGetSessionModesRequest',
      oldStr: t(
        '  IAiEnsureAcpSessionRequest,',
        '  IAiGetSessionModesRequest,',
        '  IAiInlineCompletionRequest,',
      ),
      newStr: t('  IAiEnsureAcpSessionRequest,', '  IAiInlineCompletionRequest,'),
    },
    {
      label: 'import:去 IAiSessionModesPayload/IAiSetSessionModeRequest',
      oldStr: t(
        '  IAiSessionConfigOptionsPayload,',
        '  IAiSessionModesPayload,',
        '  IAiSetSessionConfigOptionRequest,',
        '  IAiSetSessionModeRequest,',
        '  IAiSuggestionPoolPayload,',
      ),
      newStr: t(
        '  IAiSessionConfigOptionsPayload,',
        '  IAiSetSessionConfigOptionRequest,',
        '  IAiSuggestionPoolPayload,',
      ),
    },
    {
      label: 'method:去 getSessionModes/setSessionMode',
      oldStr: t(
        '  getSessionModes(payload: IAiGetSessionModesRequest): Promise<IAiSessionModesPayload | null> {',
        '    return tauriService.aiGetSessionModes(payload);',
        '  },',
        '  setSessionMode(payload: IAiSetSessionModeRequest): Promise<boolean> {',
        '    return tauriService.aiSetSessionMode(payload);',
        '  },',
        '  getConfig(): Promise<AiConfigPayload> {',
      ),
      newStr: t('  getConfig(): Promise<AiConfigPayload> {'),
    },
  ],
  [
    absent('getSessionModes'),
    absent('setSessionMode'),
    absent('aiGetSessionModes'),
    absent('aiSetSessionMode'),
    absent('IAiGetSessionModesRequest'),
    absent('IAiSetSessionModeRequest'),
    absent('IAiSessionModesPayload'),
    present('setSessionConfigOption'),
    present('IAiSetSessionConfigOptionRequest'),
  ],
);

/* ---------- 2) src/types/ai/index.ts ---------- */
const typesAiIndex = applyFile(
  'src/types/ai/index.ts',
  [
    {
      label: 'block:去 session/set_mode 请求/负载接口',
      oldStr: t(
        'export interface IAiSessionConfigOptionsPayload {',
        '  configOptions: unknown;',
        '}',
        '',
        '/**',
        ' * ACP 会话模式查询 / 切换请求与负载（session/set_mode 协议）。',
        ' * thread 维度；与生成绑定 AiGetSessionModesRequest / AiSetSessionModeRequest /',
        ' * AiSessionModesPayload 结构一致（全 camelCase、全必填）。modeId 为 ACP SessionModeId 原值',
        ' * 逐字透传，跨层不做语义映射。modes 为 ACP SessionModeState（currentModeId + availableModes）',
        ' * 原始负载逐字透传（形状 unknown），由前端 ACL（from-acp-session-modes）解析为选择器 VM。',
        ' */',
        'export interface IAiGetSessionModesRequest {',
        '  threadId: string;',
        '}',
        '',
        'export interface IAiSetSessionModeRequest {',
        '  threadId: string;',
        '  modeId: string;',
        '}',
        '',
        'export interface IAiSessionModesPayload {',
        '  modes: unknown;',
        '}',
        '',
        'export interface IAiInlineCompletionRequest {',
      ),
      newStr: t(
        'export interface IAiSessionConfigOptionsPayload {',
        '  configOptions: unknown;',
        '}',
        '',
        'export interface IAiInlineCompletionRequest {',
      ),
    },
  ],
  [
    absent('IAiGetSessionModesRequest'),
    absent('IAiSetSessionModeRequest'),
    absent('IAiSessionModesPayload'),
    absent('from-acp-session-modes'),
    present('IAiSessionConfigOptionsPayload'),
    present('IAiInlineCompletionRequest'),
  ],
);

/* ---------- 3) src/types/ai/sidecar.ts ---------- */
const sidecarTypes = applyFile(
  'src/types/ai/sidecar.ts',
  [
    {
      label: 'block:去 IAcpSessionMode(s) + current_mode_update 事件',
      oldStr: t(
        '/* ----------------------------------------------------------------------------',
        ' * ACP 会话模式选择器 VM（session/set_mode 协议）',
        ' *',
        ' * 投影 ACP session/new|load 的 modes（SessionModeState = currentModeId + availableModes[]）。',
        ' * 前端 ACL（components/business/ai/thread/projection/from-acp-session-modes）从',
        ' * ai_get_session_modes 的原始 modes 解析。VM 与 ACP wire 解耦：UI 只消费此结构，不直接',
        ' * 触碰原始负载。当 Agent 为 Kimi 时，模式选择器直接驱动 ai_set_session_mode（复用 Kimi',
        ' * 自身的模式切换语义，绝不本地伪造），默认高亮 agent 公示的 currentModeId（如 Auto）。',
        ' *',
        ' * 形状对齐 agent-client-protocol 序列化 wire（camelCase）：',
        ' *   SessionMode      = { id, name, description? }',
        ' *   SessionModeState = { currentModeId, availableModes: SessionMode[] }',
        ' * -------------------------------------------------------------------------- */',
        'export interface IAcpSessionMode {',
        '  id: string;',
        '  name: string;',
        '  description?: string;',
        '}',
        '',
        'export interface IAcpSessionModesState {',
        '  currentModeId: string | null;',
        '  availableModes: IAcpSessionMode[];',
        '}',
        '',
        '/* ----------------------------------------------------------------------------',
        ' * ACP 会话当前模式变更 UI 事件（session/update 的 current_mode_update）',
        ' *',
        ' * 外部 agent（如 Kimi）在回合中自行切换模式时，经 session/update 下发',
        ' * current_mode_update（仅携带新的 currentModeId）。前端据此回灌模式选择器高亮，',
        ' * 不整份替换 availableModes（沿用 ai_get_session_modes 拉取的完整列表）。',
        ' * -------------------------------------------------------------------------- */',
        'export type TAgentUiEventCurrentModeUpdate = {',
        "  type: 'current_mode_update';",
        '  currentModeId: string | null;',
        '};',
        '',
        'export type TAgentUiEvent =',
      ),
      newStr: t('export type TAgentUiEvent ='),
    },
    {
      label: 'union:去 | TAgentUiEventCurrentModeUpdate',
      oldStr: t(
        '  | TAgentUiEventConfigOptionUpdate',
        '  | TAgentUiEventCurrentModeUpdate',
        "  | { type: 'approval_required'; request: IApprovalRequest }",
      ),
      newStr: t(
        '  | TAgentUiEventConfigOptionUpdate',
        "  | { type: 'approval_required'; request: IApprovalRequest }",
      ),
    },
  ],
  [
    absent('IAcpSessionMode'),
    absent('IAcpSessionModesState'),
    absent('TAgentUiEventCurrentModeUpdate'),
    absent('current_mode_update'),
    present('TAgentUiEventConfigOptionUpdate'),
    present('available_commands_update'),
  ],
);

/* ---------- 4) src/types/ai/sidecar.schema.ts ---------- */
const sidecarSchema = applyFile(
  'src/types/ai/sidecar.schema.ts',
  [
    {
      label: 'variant:去 current_mode_update z.object',
      oldStr: t(
        '  z.object({',
        "    type: z.literal('current_mode_update'),",
        '    currentModeId: z.string().nullable(),',
        '  }),',
        '  z.object({',
        "    type: z.literal('error'),",
        '    message: z.string().min(1),',
        '  }),',
      ),
      newStr: t(
        '  z.object({',
        "    type: z.literal('error'),",
        '    message: z.string().min(1),',
        '  }),',
      ),
    },
  ],
  [
    absent('current_mode_update'),
    present("z.literal('error')"),
    present("z.literal('tool_call_update')"),
  ],
);

/* ---------- 5) src/services/tauri/ai.ts ---------- */
const tauriAiService = applyFile(
  'src/services/tauri/ai.ts',
  [
    {
      label: 'meta:去 aiGetSessionModes/aiSetSessionMode 元数据',
      oldStr: t(
        '  aiGetSessionModes: {',
        "    command: 'ai_get_session_modes',",
        "    guardHint: '读取 ACP 会话可用模式',",
        '    idempotent: true,',
        "    audit: 'info',",
        '    timeoutMs: 15_000,',
        '    measureInput: buildPayloadMetrics,',
        '  },',
        '  aiSetSessionMode: {',
        "    command: 'ai_set_session_mode',",
        "    guardHint: '切换 ACP 会话模式',",
        "    audit: 'sensitive',",
        '    timeoutMs: 15_000,',
        '    measureInput: buildPayloadMetrics,',
        '  },',
        '} satisfies Record<string, ICommandMeta>;',
      ),
      newStr: t('} satisfies Record<string, ICommandMeta>;'),
    },
    {
      label: 'pick:去 aiGetSessionModes/aiSetSessionMode',
      oldStr: t(
        "  | 'aiSetSessionConfigOption'",
        "  | 'aiGetSessionModes'",
        "  | 'aiSetSessionMode'",
        "  | 'aiInlineComplete'",
      ),
      newStr: t("  | 'aiSetSessionConfigOption'", "  | 'aiInlineComplete'"),
    },
    {
      label: 'impl:去 aiGetSessionModes/aiSetSessionMode 方法',
      oldStr: t(
        '  aiGetSessionModes: payloadCommand(AI_COMMAND_META.aiGetSessionModes, (payload) =>',
        '    commands.aiGetSessionModes(payload),',
        '  ),',
        '',
        '  aiSetSessionMode: payloadCommand(AI_COMMAND_META.aiSetSessionMode, (payload) =>',
        '    commands.aiSetSessionMode(payload),',
        '  ),',
        '',
        '  aiInlineComplete: payloadCommand(AI_COMMAND_META.aiInlineComplete, (payload) =>',
      ),
      newStr: t(
        '  aiInlineComplete: payloadCommand(AI_COMMAND_META.aiInlineComplete, (payload) =>',
      ),
    },
  ],
  [
    absent('aiGetSessionModes'),
    absent('aiSetSessionMode'),
    absent('ai_get_session_modes'),
    absent('ai_set_session_mode'),
    present('aiSetSessionConfigOption'),
    present('ai_set_session_config_option'),
  ],
);

/* ---------- 6) src/types/tauri/index.ts ---------- */
const tauriTypesIndex = applyFile(
  'src/types/tauri/index.ts',
  [
    {
      label: 'import:去 IAiGetSessionModesRequest',
      oldStr: t(
        '  IAiEnsureAcpSessionRequest,',
        '  IAiGetSessionModesRequest,',
        '  IAiInlineCompletionRequest,',
      ),
      newStr: t('  IAiEnsureAcpSessionRequest,', '  IAiInlineCompletionRequest,'),
    },
    {
      label: 'import:去 IAiSessionModesPayload/IAiSetSessionModeRequest',
      oldStr: t(
        '  IAiSessionConfigOptionsPayload,',
        '  IAiSessionModesPayload,',
        '  IAiSetSessionConfigOptionRequest,',
        '  IAiSetSessionModeRequest,',
        '  IAiSuggestionPoolPayload,',
      ),
      newStr: t(
        '  IAiSessionConfigOptionsPayload,',
        '  IAiSetSessionConfigOptionRequest,',
        '  IAiSuggestionPoolPayload,',
      ),
    },
    {
      label: 'iface:去 aiGetSessionModes/aiSetSessionMode 声明',
      oldStr: t(
        '  aiGetSessionModes(payload: IAiGetSessionModesRequest): Promise<IAiSessionModesPayload | null>;',
        '  aiSetSessionMode(payload: IAiSetSessionModeRequest): Promise<boolean>;',
        '  aiInlineComplete(payload: IAiInlineCompletionRequest): Promise<AiInlineCompletionResult>;',
      ),
      newStr: t(
        '  aiInlineComplete(payload: IAiInlineCompletionRequest): Promise<AiInlineCompletionResult>;',
      ),
    },
  ],
  [
    absent('aiGetSessionModes'),
    absent('aiSetSessionMode'),
    absent('IAiGetSessionModesRequest'),
    absent('IAiSetSessionModeRequest'),
    absent('IAiSessionModesPayload'),
    present('aiSetSessionConfigOption'),
    present('IAiSetSessionConfigOptionRequest'),
  ],
);

/* ---------- 7-9) 三个 sibling composable 的陈旧 doc-comment 改指存活兄弟 ---------- */
const useAcpAvailableCommands = applyFile(
  'src/composables/ai/useAcpAvailableCommands.ts',
  [
    {
      label: 'doc:改指 useAcpSessionConfigOptions',
      oldStr: ' * 设计取舍（与 useAcpSessionModes 一致，不自创）：',
      newStr: ' * 设计取舍（与 useAcpSessionConfigOptions 一致，不自创）：',
    },
  ],
  [absent('useAcpSessionModes'), present('useAcpSessionConfigOptions')],
);

const useAcpTerminals = applyFile(
  'src/composables/ai/useAcpTerminals.ts',
  [
    {
      label: 'doc:改指 useAcpSessionConfigOptions',
      oldStr: ' * 设计取舍（与 useAcpAvailableCommands / useAcpSessionModes 一致，不自创）：',
      newStr: ' * 设计取舍（与 useAcpAvailableCommands / useAcpSessionConfigOptions 一致，不自创）：',
    },
  ],
  [absent('useAcpSessionModes'), present('useAcpSessionConfigOptions')],
);

const useAcpUsage = applyFile(
  'src/composables/ai/useAcpUsage.ts',
  [
    {
      label: 'doc:改指 useAcpSessionConfigOptions',
      oldStr: ' * 设计取舍（与 useAcpAvailableCommands / useAcpSessionModes 一致，不自创）：',
      newStr: ' * 设计取舍（与 useAcpAvailableCommands / useAcpSessionConfigOptions 一致，不自创）：',
    },
  ],
  [absent('useAcpSessionModes'), present('useAcpSessionConfigOptions')],
);

/* ---------- 全 src 残留扫描安全网（写盘前一票否决）---------- */
const EDITED_FILES = [
  aiServiceIpc,
  typesAiIndex,
  sidecarTypes,
  sidecarSchema,
  tauriAiService,
  tauriTypesIndex,
  useAcpAvailableCommands,
  useAcpTerminals,
  useAcpUsage,
];
const EDITED = new Map(EDITED_FILES.map((f) => [f.rel, f.content]));
const SCAN_EXTS = ['.ts', '.tsx', '.vue', '.js', '.mjs'];
const EXCLUDE_DIRS = ['src/bindings'];
const FORBIDDEN = [
  'useAcpSessionModes',
  'from-acp-session-modes',
  'IAcpSessionMode',
  'IAcpSessionModesState',
  'current_mode_update',
  'TAgentUiEventCurrentModeUpdate',
  'getSessionModes',
  'setSessionMode',
  'aiGetSessionModes',
  'aiSetSessionMode',
  'IAiGetSessionModesRequest',
  'IAiSetSessionModeRequest',
  'IAiSessionModesPayload',
];

const rel = (abs) => abs.slice(ROOT.length + 1).split(sep).join('/');
function walk(dirAbs, out) {
  for (const name of readdirSync(dirAbs)) {
    const abs = join(dirAbs, name);
    const r = rel(abs);
    if (statSync(abs).isDirectory()) {
      if (r === 'node_modules' || EXCLUDE_DIRS.includes(r)) continue;
      walk(abs, out);
    } else if (SCAN_EXTS.some((e) => name.endsWith(e))) {
      out.push(abs);
    }
  }
}

const files = [];
walk(join(ROOT, 'src'), files);
const hits = [];
for (const abs of files) {
  const r = rel(abs);
  if (DELETE_FILES.includes(r)) continue; // 即将删除，跳过
  const content = EDITED.get(r) ?? toLf(readFileSync(abs, 'utf8'));
  content.split('\n').forEach((line, i) => {
    for (const token of FORBIDDEN) {
      if (line.includes(token)) hits.push(`${r}:${i + 1} · ${token}`);
    }
  });
}
if (hits.length > 0) {
  throw new Error(
    `[中止] 仍有 session/set_mode 残留消费点（未写盘）：\n  ${hits.join('\n  ')}`,
  );
}

/* ---------- 全部校验通过：写盘 + 删除 ---------- */
for (const f of EDITED_FILES) {
  writeFileSync(f.abs, f.content, 'utf8'); // LF
  console.log(`改 ${f.rel}`);
}
for (const r of DELETE_FILES) {
  const abs = join(ROOT, r);
  if (!existsSync(abs)) throw new Error(`[中止] 删除目标不存在:${r}`);
  rmSync(abs);
  console.log(`删 ${r}`);
}
console.log('\nSlice B-front 完成：前端 session/set_mode 全链路已移除。');
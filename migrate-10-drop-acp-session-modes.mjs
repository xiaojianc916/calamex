#!/usr/bin/env node
// migrate-10-drop-acp-session-modes.mjs  (诊断版：零破坏 + 全有或全无)
// 行为：
//   1) 对所有目标文件做 dry-run 试匹配；
//   2) 只要有任一【必需】锚点未命中 → 不写任何文件、不删任何文件，打印未命中报告并退出 1；
//   3) 全部命中 → 才统一落盘 + 删除文件。
//   sentinel 命中判定保证幂等（已清理过的文件直接 skip）。
// 运行（仓库根）：node migrate-10-drop-acp-session-modes.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const J = (...lines) => lines.join('\n');
const cut = (...lines) => ({ find: J(...lines), replace: '' });
const cutOpt = (...lines) => ({ find: J(...lines), replace: '', optional: true });
const sub = (findLines, replaceLines) => ({ find: J(...findLines), replace: J(...replaceLines) });

// ── 诊断：从未命中锚点里挑最长标识符，列出本地文件里含该标识符的行（带行号）──
function probeReport(body, find) {
  const firstLine = find.split('\n').find((l) => l.trim().length > 0) ?? '';
  const tokens = firstLine.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [];
  const probe = tokens.sort((a, b) => b.length - a.length)[0];
  if (!probe) return { probe: '(none)', hits: [] };
  const hits = [];
  body.split('\n').forEach((l, i) => {
    if (l.includes(probe)) hits.push(`  ${String(i + 1).padStart(4)}| ${l}`);
  });
  return { probe, hits: hits.slice(0, 10) };
}

// ── 编辑定义（对 96b4020 已逐字校验）────────────────────────────────────────
const FILES = [
  {
    rel: 'src/components/business/ai/chat/AiPromptInput.vue',
    sentinel: 'IAcpSessionModeState',
    edits: [
      cut("import type { IAcpSessionModeState } from '@/types/ai/sidecar';", ''),
      cut('  sessionModes?: IAcpSessionModeState | null;', '  isSessionModeSwitching?: boolean;', ''),
      cut('  sessionModeChange: [modeId: string];', ''),
      cutOpt(
        '// ACP 会话模式选择器（ADR-20260617 · D7-c）：仅在 Kimi ACP agent 且后端提供了可用',
        '// 模式时显示；VM 由父级经 useAcpSessionModes 下传，选择时回投 modeId 原文。',
        '',
      ),
      cut(
        'const sessionModeOptions = computed(() => props.sessionModes?.availableModes ?? []);',
        '',
        'const sessionModeSelectorVisible = computed(',
        "  () => selectedAgent.value === 'kimi' && sessionModeOptions.value.length > 0,",
        ');',
        '',
        "const currentSessionModeId = computed(() => props.sessionModes?.currentModeId ?? '');",
        '',
        'const currentSessionModeLabel = computed(() => {',
        '  const modes = sessionModeOptions.value;',
        '  const current = modes.find((mode) => mode.id === currentSessionModeId.value);',
        "  return current?.name ?? modes[0]?.name ?? '模式';",
        '});',
        '',
        'const handleSessionModeChange = (value: unknown): void => {',
        "  if (typeof value !== 'string' || !value.trim() || value === currentSessionModeId.value) {",
        '    return;',
        '  }',
        "  emit('sessionModeChange', value);",
        '};',
        '',
        '',
      ),
      cut(
        '            <Select',
        '              v-if="sessionModeSelectorVisible"',
        '              :model-value="currentSessionModeId"',
        '              :disabled="disabled || isSessionModeSwitching"',
        '              @update:model-value="handleSessionModeChange"',
        '            >',
        '              <SelectTrigger aria-label="选择会话模式" class="ai-agent-trigger">',
        '                <Route class="ai-agent-trigger__icon" :stroke-width="1.6" />',
        '                <span class="ai-agent-trigger__label" v-text="currentSessionModeLabel"></span>',
        '              </SelectTrigger>',
        '              <SelectContent side="top" align="start" :side-offset="8" class="ai-agent-content">',
        '                <SelectLabel class="ai-agent-section-label">会话模式</SelectLabel>',
        '                <SelectGroup>',
        '                  <SelectItem',
        '                    v-for="mode in sessionModeOptions"',
        '                    :key="mode.id"',
        '                    class="ai-agent-item"',
        '                    :value="mode.id"',
        '                  >',
        '                    <span class="ai-agent-item__label" v-text="mode.name"></span>',
        '                  </SelectItem>',
        '                </SelectGroup>',
        '              </SelectContent>',
        '            </Select>',
        '',
      ),
    ],
  },
  {
    rel: 'src/components/business/ai/shell/AiAssistantPanel.vue',
    sentinel: 'acpSessionModes',
    edits: [
      sub(
        [
          'const handleAgentBackendChange = (agent: TSessionAgentBackend): void => {',
          "  assistant.error.value = '';",
          '',
          "  if (agent === 'kimi') {",
          '    const threadId = assistant.activeConversationId.value;',
          '',
          '    if (threadId) {',
          '      void assistant.acpSessionModes.loadModes(threadId).catch(() => undefined);',
          '    }',
          '  }',
          '};',
        ],
        [
          'const handleAgentBackendChange = (_agent: TSessionAgentBackend): void => {',
          "  assistant.error.value = '';",
          '};',
        ],
      ),
      cutOpt(
        '// ACP 会话模式切换(ADR-20260617 · D7-③-c 发送侧):选择器回投透传给',
        '// useAcpSessionModes.selectMode(乐观更新 + setSessionMode 回投,失败回滚并提示)。',
        '',
      ),
      cut(
        'const handleSessionModeChange = async (modeId: string): Promise<void> => {',
        '  try {',
        '    await assistant.acpSessionModes.selectMode(modeId);',
        '  } catch (error) {',
        "    assistant.error.value = toErrorMessage(error, '切换会话模式失败。');",
        '  }',
        '};',
        '',
        '',
      ),
      cut(
        '          :session-modes="assistant.acpSessionModes.state.value"',
        '          :is-session-mode-switching="assistant.acpSessionModes.isSwitching.value"',
        '',
      ),
      cut('          @session-mode-change="handleSessionModeChange"', ''),
    ],
  },
  {
    rel: 'src/composables/ai/useAiAssistant.ts',
    sentinel: 'useAcpSessionModes',
    edits: [
      cut("import { useAcpSessionModes } from '@/composables/ai/useAcpSessionModes';", ''),
      cut('  const acpSessionModes = useAcpSessionModes();', ''),
      cut(
        "        case 'mode_update':",
        '          acpSessionModes.applyModeUpdate(event.modeId);',
        '          break;',
        '',
      ),
      cut('    acpSessionModes.reset();', ''),
      cut('    acpSessionModes,', ''),
    ],
  },
  {
    rel: 'src/services/ipc/ai.service.ts',
    sentinel: 'aiGetSessionModes',
    edits: [
      cut('  IAiGetSessionModesRequest,', ''),
      cut('  IAiSessionModesPayload,', ''),
      cut('  IAiSetSessionModeRequest,', ''),
      cut(
        '  getSessionModes(payload: IAiGetSessionModesRequest): Promise<IAiSessionModesPayload | null> {',
        '    return tauriService.aiGetSessionModes(payload);',
        '  },',
        '  setSessionMode(payload: IAiSetSessionModeRequest): Promise<boolean> {',
        '    return tauriService.aiSetSessionMode(payload);',
        '  },',
        '',
      ),
    ],
  },
  {
    rel: 'src/services/tauri.ai.ts',
    sentinel: 'ai_get_session_modes',
    edits: [
      cut(
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
        '',
      ),
      cut("  | 'aiGetSessionModes'", "  | 'aiSetSessionMode'", ''),
      cut(
        '  aiGetSessionModes(payload, options?: IIpcCallOptions) {',
        '    return runCommand(AI_COMMAND_META.aiGetSessionModes, payload, options, () =>',
        '      commands.aiGetSessionModes(payload),',
        '    );',
        '  },',
        '',
        '  aiSetSessionMode(payload, options?: IIpcCallOptions) {',
        '    return runCommand(AI_COMMAND_META.aiSetSessionMode, payload, options, () =>',
        '      commands.aiSetSessionMode(payload),',
        '    );',
        '  },',
        '',
        '',
      ),
    ],
  },
  {
    rel: 'src/types/ai/index.ts',
    sentinel: 'IAiGetSessionModesRequest',
    edits: [
      cutOpt(
        '/**',
        ' * ACP 会话模式查询 / 切换请求与负载（ADR-20260617 · D7-③-c）。',
        ' *',
        ' * thread 维度；与生成绑定 AiGetSessionModesRequest / AiSetSessionModeRequest /',
        ' * AiSessionModesPayload 结构一致（全 camelCase、全必填）。`modes` 为 ACP',
        ' * `SessionModeState` 原始负载逐字透传（形状 unknown），由前端 ACL',
        ' * （from-acp-session-modes）解析为选择器 VM。',
        ' */',
        '',
      ),
      cut(
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
        '',
      ),
    ],
  },
  {
    rel: 'src/types/tauri/index.ts',
    sentinel: 'IAiGetSessionModesRequest',
    edits: [
      cut('  IAiGetSessionModesRequest,', ''),
      cut('  IAiSessionModesPayload,', ''),
      cut('  IAiSetSessionModeRequest,', ''),
      cut(
        '  aiGetSessionModes(payload: IAiGetSessionModesRequest): Promise<IAiSessionModesPayload | null>;',
        '  aiSetSessionMode(payload: IAiSetSessionModeRequest): Promise<boolean>;',
        '',
      ),
    ],
  },
  {
    rel: 'src/types/ai/sidecar.ts',
    sentinel: 'IAcpSessionModeState',
    edits: [
      cut('  | TAgentUiEventModeUpdate', ''),
      cut(
        'export type TAgentUiEventModeUpdate = {',
        "  type: 'mode_update';",
        '  modeId: string;',
        '};',
        '',
        '',
      ),
      cut(
        'export interface IAcpSessionModeOption {',
        '  id: string;',
        '  name: string;',
        '  description?: string;',
        '}',
        '',
        'export interface IAcpSessionModeState {',
        '  currentModeId: string | null;',
        '  availableModes: IAcpSessionModeOption[];',
        '}',
        '',
        '',
      ),
      cutOpt(
        '/* ----------------------------------------------------------------------------',
        ' * ACP 会话模式切换 UI 事件（ADR-20260617 · D7-③-b）',
        ' *',
        ' * 投影 ACP `session/update` 的 `current_mode_update`（外部 agent 自行切换当前会话模式，',
        ' * 见 Rust host src-tauri/src/acp/ui_event.rs）：仅携带切换后的 `modeId`（ACP `currentModeId`',
        ' * 原值，逐字透传，不本地映射）。可用模式清单另由会话建立时的 `NewSessionResponse.modes`',
        ' * 提供（见后续 slice）；本事件只负责「当前模式已变更」信号，交前端模式选择器 VM 据',
        ' * `modeId` 高亮当前项。',
        ' * -------------------------------------------------------------------------- */',
        '',
      ),
      cutOpt(
        '/* ----------------------------------------------------------------------------',
        ' * ACP 会话模式选择器 VM（ADR-20260617 · D7-③-c）',
        ' *',
        ' * 由前端 ACL（components/business/ai/thread/projection/from-acp-session-modes）从',
        ' * `ai_get_session_modes` 的原始 `modes`（ACP SessionModeState）解析而来；',
        ' * `mode_update` UI 事件仅更新 `currentModeId`。VM 与 ACP wire 解耦：UI 只消费',
        ' * 此结构，不直接触碰 ACP 原始负载。',
        ' * -------------------------------------------------------------------------- */',
        '',
      ),
    ],
  },
];

const DELETES = [
  'src/composables/ai/useAcpSessionModes.ts',
  'src/composables/ai/useAcpSessionModes.spec.ts',
  'src/components/business/ai/thread/projection/from-acp-session-modes.ts',
  'src/components/business/ai/thread/projection/from-acp-session-modes.spec.ts',
];

// ── Phase 1：dry-run，零写入 ────────────────────────────────────────────────
const planned = [];
const misses = [];

for (const f of FILES) {
  const abs = path.join(ROOT, f.rel);
  if (!fs.existsSync(abs)) {
    misses.push({ rel: f.rel, missingFile: true });
    continue;
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const crlf = raw.includes('\r\n');
  const orig = crlf ? raw.replace(/\r\n/g, '\n') : raw;

  if (f.sentinel && !orig.includes(f.sentinel)) {
    console.log(`skip   (already clean): ${f.rel}`);
    continue;
  }

  let body = orig;
  let fileMissed = false;
  for (const e of f.edits) {
    const n = body.split(e.find).length - 1;
    if (n === 1) {
      body = body.split(e.find).join(e.replace);
    } else if (e.optional && n === 0) {
      // 可选锚点未命中：忽略
    } else {
      fileMissed = true;
      misses.push({ rel: f.rel, find: e.find, count: n, ...probeReport(orig, e.find) });
    }
  }
  if (fileMissed) console.log(`defer  (anchor miss): ${f.rel}`);
  else planned.push({ rel: f.rel, abs, body, crlf, changed: body !== orig });
}

if (misses.length > 0) {
  console.log('\n==================== 未命中锚点报告（未写入任何文件） ====================');
  for (const m of misses) {
    console.log(`\n● 文件: ${m.rel}`);
    if (m.missingFile) {
      console.log('  文件不存在。');
      continue;
    }
    console.log(`  期望 1 处匹配，实际 ${m.count} 处。探针标识符: ${m.probe}`);
    console.log('  --- 期望锚点 FIND ---');
    console.log(m.find.split('\n').map((l) => `    ${l}`).join('\n'));
    console.log('  --- 本地实际相关行 ---');
    console.log(m.hits.length ? m.hits.join('\n') : '    (本地未找到该标识符)');
  }
  console.log('\n把以上报告整段贴回来，我据此对齐你本地真实文本后再给最终版。');
  process.exit(1);
}

// ── Phase 2：统一落盘 + 删除 ────────────────────────────────────────────────
for (const p of planned) {
  fs.writeFileSync(p.abs, p.crlf ? p.body.replace(/\n/g, '\r\n') : p.body, 'utf8');
  console.log(`patch  (done): ${p.rel}`);
}
for (const rel of DELETES) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) {
    fs.rmSync(abs, { force: true });
    console.log(`delete (done): ${rel}`);
  } else {
    console.log(`delete (skip, absent): ${rel}`);
  }
}
console.log('\nmigrate-10 done. 下一步：FE typecheck + lint + test。');
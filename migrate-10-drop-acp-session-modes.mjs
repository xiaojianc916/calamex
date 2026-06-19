#!/usr/bin/env node
// migrate-10-drop-acp-session-modes.mjs
// 删除 ACP 会话模式（session modes）整条死代码：8 文件改写 + 4 文件删除。
// 体检式：任一必需锚点未命中 => 打印报告并 exit(1)，不写不删任何文件。
import fs from 'node:fs';

const J = (...lines) => lines.join('\n');
const cut = (...lines) => ({ find: J(...lines) + '\n', replace: '', optional: false });
const cutOpt = (...lines) => ({ find: J(...lines) + '\n', replace: '', optional: true });

const FILES = [
  {
    rel: 'src/components/business/ai/chat/AiPromptInput.vue',
    sentinel: 'IAcpSessionModeState',
    edits: [
      // 本地为分组 import：只删该成员行
      cut('  IAcpSessionModeState,'),
      // props
      cut('  sessionModes?: IAcpSessionModeState | null;', '  isSessionModeSwitching?: boolean;'),
      // emit
      cut('  sessionModeChange: [modeId: string];'),
      // computeds 上方注释（可选）
      cutOpt(
        '// ACP 会话模式选择器（ADR-20260617 · D7-c）：仅在 Kimi ACP agent 且后端提供了可用',
        '// 模式时显示；VM 由父级经 useAcpSessionModes 下传，选择时回投 modeId 原文。',
      ),
      // 5 个 computed + handler 整块（含块内空行）+ 尾随空行
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
      ),
      // 模板里的会话模式 <Select> 整块
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
      ),
    ],
  },
  {
    rel: 'src/components/business/ai/shell/AiAssistantPanel.vue',
    sentinel: 'acpSessionModes',
    edits: [
      // 本地 handleAgentBackendChange 里只删 modes 加载这一行（保留 loadConfigOptions 与整函数）
      cut('      void assistant.acpSessionModes.loadModes(threadId).catch(() => undefined);'),
      // handleSessionModeChange 上方注释（可选）
      cutOpt(
        '// ACP 会话模式切换（ADR-20260617 · D7-③-c 发送侧）：选择器回投透传给',
        '// useAcpSessionModes.selectMode（乐观更新 + setSessionMode 回投，失败回滚并提示）。',
      ),
      // handleSessionModeChange 函数 + 尾随空行
      cut(
        'const handleSessionModeChange = async (modeId: string): Promise<void> => {',
        '  try {',
        '    await assistant.acpSessionModes.selectMode(modeId);',
        '  } catch (error) {',
        "    assistant.error.value = toErrorMessage(error, '切换会话模式失败。');",
        '  }',
        '};',
        '',
      ),
      // 模板上的两条 modes 绑定
      cut(
        '          :session-modes="assistant.acpSessionModes.state.value"',
        '          :is-session-mode-switching="assistant.acpSessionModes.isSwitching.value"',
      ),
      // 模板上的 modes 事件
      cut('          @session-mode-change="handleSessionModeChange"'),
    ],
  },
  {
    rel: 'src/composables/ai/useAiAssistant.ts',
    sentinel: 'useAcpSessionModes',
    edits: [
      cut("import { useAcpSessionModes } from '@/composables/ai/useAcpSessionModes';"),
      cut('  const acpSessionModes = useAcpSessionModes();'),
      cut(
        "        case 'mode_update':",
        '          acpSessionModes.applyModeUpdate(event.modeId);',
        '          break;',
      ),
      cut('    acpSessionModes.reset();'),
      cut('    acpSessionModes,'),
    ],
  },
  {
    rel: 'src/services/ipc/ai.service.ts',
    sentinel: 'IAiGetSessionModesRequest',
    edits: [
      cut('  IAiGetSessionModesRequest,'),
      cut('  IAiSessionModesPayload,', '  IAiSetSessionModeRequest,'),
      cut(
        '  getSessionModes(payload: IAiGetSessionModesRequest): Promise<IAiSessionModesPayload | null> {',
        '    return tauriService.aiGetSessionModes(payload);',
        '  },',
        '  setSessionMode(payload: IAiSetSessionModeRequest): Promise<boolean> {',
        '    return tauriService.aiSetSessionMode(payload);',
        '  },',
      ),
    ],
  },
  {
    rel: 'src/services/tauri.ai.ts',
    sentinel: 'ai_get_session_modes',
    edits: [
      // AI_COMMAND_META 两条
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
      ),
      // Pick 成员两条
      cut("  | 'aiGetSessionModes'", "  | 'aiSetSessionMode'"),
      // 实现方法两条（含中间/尾随空行）
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
      ),
    ],
  },
  {
    rel: 'src/types/ai/index.ts',
    sentinel: 'IAiGetSessionModesRequest',
    edits: [
      // 注释（可选）
      cutOpt(
        '/**',
        ' * ACP 会话模式查询 / 切换请求与负载（ADR-20260617 · D7-③-c）。',
        ' *',
        ' * thread 维度；与生成绑定 AiGetSessionModesRequest / AiSetSessionModeRequest /',
        ' * AiSessionModesPayload 结构一致（全 camelCase、全必填）。`modes` 为 ACP',
        ' * `SessionModeState` 原始负载逐字透传（形状 unknown），由前端 ACL',
        ' * （from-acp-session-modes）解析为选择器 VM。',
        ' */',
      ),
      // 三个接口 + 尾随空行
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
      ),
    ],
  },
  {
    rel: 'src/types/tauri/index.ts',
    sentinel: 'IAiGetSessionModesRequest',
    edits: [
      cut('  IAiGetSessionModesRequest,'),
      cut('  IAiSessionModesPayload,', '  IAiSetSessionModeRequest,'),
      cut(
        '  aiGetSessionModes(payload: IAiGetSessionModesRequest): Promise<IAiSessionModesPayload | null>;',
        '  aiSetSessionMode(payload: IAiSetSessionModeRequest): Promise<boolean>;',
      ),
    ],
  },
  {
    rel: 'src/types/ai/sidecar.ts',
    sentinel: 'IAcpSessionModeState',
    edits: [
      // 联合成员
      cut('  | TAgentUiEventModeUpdate'),
      // mode_update 注释（可选）
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
      ),
      // mode_update 类型 + 尾随空行
      cut(
        'export type TAgentUiEventModeUpdate = {',
        "  type: 'mode_update';",
        '  modeId: string;',
        '};',
        '',
      ),
      // 选择器 VM 注释（可选）
      cutOpt(
        '/* ----------------------------------------------------------------------------',
        ' * ACP 会话模式选择器 VM（ADR-20260617 · D7-③-c）',
        ' *',
        ' * 由前端 ACL（components/business/ai/thread/projection/from-acp-session-modes）从',
        ' * `ai_get_session_modes` 的原始 `modes`（ACP SessionModeState）解析而来；',
        ' * `mode_update` UI 事件仅更新 `currentModeId`。VM 与 ACP wire 解耦：UI 只消费',
        ' * 此结构，不直接触碰 ACP 原始负载。',
        ' * -------------------------------------------------------------------------- */',
      ),
      // 两个接口 + 尾随空行
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

const probeReport = (body, find) => {
  const firstLine = find.split('\n').find((l) => l.trim().length > 0) ?? '';
  const ids = firstLine.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [];
  const probe = ids.slice().sort((a, b) => b.length - a.length)[0] ?? firstLine.trim();
  const lines = body.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < 10; i += 1) {
    if (lines[i].includes(probe)) hits.push(`${i + 1}| ${lines[i]}`);
  }
  return { probe, hits };
};

const planned = [];
const misses = [];

for (const file of FILES) {
  if (!fs.existsSync(file.rel)) {
    misses.push({ rel: file.rel, fatal: '文件不存在' });
    continue;
  }
  const raw = fs.readFileSync(file.rel, 'utf8');
  const usedCRLF = raw.includes('\r\n');
  const body = raw.replace(/\r\n/g, '\n');

  // 整文件已迁移（哨兵消失）=> 视为干净，跳过
  if (file.sentinel && !body.includes(file.sentinel)) {
    continue;
  }

  let next = body;
  let fileHadMiss = false;
  for (const edit of file.edits) {
    const n = next.split(edit.find).length - 1;
    if (n === 1) {
      next = next.split(edit.find).join(edit.replace);
    } else if (edit.optional && n === 0) {
      // 可选锚点缺失：忽略
    } else {
      fileHadMiss = true;
      misses.push({ rel: file.rel, find: edit.find, count: n, ...probeReport(body, edit.find) });
    }
  }

  if (fileHadMiss) {
    console.log(`defer  (anchor miss): ${file.rel}`);
  } else {
    planned.push({ rel: file.rel, content: usedCRLF ? next.replace(/\n/g, '\r\n') : next });
  }
}

if (misses.length > 0) {
  console.log('\n==================== 未命中锚点报告（未写入任何文件） ====================\n');
  for (const m of misses) {
    console.log(`● 文件: ${m.rel}`);
    if (m.fatal) {
      console.log(`  ${m.fatal}`);
      console.log('');
      continue;
    }
    console.log(`期望 1 处匹配，实际 ${m.count} 处。探针标识符: ${m.probe}`);
    console.log('--- 期望锚点 FIND ---');
    console.log(m.find);
    console.log('--- 本地实际相关行 ---');
    console.log(m.hits.length ? m.hits.join('\n') : '（未找到包含该标识符的行）');
    console.log('');
  }
  console.log('把以上报告整段贴回来，我据此对齐你本地真实文本后再给最终版。');
  process.exit(1);
}

for (const p of planned) {
  fs.writeFileSync(p.rel, p.content, 'utf8');
}
let deleted = 0;
for (const rel of DELETES) {
  if (fs.existsSync(rel)) {
    fs.rmSync(rel);
    deleted += 1;
  }
}
console.log(`patch/delete done: 改写 ${planned.length} 个文件，删除 ${deleted} 个文件（共 ${DELETES.length} 个目标，存在即删）。`);
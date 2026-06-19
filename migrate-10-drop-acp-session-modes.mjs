// migrate-10-drop-acp-session-modes.mjs
// 退役 ACP 会话模式（session modes）整条前端链路。全有或全无：任一锚点未命中则不写任何文件。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const J = (...lines) => lines.join('\n');
const cut = (...lines) => ({ find: J(...lines) + '\n', replace: '', optional: false });
const cutOpt = (...lines) => ({ find: J(...lines) + '\n', replace: '', optional: true });

const FILES = [
  {
    file: 'src/components/business/ai/chat/AiPromptInput.vue',
    sentinel: 'IAcpSessionModeState',
    edits: [
      // 分组 import 成员（本地为多行分组导入）
      cut(`  IAcpSessionModeState,`),
      // props
      cut(`  sessionModes?: IAcpSessionModeState | null;`, `  isSessionModeSwitching?: boolean;`),
      // emit
      cut(`  sessionModeChange: [modeId: string];`),
      // 注释 + computed/handler 块
      cutOpt(
        `// ACP 会话模式选择器（ADR-20260617 · D7-c）：仅在 Kimi ACP agent 且后端提供了可用`,
        `// 模式时显示；VM 由父级经 useAcpSessionModes 下传，选择时回投 modeId 原文。`,
      ),
      cut(
        `const sessionModeOptions = computed(() => props.sessionModes?.availableModes ?? []);`,
        ``,
        `const sessionModeSelectorVisible = computed(`,
        `  () => selectedAgent.value === 'kimi' && sessionModeOptions.value.length > 0,`,
        `);`,
        ``,
        `const currentSessionModeId = computed(() => props.sessionModes?.currentModeId ?? '');`,
        ``,
        `const currentSessionModeLabel = computed(() => {`,
        `  const modes = sessionModeOptions.value;`,
        `  const current = modes.find((mode) => mode.id === currentSessionModeId.value);`,
        `  return current?.name ?? modes[0]?.name ?? '模式';`,
        `});`,
        ``,
        `const handleSessionModeChange = (value: unknown): void => {`,
        `  if (typeof value !== 'string' || !value.trim() || value === currentSessionModeId.value) {`,
        `    return;`,
        `  }`,
        `  emit('sessionModeChange', value);`,
        `};`,
        ``,
      ),
      // 模板里的会话模式 <Select>
      cut(
        `            <Select`,
        `              v-if="sessionModeSelectorVisible"`,
        `              :model-value="currentSessionModeId"`,
        `              :disabled="disabled || isSessionModeSwitching"`,
        `              @update:model-value="handleSessionModeChange"`,
        `            >`,
        `              <SelectTrigger aria-label="选择会话模式" class="ai-agent-trigger">`,
        `                <Route class="ai-agent-trigger__icon" :stroke-width="1.6" />`,
        `                <span class="ai-agent-trigger__label" v-text="currentSessionModeLabel"></span>`,
        `              </SelectTrigger>`,
        `              <SelectContent side="top" align="start" :side-offset="8" class="ai-agent-content">`,
        `                <SelectLabel class="ai-agent-section-label">会话模式</SelectLabel>`,
        `                <SelectGroup>`,
        `                  <SelectItem`,
        `                    v-for="mode in sessionModeOptions"`,
        `                    :key="mode.id"`,
        `                    class="ai-agent-item"`,
        `                    :value="mode.id"`,
        `                  >`,
        `                    <span class="ai-agent-item__label" v-text="mode.name"></span>`,
        `                  </SelectItem>`,
        `                </SelectGroup>`,
        `              </SelectContent>`,
        `            </Select>`,
      ),
    ],
  },

  {
    file: 'src/components/business/ai/shell/AiAssistantPanel.vue',
    sentinel: 'acpSessionModes',
    edits: [
      // handleAgentBackendChange 里仅删 loadModes 这一行（本地另有 loadConfigOptions，保留）
      cut(`      void assistant.acpSessionModes.loadModes(threadId).catch(() => undefined);`),
      // handleSessionModeChange 注释 + 函数
      cutOpt(
        `// ACP 会话模式切换（ADR-20260617 · D7-③-c 发送侧）：选择器回投透传给`,
        `// useAcpSessionModes.selectMode（乐观更新 + setSessionMode 回投，失败回滚并提示）。`,
      ),
      cut(
        `const handleSessionModeChange = async (modeId: string): Promise<void> => {`,
        `  try {`,
        `    await assistant.acpSessionModes.selectMode(modeId);`,
        `  } catch (error) {`,
        `    assistant.error.value = toErrorMessage(error, '切换会话模式失败。');`,
        `  }`,
        `};`,
        ``,
      ),
      // 模板绑定
      cut(
        `          :session-modes="assistant.acpSessionModes.state.value"`,
        `          :is-session-mode-switching="assistant.acpSessionModes.isSwitching.value"`,
      ),
      cut(`          @session-mode-change="handleSessionModeChange"`),
    ],
  },

  {
    file: 'src/composables/ai/useAiAssistant.ts',
    sentinel: 'useAcpSessionModes',
    edits: [
      cut(`import { useAcpSessionModes } from '@/composables/ai/useAcpSessionModes';`),
      cut(`  const acpSessionModes = useAcpSessionModes();`),
      cut(
        `        case 'mode_update':`,
        `          acpSessionModes.applyModeUpdate(event.modeId);`,
        `          break;`,
      ),
      cut(`    acpSessionModes.reset();`),
      cut(`    acpSessionModes,`),
    ],
  },

  {
    file: 'src/services/ipc/ai.service.ts',
    sentinel: 'IAiGetSessionModesRequest',
    edits: [
      // import 成员逐条删（本地被 config_options 成员按字母序插队，不能用连续多行锚点）
      cut(`  IAiGetSessionModesRequest,`),
      cut(`  IAiSessionModesPayload,`),
      cut(`  IAiSetSessionModeRequest,`),
      // 方法逐个删
      cut(
        `  getSessionModes(payload: IAiGetSessionModesRequest): Promise<IAiSessionModesPayload | null> {`,
        `    return tauriService.aiGetSessionModes(payload);`,
        `  },`,
      ),
      cut(
        `  setSessionMode(payload: IAiSetSessionModeRequest): Promise<boolean> {`,
        `    return tauriService.aiSetSessionMode(payload);`,
        `  },`,
      ),
    ],
  },

  {
    file: 'src/services/tauri.ai.ts',
    sentinel: 'ai_get_session_modes',
    edits: [
      // AI_COMMAND_META 两条逐条删
      cut(
        `  aiGetSessionModes: {`,
        `    command: 'ai_get_session_modes',`,
        `    guardHint: '读取 ACP 会话可用模式',`,
        `    idempotent: true,`,
        `    audit: 'info',`,
        `    timeoutMs: 15_000,`,
        `    measureInput: buildPayloadMetrics,`,
        `  },`,
      ),
      cut(
        `  aiSetSessionMode: {`,
        `    command: 'ai_set_session_mode',`,
        `    guardHint: '切换 ACP 会话模式',`,
        `    audit: 'sensitive',`,
        `    timeoutMs: 15_000,`,
        `    measureInput: buildPayloadMetrics,`,
        `  },`,
      ),
      // Pick 成员逐条删
      cut(`  | 'aiGetSessionModes'`),
      cut(`  | 'aiSetSessionMode'`),
      // 实现方法逐个删（各自吃掉尾随空行）
      cut(
        `  aiGetSessionModes(payload, options?: IIpcCallOptions) {`,
        `    return runCommand(AI_COMMAND_META.aiGetSessionModes, payload, options, () =>`,
        `      commands.aiGetSessionModes(payload),`,
        `    );`,
        `  },`,
        ``,
      ),
      cut(
        `  aiSetSessionMode(payload, options?: IIpcCallOptions) {`,
        `    return runCommand(AI_COMMAND_META.aiSetSessionMode, payload, options, () =>`,
        `      commands.aiSetSessionMode(payload),`,
        `    );`,
        `  },`,
        ``,
      ),
    ],
  },

  {
    file: 'src/types/ai/index.ts',
    sentinel: 'IAiGetSessionModesRequest',
    edits: [
      cutOpt(
        `/**`,
        ` * ACP 会话模式查询 / 切换请求与负载（ADR-20260617 · D7-③-c）。`,
        ` *`,
        ` * thread 维度；与生成绑定 AiGetSessionModesRequest / AiSetSessionModeRequest /`,
        ` * AiSessionModesPayload 结构一致（全 camelCase、全必填）。\`modes\` 为 ACP`,
        ` * \`SessionModeState\` 原始负载逐字透传（形状 unknown），由前端 ACL`,
        ` * （from-acp-session-modes）解析为选择器 VM。`,
        ` */`,
      ),
      cut(
        `export interface IAiGetSessionModesRequest {`,
        `  threadId: string;`,
        `}`,
        ``,
      ),
      cut(
        `export interface IAiSetSessionModeRequest {`,
        `  threadId: string;`,
        `  modeId: string;`,
        `}`,
        ``,
      ),
      cut(
        `export interface IAiSessionModesPayload {`,
        `  modes: unknown;`,
        `}`,
        ``,
      ),
    ],
  },

  {
    file: 'src/types/tauri/index.ts',
    sentinel: 'IAiGetSessionModesRequest',
    edits: [
      // import 成员逐条删（同样被 config_options 插队）
      cut(`  IAiGetSessionModesRequest,`),
      cut(`  IAiSessionModesPayload,`),
      cut(`  IAiSetSessionModeRequest,`),
      // ITauriService 声明逐条删
      cut(`  aiGetSessionModes(payload: IAiGetSessionModesRequest): Promise<IAiSessionModesPayload | null>;`),
      cut(`  aiSetSessionMode(payload: IAiSetSessionModeRequest): Promise<boolean>;`),
    ],
  },

  {
    file: 'src/types/ai/sidecar.ts',
    sentinel: 'IAcpSessionModeState',
    edits: [
      // TAgentUiEvent 联合成员
      cut(`  | TAgentUiEventModeUpdate`),
      // mode_update 事件注释 + 类型
      cutOpt(
        `/* ----------------------------------------------------------------------------`,
        ` * ACP 会话模式切换 UI 事件（ADR-20260617 · D7-③-b）`,
        ` *`,
        ` * 投影 ACP \`session/update\` 的 \`current_mode_update\`（外部 agent 自行切换当前会话模式，`,
        ` * 见 Rust host src-tauri/src/acp/ui_event.rs）：仅携带切换后的 \`modeId\`（ACP \`currentModeId\``,
        ` * 原值，逐字透传，不本地映射）。可用模式清单另由会话建立时的 \`NewSessionResponse.modes\``,
        ` * 提供（见后续 slice）；本事件只负责「当前模式已变更」信号，交前端模式选择器 VM 据`,
        ` * \`modeId\` 高亮当前项。`,
        ` * -------------------------------------------------------------------------- */`,
      ),
      cut(
        `export type TAgentUiEventModeUpdate = {`,
        `  type: 'mode_update';`,
        `  modeId: string;`,
        `};`,
        ``,
      ),
      // 选择器 VM 注释 + 两个接口
      cutOpt(
        `/* ----------------------------------------------------------------------------`,
        ` * ACP 会话模式选择器 VM（ADR-20260617 · D7-③-c）`,
        ` *`,
        ` * 由前端 ACL（components/business/ai/thread/projection/from-acp-session-modes）从`,
        ` * \`ai_get_session_modes\` 的原始 \`modes\`（ACP SessionModeState）解析而来；`,
        ` * \`mode_update\` UI 事件仅更新 \`currentModeId\`。VM 与 ACP wire 解耦：UI 只消费`,
        ` * 此结构，不直接触碰 ACP 原始负载。`,
        ` * -------------------------------------------------------------------------- */`,
      ),
      cut(
        `export interface IAcpSessionModeOption {`,
        `  id: string;`,
        `  name: string;`,
        `  description?: string;`,
        `}`,
        ``,
        `export interface IAcpSessionModeState {`,
        `  currentModeId: string | null;`,
        `  availableModes: IAcpSessionModeOption[];`,
        `}`,
        ``,
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

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

const plans = [];
const misses = [];

for (const spec of FILES) {
  const abs = path.join(ROOT, spec.file);
  if (!fs.existsSync(abs)) {
    console.log(`skip  (not found): ${spec.file}`);
    continue;
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const usedCRLF = raw.includes('\r\n');
  const body = raw.replace(/\r\n/g, '\n');
  if (spec.sentinel && !body.includes(spec.sentinel)) {
    console.log(`skip  (sentinel absent, already migrated): ${spec.file}`);
    continue;
  }
  const bodyLines = body.split('\n');
  let next = body;
  let fileMissed = false;
  for (const edit of spec.edits) {
    const count = countOccurrences(next, edit.find);
    if (count === 1) {
      next = next.replace(edit.find, edit.replace);
    } else if (edit.optional && count === 0) {
      // 可选锚点（注释）未命中：忽略
    } else {
      fileMissed = true;
      const probe = edit.find.replace(/\n$/, '').split('\n')[0].trim();
      misses.push({ file: spec.file, find: edit.find, count, probe, bodyLines });
    }
  }
  if (fileMissed) {
    console.log(`defer  (anchor miss): ${spec.file}`);
  } else {
    plans.push({ abs, file: spec.file, next, usedCRLF });
  }
}

if (misses.length > 0) {
  console.log('');
  console.log('==================== 未命中锚点报告（未写入任何文件） ====================');
  for (const m of misses) {
    console.log('');
    console.log(`● 文件: ${m.file}`);
    console.log(`期望 1 处匹配，实际 ${m.count} 处。探针片段: ${m.probe}`);
    console.log('--- 期望锚点 FIND ---');
    console.log(m.find.replace(/\n$/, ''));
    console.log('');
    console.log('--- 本地实际相关行（含该片段）---');
    const key = m.probe.replace(/[`'",]/g, '').trim().split(/\s+/)[0];
    m.bodyLines.forEach((line, i) => {
      if (key && line.includes(key)) {
        console.log(`${i + 1}| ${line}`);
      }
    });
  }
  process.exit(1);
}

let changed = 0;
for (const p of plans) {
  const out = p.usedCRLF ? p.next.replace(/\n/g, '\r\n') : p.next;
  fs.writeFileSync(p.abs, out, 'utf8');
  changed += 1;
  console.log(`patch: ${p.file}`);
}

let deleted = 0;
for (const rel of DELETES) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) {
    fs.rmSync(abs);
    deleted += 1;
    console.log(`delete: ${rel}`);
  } else {
    console.log(`delete skip (not found): ${rel}`);
  }
}

console.log(`patch/delete done: 改写 ${changed} 个文件，删除 ${deleted} 个文件`);
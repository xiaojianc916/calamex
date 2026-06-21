// apply-kimi-modes-fix.mjs
// 补齐 1.mjs 失败的 4 处编辑（sidecar.ts ×2 + AiPromptInput.vue ×2）。
// 改用「单行锚点 + 行尾自适应」：锚点本身不含换行，避免 CRLF/LF 差异导致 0 匹配；
// 插入内容按目标文件实际行尾（\r\n 或 \n）规整。幂等：每条带 marker，已应用即跳过。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DRY = process.argv.includes("--dry");
const ROOT = process.cwd();
const j = (...lines) => lines.join("\n");

const EDITS = [
  /* ---- src/types/ai/sidecar.ts ---- */
  {
    file: "src/types/ai/sidecar.ts",
    label: "sidecar.ts: 定义 TAgentUiEventCurrentModeUpdate",
    marker: "export type TAgentUiEventCurrentModeUpdate = {",
    old: "export type TAgentUiEvent =",
    new: j(
      "/* ----------------------------------------------------------------------------",
      " * ACP 会话当前模式变更 UI 事件（session/update 的 current_mode_update）",
      " *",
      " * 外部 agent（如 Kimi）在回合中自行切换模式时，经 session/update 下发",
      " * current_mode_update（仅携带新的 currentModeId）。前端据此回灌模式选择器高亮，",
      " * 不整份替换 availableModes（沿用 ai_get_session_modes 拉取的完整列表）。",
      " * -------------------------------------------------------------------------- */",
      "export type TAgentUiEventCurrentModeUpdate = {",
      "  type: 'current_mode_update';",
      "  currentModeId: string | null;",
      "};",
      "",
      "export type TAgentUiEvent =",
    ),
  },
  {
    file: "src/types/ai/sidecar.ts",
    label: "sidecar.ts: 并入 TAgentUiEvent union",
    marker: "  | TAgentUiEventCurrentModeUpdate",
    old: "  | TAgentUiEventConfigOptionUpdate",
    new: j(
      "  | TAgentUiEventConfigOptionUpdate",
      "  | TAgentUiEventCurrentModeUpdate",
    ),
  },

  /* ---- src/components/business/ai/chat/AiPromptInput.vue ---- */
  {
    file: "src/components/business/ai/chat/AiPromptInput.vue",
    label: "PromptInput: Kimi 模式可见时隐藏硬编码 chat/agent/plan 子菜单",
    marker: 'v-if="!sessionModesVisible"',
    old: '                  class="ai-settings-menu-item is-mode"',
    new: j(
      '                  v-if="!sessionModesVisible"',
      '                  class="ai-settings-menu-item is-mode"',
    ),
  },
  {
    file: "src/components/business/ai/chat/AiPromptInput.vue",
    label: "PromptInput: Kimi 内置模式选择器（插入到 config-options 段之前）",
    marker: 'aria-label="选择模式"',
    old: '            <template v-if="sessionConfigOptionsVisible">',
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
    ),
  },
];

let applied = 0, skipped = 0, failed = 0;

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
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const nw = e.new.split("\n").join(eol);
  console.log(`${DRY ? "DRY  EDIT  " : "EDIT  "}     ${e.file} :: ${e.label}`);
  if (!DRY) {
    content = content.replace(e.old, () => nw);
    writeFileSync(abs, content, "utf8");
  }
  applied++;
}

console.log(`\n${DRY ? "[DRY RUN] " : ""}applied=${applied} skipped=${skipped} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
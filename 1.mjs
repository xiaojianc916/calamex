#!/usr/bin/env node
// move-mode-into-settings.mjs
// 将 AiPromptInput.vue 的「模式选择」从输入框工具栏移动到齿轮设置弹窗(打开 AI 模式设置)中。
// 默认 dry-run，仅预览；加 --write 才真正写入。幂等：已迁移则跳过。
//
// 用法：
//   node move-mode-into-settings.mjs            # 预览（dry-run）
//   node move-mode-into-settings.mjs --write    # 实际写入
//   node move-mode-into-settings.mjs --root <项目根目录> --write

import { readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const rootArg = (() => {
  const i = args.findIndex((a) => a === '--root');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const inline = args.find((a) => a.startsWith('--root='));
  return inline ? inline.slice('--root='.length) : process.cwd();
})();
const fileArg = (() => {
  const inline = args.find((a) => a.startsWith('--file='));
  return inline
    ? inline.slice('--file='.length)
    : 'src/components/business/ai/chat/AiPromptInput.vue';
})();

const target = isAbsolute(fileArg) ? fileArg : join(rootArg, fileArg);
const block = (lines) => lines.join('\n');

const edits = [
  {
    name: 'import: + Check',
    find: block(['  ArrowUp,', '  Bot,', '  ChevronRight,']),
    replace: block(['  ArrowUp,', '  Bot,', '  Check,', '  ChevronRight,']),
  },
  {
    name: 'import: - Route (不再使用)',
    find: block(['  Plus,', '  Route,', '  Settings2,']),
    replace: block(['  Plus,', '  Settings2,']),
  },
  {
    name: '移除未再使用的 modeSelectLabel',
    find: block([
      'const modeSelectLabel = computed(() => {',
      '  const current = modeSelectItems.value.find((item) => item.key === modeSelectValue.value);',
      "  return current?.label ?? modeSelectItems.value[0]?.label ?? '模式';",
      '});',
      '',
      'const handleModeSelect = (value: unknown): void => {',
    ]),
    replace: block(['const handleModeSelect = (value: unknown): void => {']),
  },
  {
    name: '从工具栏移除模式 <Select>',
    find: block([
      '              </DropdownMenuContent>',
      '            </DropdownMenu>',
      '            <Select',
      '              :model-value="modeSelectValue"',
      '              :disabled="disabled"',
      '              @update:model-value="handleModeSelect"',
      '            >',
      '              <SelectTrigger aria-label="选择模式" class="ai-agent-trigger">',
      '                <Route class="ai-agent-trigger__icon" :stroke-width="1.6" />',
      '                <span class="ai-agent-trigger__label" v-text="modeSelectLabel"></span>',
      '              </SelectTrigger>',
      '              <SelectContent side="top" align="start" :side-offset="8" class="ai-agent-content">',
      '                <SelectLabel class="ai-agent-section-label">模式</SelectLabel>',
      '                <SelectGroup>',
      '                  <SelectItem',
      '                    v-for="mode in modeSelectItems"',
      '                    :key="mode.key"',
      '                    class="ai-agent-item"',
      '                    :value="mode.key"',
      '                  >',
      '                    <span class="ai-agent-item__label" v-text="mode.label"></span>',
      '                  </SelectItem>',
      '                </SelectGroup>',
      '              </SelectContent>',
      '            </Select>',
      '          </div>',
    ]),
    replace: block([
      '              </DropdownMenuContent>',
      '            </DropdownMenu>',
      '          </div>',
    ]),
  },
  {
    name: '设置弹窗加入「模式」分组',
    find: block([
      '                class="ai-settings-menu"',
      '              >',
      '                <DropdownMenuItem',
      '                  class="ai-settings-menu-item"',
      '                  :disabled="disabled || isNetworkPermissionSaving"',
      '                  @select.prevent="toggleNetworkPermission"',
    ]),
    replace: block([
      '                class="ai-settings-menu"',
      '              >',
      '                <div class="ai-settings-menu-section">模式</div>',
      '                <DropdownMenuItem',
      '                  v-for="mode in modeSelectItems"',
      '                  :key="mode.key"',
      '                  class="ai-settings-menu-item ai-settings-mode-item"',
      "                  :data-active=\"modeSelectValue === mode.key ? '' : undefined\"",
      '                  @select.prevent="handleModeSelect(mode.key)"',
      '                >',
      '                  <span class="ai-settings-menu-label" v-text="mode.label"></span>',
      '                  <Check v-if="modeSelectValue === mode.key" class="ai-settings-menu-check" />',
      '                </DropdownMenuItem>',
      '                <div class="ai-settings-menu-separator" aria-hidden="true"></div>',
      '                <DropdownMenuItem',
      '                  class="ai-settings-menu-item"',
      '                  :disabled="disabled || isNetworkPermissionSaving"',
      '                  @select.prevent="toggleNetworkPermission"',
    ]),
  },
  {
    name: '新增样式',
    find: block([
      '.ai-settings-menu-label {',
      '  min-width: 0;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '}',
      '',
      '.ai-network-switch {',
    ]),
    replace: block([
      '.ai-settings-menu-label {',
      '  min-width: 0;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '}',
      '',
      '.ai-settings-menu-section {',
      '  padding: 7px 8px 4px;',
      '  color: var(--ai-menu-muted);',
      '  font-size: 12px;',
      '  line-height: 1.2;',
      '}',
      '',
      '.ai-settings-mode-item {',
      '  grid-template-columns: minmax(0, 1fr) auto;',
      '  padding-left: 8px;',
      '}',
      '',
      '.ai-settings-mode-item[data-active] .ai-settings-menu-label {',
      '  font-weight: 600;',
      '}',
      '',
      '.ai-settings-menu-check {',
      '  width: 16px;',
      '  height: 16px;',
      '  color: #2783de;',
      '  stroke-width: 2;',
      '}',
      '',
      '.ai-settings-menu-separator {',
      '  height: 1px;',
      '  margin: 5px 4px;',
      '  background: var(--ai-menu-border);',
      '}',
      '',
      '.ai-network-switch {',
    ]),
  },
];

let src;
try {
  src = readFileSync(target, 'utf8');
} catch (e) {
  console.error(`✗ 无法读取文件：${target}`);
  console.error(`  ${e.message}`);
  process.exit(1);
}

if (src.includes('ai-settings-mode-item')) {
  console.log('• 已检测到 ai-settings-mode-item，似乎迁移过，跳过。');
  process.exit(0);
}

const problems = [];
for (const e of edits) {
  const n = src.split(e.find).length - 1;
  if (n !== 1) problems.push(`  - [${e.name}] 期望命中 1 次，实际 ${n} 次`);
}
if (problems.length) {
  console.error('✗ 锚点校验失败，未做任何修改：');
  console.error(problems.join('\n'));
  console.error('  （本地文件可能与基线不一致，请确认未被其它改动覆盖。）');
  process.exit(1);
}

let out = src;
for (const e of edits) {
  out = out.replace(e.find, e.replace);
  console.log(`✓ ${e.name}`);
}

if (!WRITE) {
  console.log('\n[dry-run] 校验通过，可安全应用。加 --write 实际写入：');
  console.log('  node move-mode-into-settings.mjs --write');
  process.exit(0);
}

writeFileSync(target, out, 'utf8');
console.log(`\n✓ 已写入：${target}`);
console.log('建议执行：pnpm lint && pnpm typecheck && pnpm test');
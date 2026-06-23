import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PROMPT = 'src/components/business/ai/chat/AiPromptInput.vue';
const PANEL = 'src/components/business/ai/shell/AiAssistantPanel.vue';
const SPEC = 'src/components/business/ai/skill/AiSlashCommandMenu.spec.ts';

function replaceOnce(src, oldStr, newStr, path) {
  const parts = src.split(oldStr);
  if (parts.length !== 2) {
    throw new Error(
      '[' + path + '] 期望命中 1 处，实际 ' + (parts.length - 1) +
        ' 处，已中止。\n--- 锚点首行 ---\n' + oldStr.split('\n')[0],
    );
  }
  return parts.join(newStr);
}

// ---------- 读取 + 哨兵（防重复执行） ----------
if (!existsSync(PROMPT)) throw new Error('找不到 ' + PROMPT + '（确认在仓库根目录运行）');
if (!existsSync(PANEL)) throw new Error('找不到 ' + PANEL + '（确认在仓库根目录运行）');

let prompt = readFileSync(PROMPT, 'utf8');
let panel = readFileSync(PANEL, 'utf8');

if (prompt.includes('useAcpSlashCommands')) {
  throw new Error('[' + PROMPT + '] 似乎已接线（含 useAcpSlashCommands），已中止，避免重复插入。');
}
if (panel.includes('kimiSlashCommands')) {
  throw new Error('[' + PANEL + '] 似乎已接线（含 kimiSlashCommands），已中止，避免重复插入。');
}

// ---------- AiPromptInput.vue：6 处手术编辑 ----------

// A1 导入 IAcpAvailableCommand（按字母序置于 skill 之前）
prompt = replaceOnce(
  prompt,
  "import type { ISelectedSkill, ISkillSummary } from '@/types/ai/skill';",
  "import type { IAcpAvailableCommand } from '@/types/ai/sidecar';\n" +
    "import type { ISelectedSkill, ISkillSummary } from '@/types/ai/skill';",
  PROMPT,
);

// A2 新增 prop acpCommands
prompt = replaceOnce(
  prompt,
  '  userQuestions?: readonly IAskUserComposerQuestion[] | null;\n}>();',
  '  userQuestions?: readonly IAskUserComposerQuestion[] | null;\n' +
    '  /** Kimi(ACP) 会话公示的可用命令；仅 kimi Agent 时透传给斜杠菜单作为命令列表。 */\n' +
    '  acpCommands?: readonly IAcpAvailableCommand[];\n}>();',
  PROMPT,
);

// A3 新增 ACP 斜杠命令派生量
prompt = replaceOnce(
  prompt,
  'let skillsLoadPromise: Promise<void> | null = null;',
  'let skillsLoadPromise: Promise<void> | null = null;\n\n' +
    '// kimi(ACP) 模式下斜杠菜单改用会话公示命令；builtin 仍用自研技能列表。\n' +
    "const useAcpSlashCommands = computed(() => selectedAgent.value === 'kimi');\n" +
    'const acpSlashCommands = computed<readonly IAcpAvailableCommand[]>(() => props.acpCommands ?? []);',
  PROMPT,
);

// A4 仅 builtin 模式才懒加载技能（kimi 模式不拉技能列表）
prompt = replaceOnce(
  prompt,
  '    if (!slashOpen.value) {\n      void ensureSkillsLoaded();\n    }',
  '    if (!slashOpen.value && !useAcpSlashCommands.value) {\n      void ensureSkillsLoaded();\n    }',
  PROMPT,
);

// A5 新增 命令插入逻辑（纯文本，非技能胶囊）
prompt = replaceOnce(
  prompt,
  'const handleSelectSkill = (slug: string): void => {\n' +
    '  const summary = skills.value.find((item) => item.slug === slug);\n' +
    '  const name = summary?.name?.trim() || slug;\n' +
    '  insertSkillPill({ slug, name });\n' +
    '};',
  'const handleSelectSkill = (slug: string): void => {\n' +
    '  const summary = skills.value.find((item) => item.slug === slug);\n' +
    '  const name = summary?.name?.trim() || slug;\n' +
    '  insertSkillPill({ slug, name });\n' +
    '};\n\n' +
    '// 选择 Kimi(ACP) 命令：把光标处的 "/查询" 片段整体替换为 "/命令 "（纯文本，不是技能胶囊）。\n' +
    'const insertSlashCommandText = (name: string): void => {\n' +
    '  const root = editorRef.value;\n' +
    '  if (!root) {\n' +
    '    return;\n' +
    '  }\n' +
    "  const normalized = name.startsWith('/') ? name.slice(1) : name;\n" +
    '  root.focus();\n' +
    '  const range = getEditorSelectionRange();\n' +
    '  if (range && range.startContainer.nodeType === Node.TEXT_NODE) {\n' +
    '    const node = range.startContainer as Text;\n' +
    "    const value = node.nodeValue ?? '';\n" +
    '    const before = value.slice(0, range.startOffset);\n' +
    '    const after = value.slice(range.startOffset);\n' +
    "    const slashAt = before.lastIndexOf('/');\n" +
    '    if (slashAt >= 0) {\n' +
    "      const inserted = '/' + normalized + ' ';\n" +
    '      node.nodeValue = before.slice(0, slashAt) + inserted + after;\n' +
    '      const caret = slashAt + inserted.length;\n' +
    '      range.setStart(node, caret);\n' +
    '      range.collapse(true);\n' +
    '      const selection = window.getSelection();\n' +
    '      if (selection) {\n' +
    '        selection.removeAllRanges();\n' +
    '        selection.addRange(range);\n' +
    '      }\n' +
    '    }\n' +
    '  }\n' +
    '  closeSlashMenu();\n' +
    '  syncFromEditor();\n' +
    '};\n\n' +
    'const handleSelectCommand = (name: string): void => {\n' +
    '  insertSlashCommandText(name);\n' +
    '};',
  PROMPT,
);

// A6 模板：给 <AiSlashCommandMenu> 接上 acp / commands / select-command
prompt = replaceOnce(
  prompt,
  '    <AiSlashCommandMenu\n' +
    '      :open="slashOpen"\n' +
    '      :query="slashQuery"\n' +
    '      :skills="skills"\n' +
    '      :anchor-rect="slashAnchorRect"\n' +
    '      @select-skill="handleSelectSkill"\n' +
    '      @close="closeSlashMenu"\n' +
    '    />',
  '    <AiSlashCommandMenu\n' +
    '      :open="slashOpen"\n' +
    '      :query="slashQuery"\n' +
    '      :skills="skills"\n' +
    '      :anchor-rect="slashAnchorRect"\n' +
    '      :acp="useAcpSlashCommands"\n' +
    '      :commands="acpSlashCommands"\n' +
    '      @select-skill="handleSelectSkill"\n' +
    '      @select-command="handleSelectCommand"\n' +
    '      @close="closeSlashMenu"\n' +
    '    />',
  PROMPT,
);

// ---------- AiAssistantPanel.vue：2 处手术编辑 ----------

// B1 kimi 会话向输入框透传 ACP 公示命令
panel = replaceOnce(
  panel,
  "const sessionAgentBackend = ref<TSessionAgentBackend>('kimi');",
  "const sessionAgentBackend = ref<TSessionAgentBackend>('kimi');\n\n" +
    '// kimi 会话向输入框透传 ACP 公示命令，供斜杠菜单作为内置命令列表；其它 Agent 不透传（用自研技能）。\n' +
    'const kimiSlashCommands = computed(() =>\n' +
    "  sessionAgentBackend.value === 'kimi' ? assistant.acpAvailableCommands.commands.value : undefined,\n" +
    ');',
  PANEL,
);

// B2 模板：把命令传给 <AiPromptInput>
panel = replaceOnce(
  panel,
  '          v-model:agent-backend="sessionAgentBackend"\n' +
    '          :disabled="composerDisabled" :stop-visible="assistant.isSending.value"',
  '          v-model:agent-backend="sessionAgentBackend"\n' +
    '          :acp-commands="kimiSlashCommands"\n' +
    '          :disabled="composerDisabled" :stop-visible="assistant.isSending.value"',
  PANEL,
);

// ---------- 新增测试 ----------
const specContent = [
  "import { mount } from '@vue/test-utils';",
  "import { describe, expect, it } from 'vitest';",
  "import AiSlashCommandMenu from '@/components/business/ai/skill/AiSlashCommandMenu.vue';",
  "import type { IAcpAvailableCommand } from '@/types/ai/sidecar';",
  "import type { ISkillSummary } from '@/types/ai/skill';",
  '',
  'const anchorRect = { left: 0, top: 200, width: 320 };',
  '',
  'const buildSkill = (slug: string, name: string): ISkillSummary => ({',
  '  slug,',
  '  name,',
  "  description: name + ' 描述',",
  '  updatedAtMs: 0,',
  '});',
  '',
  'const buildCommand = (name: string, description: string): IAcpAvailableCommand => ({',
  '  name,',
  '  description,',
  '});',
  '',
  'const mountMenu = (props: Record<string, unknown>) =>',
  '  mount(AiSlashCommandMenu, {',
  "    props: { open: true, query: '', skills: [], anchorRect, ...props },",
  '    global: { stubs: { teleport: true } },',
  '  });',
  '',
  "describe('AiSlashCommandMenu', () => {",
  "  it('acp 模式渲染会话命令且不显示「即将推出」徽标', () => {",
  '    const wrapper = mountMenu({',
  '      acp: true,',
  "      commands: [buildCommand('compact', '压缩上下文'), buildCommand('status', '查看状态')],",
  '    });',
  '',
  "    expect(wrapper.findAll('.slash-item')).toHaveLength(2);",
  "    expect(wrapper.text()).toContain('compact');",
  "    expect(wrapper.text()).not.toContain('即将推出');",
  '  });',
  '',
  "  it('acp 模式点击命令派发 select-command', async () => {",
  '    const wrapper = mountMenu({',
  '      acp: true,',
  "      commands: [buildCommand('compact', '压缩上下文')],",
  '    });',
  '',
  "    await wrapper.get('.slash-item').trigger('click');",
  '',
  "    expect(wrapper.emitted('select-command')?.[0]).toEqual(['compact']);",
  '  });',
  '',
  "  it('acp 模式按查询过滤命令', () => {",
  '    const wrapper = mountMenu({',
  "      query: 'stat',",
  '      acp: true,',
  "      commands: [buildCommand('compact', '压缩上下文'), buildCommand('status', '查看状态')],",
  '    });',
  '',
  "    expect(wrapper.findAll('.slash-item')).toHaveLength(1);",
  "    expect(wrapper.text()).toContain('status');",
  "    expect(wrapper.text()).not.toContain('compact');",
  '  });',
  '',
  "  it('acp 模式无可用命令时显示空态提示', () => {",
  '    const wrapper = mountMenu({ acp: true, commands: [] });',
  '',
  "    expect(wrapper.find('.slash-empty').text()).toContain('会话开始后将出现可用命令');",
  '  });',
  '',
  "  it('builtin 模式点击技能派发 select-skill', async () => {",
  '    const wrapper = mountMenu({',
  "      skills: [buildSkill('demo', '演示技能')],",
  '      acp: false,',
  '    });',
  '',
  '    const enabledItems = wrapper',
  "      .findAll('.slash-item')",
  "      .filter((item) => item.attributes('disabled') === undefined);",
  "    await enabledItems[enabledItems.length - 1].trigger('click');",
  '',
  "    expect(wrapper.emitted('select-skill')?.[0]).toEqual(['demo']);",
  '  });',
  '});',
  '',
].join('\n');

// ---------- 两阶段原子写 ----------
const writes = [
  { path: PROMPT, content: prompt },
  { path: PANEL, content: panel },
  { path: SPEC, content: specContent },
];

for (const w of writes) {
  writeFileSync(w.path, w.content, 'utf8');
  console.log('written: ' + w.path);
}
console.log('done. 共写入 ' + writes.length + ' 个文件。');
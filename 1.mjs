// 1.mjs
// 作用：
// 1. 输入框底部移除 Agent 选择器
// 2. AI 面板左上角用 Agent 选择器替代原来的模型显示
// 3. 默认 Agent 为 Kimi Code
// 4. 输入框右侧模型选择继续保留
// 5. 尽量兼容已经被前面脚本部分修改过的状态，可重复执行

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = process.cwd();

const files = {
  promptInput: 'src/components/business/ai/chat/AiPromptInput.vue',
  assistantPanel: 'src/components/business/ai/shell/AiAssistantPanel.vue',
  promptInputSpec: 'src/components/business/ai/chat/AiPromptInput.spec.ts',
  assistantPanelSpec: 'src/components/business/ai/shell/AiAssistantPanel.spec.ts',
};

const read = (relativePath) => readFileSync(resolve(repoRoot, relativePath), 'utf8');

const write = (relativePath, content) => {
  writeFileSync(resolve(repoRoot, relativePath), content, 'utf8');
};

const replaceOptional = (content, pattern, replacement) => {
  pattern.lastIndex = 0;
  return content.replace(pattern, replacement);
};

const replaceRequired = (content, pattern, replacement, label) => {
  pattern.lastIndex = 0;
  if (!pattern.test(content)) {
    throw new Error(`未找到必要结构：${label}`);
  }

  pattern.lastIndex = 0;
  return content.replace(pattern, replacement);
};

const changedFiles = new Set();

const writeIfChanged = (path, before, after) => {
  if (before !== after) {
    write(path, after);
    changedFiles.add(path);
  }
};

const removePromptAgentSelectBlock = (content) => {
  const marker = '<template v-if="sessionConfigOptionsVisible">';
  const markerIndex = content.indexOf(marker);

  if (markerIndex === -1) {
    return content;
  }

  const beforeMarker = content.slice(0, markerIndex);
  const modelValueIndex = beforeMarker.lastIndexOf(':model-value="selectedAgent"');

  // 已经没有输入框底部 Agent Select 了，跳过。
  if (modelValueIndex === -1) {
    return content;
  }

  const selectStart = beforeMarker.lastIndexOf('<Select', modelValueIndex);

  if (selectStart === -1) {
    return content;
  }

  return `${content.slice(0, selectStart)}${content.slice(markerIndex)}`;
};

const replacePanelMarkTemplate = (content) => {
  if (content.includes('class="ai-agent-mark"')) {
    return content;
  }

  const start = content.indexOf('    <template #mark>');
  const end = content.indexOf('\n\n    <template #actions>', start);

  if (start === -1 || end === -1) {
    throw new Error('未找到必要结构：AiAssistantPanel.vue mark template');
  }

  const nextMark = `    <template #mark>
      <Select :model-value="sessionAgentBackend" @update:model-value="handleAgentBackendChange">
        <SelectTrigger aria-label="选择 Agent" class="ai-agent-mark">
          <AiProviderIcon
            v-if="sessionAgentBackend === 'kimi'"
            class="ai-agent-mark__icon"
            platform-id="moonshotai"
            decorative
          />
          <Bot v-else class="ai-agent-mark__icon" :stroke-width="1.6" />
          <span class="ai-agent-mark__copy">
            <span class="ai-agent-mark__label" v-text="selectedAgentOption.label"></span>
          </span>
        </SelectTrigger>
        <SelectContent side="bottom" align="start" :side-offset="8" class="ai-agent-mark-content">
          <SelectLabel class="ai-agent-mark-section-label">选择 Agent</SelectLabel>
          <SelectGroup>
            <SelectItem
              v-for="agent in agentOptions"
              :key="agent.key"
              class="ai-agent-mark-item"
              :value="agent.key"
            >
              <AiProviderIcon
                v-if="agent.key === 'kimi'"
                class="ai-agent-mark-item__icon"
                platform-id="moonshotai"
                decorative
              />
              <Bot v-else class="ai-agent-mark-item__icon" :stroke-width="1.6" />
              <span class="ai-agent-mark-item__label" v-text="agent.label"></span>
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </template>`;

  return `${content.slice(0, start)}${nextMark}${content.slice(end)}`;
};

const replacePanelMarkCss = (content) => {
  const markCss = `.ai-agent-mark {
  display: inline-flex;
  min-width: 0;
  height: 30px;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  padding: 0 8px;
  box-shadow: none;
}

.ai-agent-mark:hover,
.ai-agent-mark[data-state='open'] {
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
}

.ai-agent-mark > :deep(svg:last-child) {
  display: none;
}

.ai-agent-mark__icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
}

.ai-agent-mark__copy {
  min-width: 0;
  display: inline-flex;
  align-items: center;
}

.ai-agent-mark__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
}

.ai-agent-mark-content {
  width: min(240px, calc(100vw - 24px));
  padding: 8px;
  border: 1px solid #d1d9e0b3;
  border-radius: 10px;
  background: #ffffff;
  color: #1f2328;
  box-shadow: 0 12px 30px rgb(31 35 40 / 12%);
}

.ai-agent-mark-content [data-slot='select-scroll-up-button'],
.ai-agent-mark-content [data-slot='select-scroll-down-button'] {
  display: none;
}

.ai-agent-mark-section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #818b98;
  font-size: 12px;
  padding: 6px 3px 7px;
}

.ai-agent-mark-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  border-radius: 7px;
  color: #1f2328;
  font-size: 14px;
  padding: 0 28px 0 7px;
}

.ai-agent-mark-item[data-highlighted],
.ai-agent-mark-item[data-state='checked'] {
  background: #818b981f;
}

.ai-agent-mark-item__icon {
  width: 17px;
  height: 17px;
  flex: 0 0 auto;
}

.ai-agent-mark-item__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;

  const oldCssStart = content.indexOf('.ai-provider-mark {');
  const iconButtonStart = content.indexOf('\n.ai-icon-button {', oldCssStart);

  if (oldCssStart !== -1 && iconButtonStart !== -1) {
    return `${content.slice(0, oldCssStart)}${markCss}${content.slice(iconButtonStart + 1)}`;
  }

  if (!content.includes('.ai-agent-mark {')) {
    const fallbackIndex = content.indexOf('.ai-icon-button {');
    if (fallbackIndex === -1) {
      throw new Error('未找到必要结构：AiAssistantPanel.vue ai-icon-button CSS');
    }

    return `${content.slice(0, fallbackIndex)}${markCss}${content.slice(fallbackIndex)}`;
  }

  return content;
};

// -----------------------------------------------------------------------------
// AiPromptInput.vue：移除输入框底部 Agent Select
// -----------------------------------------------------------------------------
{
  const path = files.promptInput;
  let content = read(path);
  const original = content;

  // 默认值保持 kimi，给 sessionConfigOptionsVisible 使用。
  content = replaceOptional(
    content,
    /(const selectedAgent = defineModel<TAiPromptAgentKind>\('agentBackend',\s*\{\s*default:\s*)'(?:builtin|kimi)'(\s*,\s*\}\);)/s,
    "$1'kimi'$2",
  );

  // 文案统一。
  content = replaceOptional(
    content,
    /(\{\s*key:\s*'kimi',\s*label:\s*)'[^']*'(\s*\},)/,
    "$1'Kimi Code'$2",
  );

  // 删除输入框底部 Agent Select 块。
  content = removePromptAgentSelectBlock(content);

  // 删除输入框 Agent 专用数据和 handler，避免 no-unused。
  content = replaceOptional(
    content,
    /\ninterface IAiPromptAgentOption \{\s*key: TAiPromptAgentKind;\s*label: string;\s*\}\n/s,
    '\n',
  );

  content = replaceOptional(
    content,
    /\nconst agentOptions: IAiPromptAgentOption\[] = \[\s*\{ key: 'builtin', label: 'Calamex Agent' \},\s*\{ key: 'kimi', label: 'Kimi(?: Code)?' \},\s*\];\n/s,
    '\n',
  );

  content = replaceOptional(
    content,
    /\nconst selectedAgentOption = computed\(\s*\(\) => agentOptions\.find\(\(option\) => option\.key === selectedAgent\.value\) \?\? agentOptions\[0\],\s*\);\n/s,
    '\n',
  );

  content = replaceOptional(
    content,
    /\n  agentChange: \[agent: TAiPromptAgentKind\];/,
    '',
  );

  content = replaceOptional(
    content,
    /\nconst isAgentKind = \(value: unknown\): value is TAiPromptAgentKind =>\s*value === 'builtin' \|\| value === 'kimi';\s*\n\s*\/\/ 切换会话使用的 Agent 后端。[\s\S]*?const toggleNetworkPermission = \(\): void => \{/,
    '\nconst toggleNetworkPermission = (): void => {',
  );

  writeIfChanged(path, original, content);
}

// -----------------------------------------------------------------------------
// AiAssistantPanel.vue：左上角模型显示替换为 Agent Select
// -----------------------------------------------------------------------------
{
  const path = files.assistantPanel;
  let content = read(path);
  const original = content;

  // lucide 加 Bot。
  content = replaceOptional(
    content,
    /import \{ SquarePen, Trash2 \} from '@lucide\/vue';/,
    "import { Bot, SquarePen, Trash2 } from '@lucide/vue';",
  );

  // 引入 Select。
  if (!content.includes("from '@/components/ui/select';")) {
    content = content.replace(
      "import AiPanelFrame from '@/components/business/ai/shell/AiPanelFrame.vue';",
      `import AiPanelFrame from '@/components/business/ai/shell/AiPanelFrame.vue';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/select';`,
    );
  }

  // 默认 Agent 改为 kimi。
  content = replaceOptional(
    content,
    /const sessionAgentBackend = ref<TSessionAgentBackend>\('(?:builtin|kimi)'\);/,
    "const sessionAgentBackend = ref<TSessionAgentBackend>('kimi');",
  );

  // 添加 Agent options。
  if (!content.includes('interface ISessionAgentOption')) {
    content = replaceRequired(
      content,
      /type TSessionAgentBackend = 'builtin' \| 'kimi';\s*const sessionAgentBackend = ref<TSessionAgentBackend>\('kimi'\);/,
      `type TSessionAgentBackend = 'builtin' | 'kimi';

interface ISessionAgentOption {
  key: TSessionAgentBackend;
  label: string;
}

const agentOptions: ISessionAgentOption[] = [
  { key: 'builtin', label: 'Calamex Agent' },
  { key: 'kimi', label: 'Kimi Code' },
];

const sessionAgentBackend = ref<TSessionAgentBackend>('kimi');`,
      `${path} session agent options`,
    );
  } else {
    content = replaceOptional(
      content,
      /\{ key: 'kimi', label: 'Kimi(?: Code)?' \}/,
      "{ key: 'kimi', label: 'Kimi Code' }",
    );
  }

  // 左上角不再显示模型名，所以删掉 aiModelName / providerMarkTitle，避免 no-unused。
  content = replaceOptional(
    content,
    /\nconst aiModelName = computed\(\(\) => \{[\s\S]*?\n\}\);\nconst providerMarkTitle = computed\(\(\) => \{[\s\S]*?\n\}\);\n/s,
    '\n',
  );

  // 添加当前 Agent label 计算和类型保护。
  if (!content.includes('const selectedAgentOption = computed(')) {
    content = content.replace(
      '\nconst {\n  isHistoryOpen,',
      `
const selectedAgentOption = computed(
  () => agentOptions.find((option) => option.key === sessionAgentBackend.value) ?? agentOptions[0],
);

const isSessionAgentBackend = (value: unknown): value is TSessionAgentBackend =>
  value === 'builtin' || value === 'kimi';

const {
  isHistoryOpen,`,
    );
  }

  // 左上角 Select 直接触发时，需要自己写 sessionAgentBackend。
  content = replaceRequired(
    content,
    /const handleAgentBackendChange = \(agent: TSessionAgentBackend\): void => \{\s*assistant\.error\.value = '';\s*if \(agent === 'kimi'\) \{\s*const threadId = assistant\.activeConversationId\.value;\s*if \(threadId\) \{\s*void assistant\.acpSessionConfigOptions\.loadConfigOptions\(threadId\)\.catch\(\(\) => undefined\);\s*\}\s*\}\s*\};/s,
    `const handleAgentBackendChange = (agent: unknown): void => {
  if (!isSessionAgentBackend(agent)) {
    return;
  }

  sessionAgentBackend.value = agent;
  assistant.error.value = '';

  if (agent === 'kimi') {
    const threadId = assistant.activeConversationId.value;

    if (threadId) {
      void assistant.acpSessionConfigOptions.loadConfigOptions(threadId).catch(() => undefined);
    }
  }
};`,
    `${path} handleAgentBackendChange`,
  );

  // 替换左上角 mark 模板。
  content = replacePanelMarkTemplate(content);

  // 输入框里已经没有 Agent Select，不再监听 agent-change。
  content = replaceOptional(
    content,
    /\n\s*@agent-change="handleAgentBackendChange"/,
    '',
  );

  // 替换左上角样式。
  content = replacePanelMarkCss(content);

  writeIfChanged(path, original, content);
}

// -----------------------------------------------------------------------------
// AiPromptInput.spec.ts：默认 Kimi 后，builtin 场景显式传
// -----------------------------------------------------------------------------
{
  const path = files.promptInputSpec;
  let content = read(path);
  const original = content;

  content = replaceOptional(
    content,
    /const builtinWrapper = mountPromptInput\(\{\s*sessionConfigOptions\s*\}\);/,
    "const builtinWrapper = mountPromptInput({ agentBackend: 'builtin', sessionConfigOptions });",
  );

  content = replaceOptional(
    content,
    /const kimiWrapper = mountPromptInput\(\{\s*agentBackend:\s*'kimi',\s*sessionConfigOptions\s*\}\);/,
    'const kimiWrapper = mountPromptInput({ sessionConfigOptions });',
  );

  writeIfChanged(path, original, content);
}

// -----------------------------------------------------------------------------
// AiAssistantPanel.spec.ts：给左上角 Select 加 stub，避免测试里渲染真实下拉组件
// -----------------------------------------------------------------------------
{
  const path = files.assistantPanelSpec;
  let content = read(path);
  const original = content;

  content = replaceOptional(
    content,
    /AiPromptInput: defineComponent\(\{\s*emits: \['submit', 'update:activeMode', 'sessionConfigOptionChange'\],/,
    "AiPromptInput: defineComponent({\n          emits: ['submit', 'update:activeMode', 'update:agentBackend', 'sessionConfigOptionChange'],",
  );

  if (!content.includes('data-testid="agent-mark-select"')) {
    content = content.replace(
      `        AiProviderIcon: defineComponent({
          template: '<span class="ai-provider-icon" />',
        }),`,
      `        AiProviderIcon: defineComponent({
          template: '<span class="ai-provider-icon" />',
        }),
        Select: defineComponent({
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template: '<div data-testid="agent-mark-select"><slot /></div>',
        }),
        SelectTrigger: defineComponent({
          template: '<button type="button"><slot /></button>',
        }),
        SelectContent: defineComponent({
          template: '<div><slot /></div>',
        }),
        SelectGroup: defineComponent({
          template: '<div><slot /></div>',
        }),
        SelectItem: defineComponent({
          props: ['value'],
          template: '<div><slot /></div>',
        }),
        SelectLabel: defineComponent({
          template: '<div><slot /></div>',
        }),`,
    );
  }

  writeIfChanged(path, original, content);
}

if (changedFiles.size === 0) {
  console.log('没有需要修改的内容：目标改动可能已经应用过。');
} else {
  console.log('已完成修改：');
  for (const file of changedFiles) {
    console.log(`- ${file}`);
  }
}

console.log('\n建议继续执行：');
console.log('pnpm test -- src/components/business/ai/chat/AiPromptInput.spec.ts src/components/business/ai/shell/AiAssistantPanel.spec.ts');
console.log('pnpm typecheck');
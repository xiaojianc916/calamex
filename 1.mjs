import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const files = {
  panel: 'src/components/business/ai/shell/AiAssistantPanel.vue',
  promptSpec: 'src/components/business/ai/chat/AiPromptInput.spec.ts',
  panelSpec: 'src/components/business/ai/shell/AiAssistantPanel.spec.ts',
};

const read = (file) => readFileSync(resolve(root, file), 'utf8');
const write = (file, text) => writeFileSync(resolve(root, file), text, 'utf8');

const changed = new Set();

const save = (file, before, after) => {
  if (before !== after) {
    write(file, after);
    changed.add(file);
  }
};

const replaceMust = (text, pattern, replacement, label) => {
  const next = text.replace(pattern, replacement);
  if (next === text) {
    throw new Error(`未找到必要结构：${label}`);
  }
  return next;
};

const agentMarkTemplate = `    <template #mark>
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

const agentMarkCss = `.ai-agent-mark {
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
}`;

// -----------------------------------------------------------------------------
// AiAssistantPanel.vue
// -----------------------------------------------------------------------------
{
  const file = files.panel;
  let s = read(file);
  const before = s;

  // import Bot
  s = s.replace(
    /import \{ SquarePen, Trash2 \} from '@lucide\/vue';/,
    "import { Bot, SquarePen, Trash2 } from '@lucide/vue';",
  );

  // import Select
  if (!s.includes("from '@/components/ui/select';")) {
    s = replaceMust(
      s,
      /import AiPanelFrame from '@\/components\/business\/ai\/shell\/AiPanelFrame\.vue';/,
      `import AiPanelFrame from '@/components/business/ai/shell/AiPanelFrame.vue';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/select';`,
      'Select import anchor',
    );
  }

  // session agent options
  if (!s.includes('interface ISessionAgentOption')) {
    s = replaceMust(
      s,
      /type TSessionAgentBackend = 'builtin' \| 'kimi';\s*const sessionAgentBackend = ref<TSessionAgentBackend>\('(?:builtin|kimi)'\);/,
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
      'session agent backend block',
    );
  }

  // ensure default kimi
  s = s.replace(
    /const sessionAgentBackend = ref<TSessionAgentBackend>\('(?:builtin|kimi)'\);/,
    "const sessionAgentBackend = ref<TSessionAgentBackend>('kimi');",
  );

  // remove unused old mark computed
  s = s.replace(
    /\nconst aiModelName = computed\(\(\) => \{[\s\S]*?\n\}\);\nconst providerMarkTitle = computed\(\(\) => \{[\s\S]*?\n\}\);\n/s,
    '\n',
  );

  // selectedAgentOption + guard
  if (!s.includes('const selectedAgentOption = computed(')) {
    s = replaceMust(
      s,
      /(const activeAgentModelId = computed<string>\(\(\) => \{[\s\S]*?\n\}\);\n)/,
      `$1
const selectedAgentOption = computed(
  () => agentOptions.find((option) => option.key === sessionAgentBackend.value) ?? agentOptions[0],
);

const isSessionAgentBackend = (value: unknown): value is TSessionAgentBackend =>
  value === 'builtin' || value === 'kimi';
`,
      'activeAgentModelId block',
    );
  }

  // replace handleAgentBackendChange
  s = replaceMust(
    s,
    /const handleAgentBackendChange = \([\s\S]*?\n\};\n\n\/\/ ACP 会话配置项切换/,
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
};

// ACP 会话配置项切换`,
    'handleAgentBackendChange',
  );

  // robust replace mark template
  if (!s.includes('class="ai-agent-mark"')) {
    const markToActionsPattern =
      /\n\s*<template #mark>[\s\S]*?\n\s*<\/template>\s*\n\s*<template #actions>/;

    if (markToActionsPattern.test(s)) {
      s = s.replace(markToActionsPattern, `\n${agentMarkTemplate}\n\n    <template #actions>`);
    } else {
      // fallback: insert before actions
      s = replaceMust(
        s,
        /\n\s*<template #actions>/,
        `\n${agentMarkTemplate}\n\n    <template #actions>`,
        'mark/actions template',
      );
    }
  }

  // remove stale input event
  s = s.replace(/\n\s*@agent-change="handleAgentBackendChange"/, '');

  // replace old css
  if (!s.includes('.ai-agent-mark {')) {
    const oldProviderCss =
      /\.ai-provider-mark \{[\s\S]*?\.ai-provider-mark__label \{[\s\S]*?\n\}/;

    if (oldProviderCss.test(s)) {
      s = s.replace(oldProviderCss, agentMarkCss);
    } else {
      s = replaceMust(s, /\.ai-icon-button \{/, `${agentMarkCss}\n\n.ai-icon-button {`, 'css anchor');
    }
  }

  save(file, before, s);
}

// -----------------------------------------------------------------------------
// AiPromptInput.spec.ts
// -----------------------------------------------------------------------------
{
  const file = files.promptSpec;
  let s = read(file);
  const before = s;

  s = s.replace(
    `    const builtinWrapper = mountPromptInput({ agentBackend: 'builtin', sessionConfigOptions });
    expect(builtinWrapper.findAll('.ai-agent-trigger')).toHaveLength(1);

    const kimiWrapper = mountPromptInput({ sessionConfigOptions });
    expect(kimiWrapper.findAll('.ai-agent-trigger')).toHaveLength(3);`,
    `    const builtinWrapper = mountPromptInput({ agentBackend: 'builtin', sessionConfigOptions });
    expect(builtinWrapper.findAll('.ai-agent-trigger')).toHaveLength(0);

    const kimiWrapper = mountPromptInput({ sessionConfigOptions });
    expect(kimiWrapper.findAll('.ai-agent-trigger')).toHaveLength(2);`,
  );

  save(file, before, s);
}

// -----------------------------------------------------------------------------
// AiAssistantPanel.spec.ts
// -----------------------------------------------------------------------------
{
  const file = files.panelSpec;
  let s = read(file);
  const before = s;

  s = s.replace(
    /AiPromptInput: defineComponent\(\{\s*emits: \['submit', 'update:activeMode', 'sessionConfigOptionChange'\],/,
    "AiPromptInput: defineComponent({\n          emits: ['submit', 'update:activeMode', 'update:agentBackend', 'sessionConfigOptionChange'],",
  );

  if (!s.includes('data-testid="agent-mark-select"')) {
    s = replaceMust(
      s,
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
      'select stubs anchor',
    );
  }

  save(file, before, s);
}

if (changed.size === 0) {
  console.log('没有修改：目标改动可能已经应用过。');
} else {
  console.log('已修改：');
  for (const file of changed) console.log(`- ${file}`);
}

console.log('\n下一步执行：');
console.log('pnpm test -- src/components/business/ai/chat/AiPromptInput.spec.ts src/components/business/ai/shell/AiAssistantPanel.spec.ts');
console.log('pnpm typecheck');
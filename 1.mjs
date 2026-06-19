import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const files = {
  prompt: 'src/components/business/ai/chat/AiPromptInput.vue',
  panel: 'src/components/business/ai/shell/AiAssistantPanel.vue',
  promptSpec: 'src/components/business/ai/chat/AiPromptInput.spec.ts',
  panelSpec: 'src/components/business/ai/shell/AiAssistantPanel.spec.ts',
};

const read = (file) => readFileSync(resolve(root, file), 'utf8');
const write = (file, content) => writeFileSync(resolve(root, file), content, 'utf8');

const replaceMust = (content, oldText, newText, label) => {
  if (!content.includes(oldText)) {
    throw new Error(`未找到：${label}`);
  }
  return content.replace(oldText, newText);
};

const replaceRegex = (content, pattern, replacement) => content.replace(pattern, replacement);

const changed = new Set();

const save = (file, before, after) => {
  if (before !== after) {
    write(file, after);
    changed.add(file);
  }
};

// -----------------------------------------------------------------------------
// 1. AiPromptInput.vue：输入框底部删除 Agent 选择，只保留模型选择
// -----------------------------------------------------------------------------
{
  const file = files.prompt;
  let s = read(file);
  const before = s;

  s = replaceRegex(
    s,
    /(const selectedAgent = defineModel<TAiPromptAgentKind>\('agentBackend',\s*\{\s*default:\s*)'(?:builtin|kimi)'(\s*,\s*\}\);)/s,
    "$1'kimi'$2",
  );

  // 删除 Agent option interface
  s = replaceRegex(
    s,
    /\ninterface IAiPromptAgentOption \{\s*key: TAiPromptAgentKind;\s*label: string;\s*\}\n/s,
    '\n',
  );

  // 删除 Agent options
  s = replaceRegex(
    s,
    /\nconst agentOptions: IAiPromptAgentOption\[] = \[\s*\{ key: 'builtin', label: 'Calamex Agent' \},\s*\{ key: 'kimi', label: 'Kimi(?: Code)?' \},\s*\];\n/s,
    '\n',
  );

  // 删除 selectedAgentOption
  s = replaceRegex(
    s,
    /\nconst selectedAgentOption = computed\(\s*\(\) => agentOptions\.find\(\(option\) => option\.key === selectedAgent\.value\) \?\? agentOptions\[0\],\s*\);\n/s,
    '\n',
  );

  // 删除 agentChange emit
  s = replaceRegex(s, /\n  agentChange: \[agent: TAiPromptAgentKind\];/, '');

  // 删除 isAgentKind + handleAgentChange
  s = replaceRegex(
    s,
    /\nconst isAgentKind = \(value: unknown\): value is TAiPromptAgentKind =>\s*value === 'builtin' \|\| value === 'kimi';\s*\n\s*\/\/ 切换会话使用的 Agent 后端。[\s\S]*?emit\('agentChange', value\);\s*\};\n/s,
    '\n',
  );

  // 删除输入框 toolbar 里的 Agent Select：从 selectedAgent 的 Select 开始，到 sessionConfigOptionsVisible 前结束
  const marker = '<template v-if="sessionConfigOptionsVisible">';
  const markerIndex = s.indexOf(marker);
  const beforeMarker = markerIndex >= 0 ? s.slice(0, markerIndex) : '';
  const modelValueIndex = beforeMarker.lastIndexOf(':model-value="selectedAgent"');

  if (markerIndex >= 0 && modelValueIndex >= 0) {
    const selectStart = beforeMarker.lastIndexOf('<Select', modelValueIndex);
    if (selectStart < 0) {
      throw new Error('未找到输入框 Agent Select 开始位置');
    }
    s = `${s.slice(0, selectStart)}${s.slice(markerIndex)}`;
  }

  save(file, before, s);
}

// -----------------------------------------------------------------------------
// 2. AiAssistantPanel.vue：左上角改成 Agent 选择器
// -----------------------------------------------------------------------------
{
  const file = files.panel;
  let s = read(file);
  const before = s;

  // lucide import 加 Bot
  s = replaceRegex(
    s,
    /import \{ SquarePen, Trash2 \} from '@lucide\/vue';/,
    "import { Bot, SquarePen, Trash2 } from '@lucide/vue';",
  );

  // 引入 Select 组件
  if (!s.includes("from '@/components/ui/select';")) {
    s = replaceMust(
      s,
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
      'AiPanelFrame import',
    );
  }

  // 默认 Agent = kimi，并添加左上角选项数据
  s = replaceMust(
    s,
    `type TSessionAgentBackend = 'builtin' | 'kimi';
const sessionAgentBackend = ref<TSessionAgentBackend>('kimi');`,
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
    'sessionAgentBackend block',
  );

  // 删除旧左上角模型标题计算，避免未使用
  s = replaceRegex(
    s,
    /\nconst aiModelName = computed\(\(\) => \{[\s\S]*?\n\}\);\nconst providerMarkTitle = computed\(\(\) => \{[\s\S]*?\n\}\);\n/s,
    '\n',
  );

  // 加 selectedAgentOption / 类型守卫
  s = replaceMust(
    s,
    `const activeAgentModelId = computed<string>(() => {
  const globalModel = assistant.config.value.selectedModel?.trim() ?? '';
  const agent = sessionAgentBackend.value;
  if (agent === 'builtin') {
    return globalModel;
  }
  const remembered = agentModelOverrides.value[agent]?.trim();
  return remembered || globalModel;
});

const {`,
    `const activeAgentModelId = computed<string>(() => {
  const globalModel = assistant.config.value.selectedModel?.trim() ?? '';
  const agent = sessionAgentBackend.value;
  if (agent === 'builtin') {
    return globalModel;
  }
  const remembered = agentModelOverrides.value[agent]?.trim();
  return remembered || globalModel;
});

const selectedAgentOption = computed(
  () => agentOptions.find((option) => option.key === sessionAgentBackend.value) ?? agentOptions[0],
);

const isSessionAgentBackend = (value: unknown): value is TSessionAgentBackend =>
  value === 'builtin' || value === 'kimi';

const {`,
    'insert selectedAgentOption',
  );

  // handleAgentBackendChange 要真正更新左上角选择
  s = replaceMust(
    s,
    `const handleAgentBackendChange = (agent: TSessionAgentBackend): void => {
  assistant.error.value = '';

  if (agent === 'kimi') {
    const threadId = assistant.activeConversationId.value;

    if (threadId) {
      void assistant.acpSessionConfigOptions.loadConfigOptions(threadId).catch(() => undefined);
    }
  }
};`,
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
    'handleAgentBackendChange',
  );

  // 替换左上角 mark
  s = replaceMust(
    s,
    `    <template #mark>
      <div class="ai-provider-mark" aria-label="当前 AI 平台和模型" :title="providerMarkTitle">
        <AiProviderIcon class="ai-provider-mark__icon" :platform-id="aiIconPlatformId" decorative />
        <span class="ai-provider-mark__copy">
          <span class="ai-provider-mark__label" v-text="aiModelName"></span>
        </span>
      </div>
    </template>`,
    `    <template #mark>
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
    </template>`,
    'replace left mark',
  );

  // 输入框不再发 agent-change
  s = replaceRegex(s, /\n\s*@agent-change="handleAgentBackendChange"/, '');

  // 替换左上角 CSS
  s = replaceMust(
    s,
    `.ai-provider-mark {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  border-radius: 7px;
  color: var(--text-primary);
}

.ai-provider-mark__icon {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
}

.ai-provider-mark__copy {
  min-width: 0;
  display: inline-flex;
  align-items: center;
}

.ai-provider-mark__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
}`,
    `.ai-agent-mark {
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
}`,
    'replace mark css',
  );

  save(file, before, s);
}

// -----------------------------------------------------------------------------
// 3. Tests 小修
// -----------------------------------------------------------------------------
{
  const file = files.promptSpec;
  let s = read(file);
  const before = s;

  s = replaceRegex(
    s,
    /const builtinWrapper = mountPromptInput\(\{\s*sessionConfigOptions\s*\}\);/,
    "const builtinWrapper = mountPromptInput({ agentBackend: 'builtin', sessionConfigOptions });",
  );

  s = replaceRegex(
    s,
    /const kimiWrapper = mountPromptInput\(\{\s*agentBackend:\s*'kimi',\s*sessionConfigOptions\s*\}\);/,
    'const kimiWrapper = mountPromptInput({ sessionConfigOptions });',
  );

  save(file, before, s);
}

{
  const file = files.panelSpec;
  let s = read(file);
  const before = s;

  s = replaceRegex(
    s,
    /AiPromptInput: defineComponent\(\{\s*emits: \['submit', 'update:activeMode', 'sessionConfigOptionChange'\],/,
    "AiPromptInput: defineComponent({\n          emits: ['submit', 'update:activeMode', 'update:agentBackend', 'sessionConfigOptionChange'],",
  );

  save(file, before, s);
}

console.log('完成。修改文件：');
for (const file of changed) {
  console.log(`- ${file}`);
}

console.log('\n下一步执行：');
console.log('pnpm test -- src/components/business/ai/chat/AiPromptInput.spec.ts src/components/business/ai/shell/AiAssistantPanel.spec.ts');
console.log('pnpm typecheck');
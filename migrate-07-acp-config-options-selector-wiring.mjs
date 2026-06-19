// migrate-07-acp-config-options-selector-wiring.mjs
// 将 config_options 选择器接入 AiPromptInput(纯展示) + AiAssistantPanel(装配)，
// 逐处镜像既有 session modes 选择器。仅本地应用，不提交。
import { readFileSync, writeFileSync } from 'node:fs';

const patchFile = (relPath, edits) => {
  const raw = readFileSync(relPath, 'utf8');
  const usesCrlf = raw.includes('\r\n');
  let text = usesCrlf ? raw.split('\r\n').join('\n') : raw;
  for (const edit of edits) {
    const count = text.split(edit.find).length - 1;
    if (count === 1) {
      text = text.split(edit.find).join(edit.replace);
    } else if (edit.optional && count === 0) {
      continue;
    } else {
      const idx = text.indexOf(edit.find);
      const ctx =
        idx >= 0
          ? text.slice(Math.max(0, idx - 220), idx + edit.find.length + 220)
          : '(anchor not found)';
      throw new Error(
        `patch anchor [${edit.key}] matched ${count} times in ${relPath}\n---\n${ctx}\n---`,
      );
    }
  }
  writeFileSync(relPath, usesCrlf ? text.split('\n').join('\r\n') : text, 'utf8');
};

const inputPath = 'src/components/business/ai/chat/AiPromptInput.vue';
const panelPath = 'src/components/business/ai/shell/AiAssistantPanel.vue';

// ---- AiPromptInput.vue（纯展示选择器） ----
if (readFileSync(inputPath, 'utf8').includes('sessionConfigOptionChange')) {
  console.log('skip AiPromptInput.vue: already wired');
} else {
  patchFile(inputPath, [
    {
      key: 'input-import',
      find: `import type { IAcpSessionModeState } from '@/types/ai/sidecar';`,
      replace: `import type {
  IAcpSessionConfigOption,
  IAcpSessionConfigOptionsState,
  IAcpSessionModeState,
} from '@/types/ai/sidecar';`,
    },
    {
      key: 'input-props',
      find: `  isSessionModeSwitching?: boolean;
  resolveAttachment: (file: File) => Promise<boolean>;`,
      replace: `  isSessionModeSwitching?: boolean;
  sessionConfigOptions?: IAcpSessionConfigOptionsState | null;
  isSessionConfigOptionSwitching?: boolean;
  resolveAttachment: (file: File) => Promise<boolean>;`,
    },
    {
      key: 'input-emits',
      find: `  sessionModeChange: [modeId: string];
  informationSourcesOpen: [];`,
      replace: `  sessionModeChange: [modeId: string];
  sessionConfigOptionChange: [configId: string, valueId: string];
  informationSourcesOpen: [];`,
    },
    {
      key: 'input-logic',
      find: `  emit('sessionModeChange', value);
};

const networkPermissionLabel = computed(`,
      replace: `  emit('sessionModeChange', value);
};

// ACP 会话配置项选择器（config_options 全量迁移）：仅 Kimi ACP agent 且后端下发配置项时
// 显示；每个 config option 渲染为独立下拉，VM 由父级经 useAcpSessionConfigOptions 下传，
// 选择时回投 (configId, valueId) 原文。
const sessionConfigOptions = computed(() => props.sessionConfigOptions?.configOptions ?? []);

const sessionConfigOptionsVisible = computed(
  () => selectedAgent.value === 'kimi' && sessionConfigOptions.value.length > 0,
);

const resolveSessionConfigOptionLabel = (option: IAcpSessionConfigOption): string => {
  const current = option.options.find((item) => item.value === option.currentValue);
  return current?.name ?? option.name;
};

const handleSessionConfigOptionChange = (configId: string, value: unknown): void => {
  if (typeof value !== 'string' || !value.trim()) {
    return;
  }
  const option = sessionConfigOptions.value.find((item) => item.id === configId);
  if (!option || value === option.currentValue) {
    return;
  }
  emit('sessionConfigOptionChange', configId, value);
};

const networkPermissionLabel = computed(`,
    },
    {
      key: 'input-template',
      find: `                    <span class="ai-agent-item__label" v-text="mode.name"></span>
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div class="ai-toolbar-spacer" aria-hidden="true"></div>`,
      replace: `                    <span class="ai-agent-item__label" v-text="mode.name"></span>
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <template v-if="sessionConfigOptionsVisible">
              <Select
                v-for="configOption in sessionConfigOptions"
                :key="configOption.id"
                :model-value="configOption.currentValue"
                :disabled="disabled || isSessionConfigOptionSwitching"
                @update:model-value="(value) => handleSessionConfigOptionChange(configOption.id, value)"
              >
                <SelectTrigger :aria-label="configOption.name" class="ai-agent-trigger">
                  <SlidersHorizontal class="ai-agent-trigger__icon" :stroke-width="1.6" />
                  <span
                    class="ai-agent-trigger__label"
                    v-text="resolveSessionConfigOptionLabel(configOption)"
                  ></span>
                </SelectTrigger>
                <SelectContent side="top" align="start" :side-offset="8" class="ai-agent-content">
                  <SelectLabel class="ai-agent-section-label" v-text="configOption.name"></SelectLabel>
                  <SelectGroup>
                    <SelectItem
                      v-for="opt in configOption.options"
                      :key="opt.value"
                      class="ai-agent-item"
                      :value="opt.value"
                    >
                      <span class="ai-agent-item__label" v-text="opt.name"></span>
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </template>
          </div>
          <div class="ai-toolbar-spacer" aria-hidden="true"></div>`,
    },
  ]);
  console.log('patched AiPromptInput.vue');
}

// ---- AiAssistantPanel.vue（装配） ----
if (readFileSync(panelPath, 'utf8').includes('acpSessionConfigOptions.loadConfigOptions')) {
  console.log('skip AiAssistantPanel.vue: already wired');
} else {
  patchFile(panelPath, [
    {
      key: 'panel-load',
      find: `    if (threadId) {
      void assistant.acpSessionModes.loadModes(threadId).catch(() => undefined);
    }`,
      replace: `    if (threadId) {
      void assistant.acpSessionModes.loadModes(threadId).catch(() => undefined);
      void assistant.acpSessionConfigOptions.loadConfigOptions(threadId).catch(() => undefined);
    }`,
    },
    {
      key: 'panel-handler',
      find: `const handleSubmitMessage = async (): Promise<void> => {`,
      replace: `// ACP 会话配置项切换（config_options 全量迁移发送侧）：选择器回投透传给
// useAcpSessionConfigOptions.selectConfigOption（乐观更新 + setSessionConfigOption 回投，
// 失败回滚并提示）。
const handleSessionConfigOptionChange = async (
  configId: string,
  valueId: string,
): Promise<void> => {
  const threadId = assistant.activeConversationId.value;
  if (!threadId) {
    return;
  }
  try {
    await assistant.acpSessionConfigOptions.selectConfigOption(threadId, configId, valueId);
  } catch (error) {
    assistant.error.value = toErrorMessage(error, '切换会话配置失败。');
  }
};

const handleSubmitMessage = async (): Promise<void> => {`,
    },
    {
      key: 'panel-props',
      find: `          :session-modes="assistant.acpSessionModes.state.value"
          :is-session-mode-switching="assistant.acpSessionModes.isSwitching.value"`,
      replace: `          :session-modes="assistant.acpSessionModes.state.value"
          :is-session-mode-switching="assistant.acpSessionModes.isSwitching.value"
          :session-config-options="assistant.acpSessionConfigOptions.state.value"
          :is-session-config-option-switching="assistant.acpSessionConfigOptions.isSwitching.value"`,
    },
    {
      key: 'panel-event',
      find: `          @session-mode-change="handleSessionModeChange"
          @information-sources-open="openPromptInformationSources" @personalization-open="openPromptPersonalization"`,
      replace: `          @session-mode-change="handleSessionModeChange"
          @session-config-option-change="handleSessionConfigOptionChange"
          @information-sources-open="openPromptInformationSources" @personalization-open="openPromptPersonalization"`,
    },
  ]);
  console.log('patched AiAssistantPanel.vue');
}
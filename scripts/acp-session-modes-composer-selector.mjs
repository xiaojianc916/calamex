#!/usr/bin/env node
// ACP 会话模式选择器接入组合器（ADR-20260617 · D7-③-c）。
//
// 在 src/components/business/ai/chat/AiPromptInput.vue 的工具栏（Agent 选择器旁）
// 加一个 ACP 会话模式 <Select>：追加可选 props（sessionModes /
// isSessionModeSwitching）+ sessionModeChange emit，仅在 Kimi ACP agent 且后端提供
// 了可用模式时显示。VM 由父级经 useAcpSessionModes 下传，选择时回投 modeId
// 原文。对现有调用方零行为变化（可选 props 缺省 undefined => 选择器隐藏）。
//
// 实时宿主接线（loadModes / mode_update 路由）有意推迟到 Kimi 发送链路落地，
// 避免给不存在的链路铺死代码。幂等 + EOL 容忍。

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/components/business/ai/chat/AiPromptInput.vue';

const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

const main = () => {
  const original = readFileSync(FILE, 'utf8');

  if (original.includes('sessionModeSelectorVisible')) {
    console.log('[skip] AiPromptInput.vue 已含会话模式选择器，无需再改。');
    return;
  }

  const eol = detectEol(original);
  const withEol = (s) => s.replace(/\n/g, eol);

  let text = original;

  const replaceOnce = (anchorLf, replacementLf) => {
    const anchor = withEol(anchorLf);
    const count = text.split(anchor).length - 1;
    if (count !== 1) {
      throw new Error(
        `expected exactly 1 match but found ${count} for anchor:\n${anchorLf}`,
      );
    }
    text = text.replace(anchor, () => withEol(replacementLf));
  };

  // 1) import 生成/手写会话模式 VM 类型（biome import 顺序：execution-mode < sidecar < skill）
  replaceOnce(
    "import type { TAiExecutionMode } from '@/types/ai/execution-mode';\n",
    "import type { TAiExecutionMode } from '@/types/ai/execution-mode';\nimport type { IAcpSessionModeState } from '@/types/ai/sidecar';\n",
  );

  // 2) props：追加可选 sessionModes / isSessionModeSwitching
  replaceOnce(
    '  executionMode: TAiExecutionMode;\n  resolveAttachment: (file: File) => Promise<boolean>;\n}>();',
    '  executionMode: TAiExecutionMode;\n  sessionModes?: IAcpSessionModeState | null;\n  isSessionModeSwitching?: boolean;\n  resolveAttachment: (file: File) => Promise<boolean>;\n}>();',
  );

  // 3) emit：追加 sessionModeChange
  replaceOnce(
    '  executionModeChange: [mode: TAiExecutionMode];\n',
    '  executionModeChange: [mode: TAiExecutionMode];\n  sessionModeChange: [modeId: string];\n',
  );

  // 4) computeds + 变更处理（接在 selectedAgentOption 之后）
  replaceOnce(
    'const selectedAgentOption = computed(\n  () => agentOptions.find((option) => option.key === selectedAgent.value) ?? agentOptions[0],\n);',
    [
      'const selectedAgentOption = computed(',
      '  () => agentOptions.find((option) => option.key === selectedAgent.value) ?? agentOptions[0],',
      ');',
      '',
      '// ACP 会话模式选择器（ADR-20260617 · D7-c）：仅在 Kimi ACP agent 且后端提供了可用',
      '// 模式时显示；VM 由父级经 useAcpSessionModes 下传，选择时回投 modeId 原文。',
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
    ].join('\n'),
  );

  // 5) template：在 Agent <Select> 之后、ai-toolbar-left 闭合之前插入会话模式 <Select>
  replaceOnce(
    [
      '              </SelectContent>',
      '            </Select>',
      '          </div>',
      '          <div class="ai-toolbar-spacer" aria-hidden="true"></div>',
    ].join('\n'),
    [
      '              </SelectContent>',
      '            </Select>',
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
      '          </div>',
      '          <div class="ai-toolbar-spacer" aria-hidden="true"></div>',
    ].join('\n'),
  );

  if (text === original) {
    throw new Error('no changes produced — anchors may have drifted.');
  }

  writeFileSync(FILE, text, 'utf8');
  console.log('[done] AiPromptInput.vue 已接入 ACP 会话模式选择器。');
};

main();

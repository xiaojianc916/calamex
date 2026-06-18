#!/usr/bin/env node
// ACP 会话模式选择器接入组合器（ADR-20260617 · D7-c）。
//
// 在 src/components/business/ai/chat/AiPromptInput.vue 的工具栏（Agent 选择器旁）
// 加一个 ACP 会话模式 <Select>：追加可选 props（sessionModes /
// isSessionModeSwitching）+ sessionModeChange emit，仅在 Kimi ACP agent 且后端提供
// 了可用模式时显示。VM 由父级经 useAcpSessionModes 下传，选择时回投 modeId 原文。
// 对现有调用方零行为变化（可选 props 缺省 undefined => 选择器隐藏）。
//
// 幂等 + EOL 容忍。导入用正则，容忍 biome 导入重排 / 引号差异。

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/components/business/ai/chat/AiPromptInput.vue';

const detectEol = (t) => (t.includes('\r\n') ? '\r\n' : '\n');

const main = () => {
  const original = readFileSync(FILE, 'utf8');

  if (original.includes('sessionModeSelectorVisible')) {
    console.log('[skip] AiPromptInput.vue 已含会话模式选择器，无需再改。');
    return;
  }

  const eol = detectEol(original);
  const withEol = (s) => s.replace(/\n/g, eol);

  let text = original;

  const dumpContext = (keyword) => {
    console.error(`--- 上下文 "${keyword}" ---`);
    text.split(/\r?\n/).forEach((line, idx) => {
      if (line.includes(keyword)) {
        console.error(`${idx + 1}: ${line}`);
      }
    });
    console.error('--- end ---');
  };

  const replaceOnce = (anchorLf, replacementLf, keyword) => {
    const anchor = withEol(anchorLf);
    const count = text.split(anchor).length - 1;
    if (count !== 1) {
      dumpContext(keyword);
      throw new Error(`[${keyword}] expected exactly 1 match but found ${count}`);
    }
    text = text.replace(anchor, () => withEol(replacementLf));
  };

  // 1) import：稳健合并/插入 IAcpSessionModeState（容忍 biome 导入重排/引号差异）。
  if (!/\bIAcpSessionModeState\b/.test(text)) {
    const sidecarRe = /import\s+type\s*\{([^}]*)\}\s*from\s*(['"])@\/types\/ai\/sidecar\2;/;
    if (sidecarRe.test(text)) {
      text = text.replace(sidecarRe, (_m, inner, q) => {
        const names = inner
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!names.includes('IAcpSessionModeState')) {
          names.push('IAcpSessionModeState');
        }
        names.sort((a, b) => a.localeCompare(b));
        return `import type { ${names.join(', ')} } from ${q}@/types/ai/sidecar${q};`;
      });
    } else {
      const newImport = "import type { IAcpSessionModeState } from '@/types/ai/sidecar';";
      const skillRe =
        /([ \t]*)(import\s+type\s*\{[^}]*\}\s*from\s*['"]@\/types\/ai\/skill['"];)/;
      const execRe =
        /([ \t]*import\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"]@\/types\/ai\/execution-mode['"];)/;
      if (skillRe.test(text)) {
        text = text.replace(skillRe, (_m, indent, line) => `${indent}${newImport}${eol}${indent}${line}`);
      } else if (execRe.test(text)) {
        text = text.replace(execRe, (m) => `${m}${eol}${newImport}`);
      } else {
        dumpContext('@/types/ai/');
        throw new Error('[import] 找不到可插入 sidecar 类型导入的锚点。');
      }
    }
  }

  // 2) props：追加可选 sessionModes / isSessionModeSwitching
  replaceOnce(
    '  executionMode: TAiExecutionMode;\n  resolveAttachment: (file: File) => Promise<boolean>;\n}>();',
    '  executionMode: TAiExecutionMode;\n  sessionModes?: IAcpSessionModeState | null;\n  isSessionModeSwitching?: boolean;\n  resolveAttachment: (file: File) => Promise<boolean>;\n}>();',
    'resolveAttachment',
  );

  // 3) emit：追加 sessionModeChange
  replaceOnce(
    '  executionModeChange: [mode: TAiExecutionMode];\n',
    '  executionModeChange: [mode: TAiExecutionMode];\n  sessionModeChange: [modeId: string];\n',
    'executionModeChange',
  );

  // 4) computeds + 变更处理（接在 selectedAgentOption 之后）
  replaceOnce(
    [
      'const selectedAgentOption = computed(',
      '  () => agentOptions.find((option) => option.key === selectedAgent.value) ?? agentOptions[0],',
      ');',
    ].join('\n'),
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
    'selectedAgentOption',
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
    'ai-toolbar-spacer',
  );

  if (text === original) {
    throw new Error('no changes produced — anchors may have drifted.');
  }

  writeFileSync(FILE, text, 'utf8');
  console.log('[done] AiPromptInput.vue 已接入 ACP 会话模式选择器。');
};

main();

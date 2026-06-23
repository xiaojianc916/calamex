// fix-aiprompt-main.codemod.mjs — 对 current main(bc01f3f7 / blob eeb5944a) 验证过锚点。
// ⑧-f 改为单行纯文本锚，规避 CRLF/行尾空格；其余沿用已证实命中的锚。
// 幂等：done 标记已存在=>跳过；否则 find 恰好 1 次=>应用；否则报错并打印本地相关行。整文件原子，不碰 git、不备份。
import { readFileSync, writeFileSync } from 'node:fs';

const VUE = 'src/components/business/ai/chat/AiPromptInput.vue';
const SPEC = 'src/components/business/ai/chat/AiPromptInput.spec.ts';

const FILES = [
  {
    path: VUE,
    edits: [
      {
        id: '⑥⑦-a import ContextTrigger',
        done: `  ContextTrigger,\n} from '@/components/ai-elements/context';`,
        probe: [`from '@/components/ai-elements/context'`, `ContextOutputUsage`],
        find: `  ContextOutputUsage,\n} from '@/components/ai-elements/context';`,
        replace: `  ContextOutputUsage,\n  ContextTrigger,\n} from '@/components/ai-elements/context';`,
      },
      {
        id: '⑧-b 拓宽 sidecar 类型 import',
        done: `  IAcpSessionConfigOptionsState,\n} from '@/types/ai/sidecar';`,
        probe: [`from '@/types/ai/sidecar'`],
        find: `import type { IAcpAvailableCommand } from '@/types/ai/sidecar';`,
        replace:
          `import type {\n` +
          `  IAcpAvailableCommand,\n` +
          `  IAcpSessionConfigOption,\n` +
          `  IAcpSessionConfigOptionsState,\n` +
          `} from '@/types/ai/sidecar';`,
      },
      {
        id: '⑧-c 新增 props',
        done: `  sessionConfigOptions?: IAcpSessionConfigOptionsState | null;`,
        probe: [`acpCommands?: readonly IAcpAvailableCommand[];`],
        find: `  acpCommands?: readonly IAcpAvailableCommand[];\n}>();`,
        replace:
          `  acpCommands?: readonly IAcpAvailableCommand[];\n` +
          `  /** Kimi(ACP) 会话级配置项（模型 / 思考强度等）；仅 kimi Agent 时渲染为选择器。 */\n` +
          `  sessionConfigOptions?: IAcpSessionConfigOptionsState | null;\n` +
          `  /** 配置项切换中（等待 ACP 回执）；为 true 时禁用选择器，避免并发切换。 */\n` +
          `  isSessionConfigOptionSwitching?: boolean;\n` +
          `}>();`,
      },
      {
        id: '⑧-d 新增 emit',
        done: `  sessionConfigOptionChange: [optionId: string, value: string];`,
        probe: [`prewarm: [];`],
        find: `  prewarm: [];\n}>();`,
        replace:
          `  prewarm: [];\n` +
          `  sessionConfigOptionChange: [optionId: string, value: string];\n` +
          `}>();`,
      },
      {
        id: '⑧-e 新增 computed/helpers',
        done: `const sessionConfigOptionList = computed`,
        probe: [`const acpSlashCommands = computed`],
        find: `const acpSlashCommands = computed<readonly IAcpAvailableCommand[]>(() => props.acpCommands ?? []);`,
        replace:
          `const acpSlashCommands = computed<readonly IAcpAvailableCommand[]>(() => props.acpCommands ?? []);\n\n` +
          `// Kimi(ACP) 会话级配置项：父级下传 configOptions，渲染为「每项一个选择器」。\n` +
          `const sessionConfigOptionList = computed<readonly IAcpSessionConfigOption[]>(\n` +
          `  () => props.sessionConfigOptions?.configOptions ?? [],\n` +
          `);\n\n` +
          `// 入口文案：把 currentValue 映射成对应选项名；找不到时回退原始值。\n` +
          `const resolveSessionConfigOptionLabel = (option: IAcpSessionConfigOption): string => {\n` +
          `  const current = option.options.find((choice) => choice.value === option.currentValue);\n` +
          `  return current?.name ?? option.currentValue;\n` +
          `};\n\n` +
          `// 切换配置项：仅上抛 (optionId, value)，由父级落实到 ACP 会话。\n` +
          `const handleSessionConfigOptionSelect = (optionId: string, value: unknown): void => {\n` +
          `  if (typeof value !== 'string' || !value.trim()) {\n` +
          `    return;\n` +
          `  }\n` +
          `  emit('sessionConfigOptionChange', optionId, value);\n` +
          `};`,
      },
      {
        id: '⑧-f 模板插入配置项选择器（单行锚，免疫 CRLF/行尾空格）',
        done: `class="ai-agent-trigger"`,
        probe: [`</Select>`, `<Context v-bind`, `resolvedTokenContext`],
        // 关键：find 不含前导空格、不含换行。匹配 1427 行那段纯文本即可，行尾/换行都不影响。
        find: `<Context v-bind="resolvedTokenContext" :cost="tokenUsageCost">`,
        replace:
          `<template v-if="selectedAgent === 'kimi'">\n` +
          `            <Select\n` +
          `              v-for="option in sessionConfigOptionList"\n` +
          `              :key="option.id"\n` +
          `              :model-value="option.currentValue"\n` +
          `              :disabled="modelSelectDisabled || isSessionConfigOptionSwitching"\n` +
          `              @update:model-value="(value) => handleSessionConfigOptionSelect(option.id, value)"\n` +
          `            >\n` +
          `              <SelectTrigger :aria-label="option.name" class="ai-agent-trigger">\n` +
          `                <span\n` +
          `                  class="ai-agent-trigger__label"\n` +
          `                  v-text="resolveSessionConfigOptionLabel(option)"\n` +
          `                ></span>\n` +
          `              </SelectTrigger>\n` +
          `              <SelectContent\n` +
          `                side="top"\n` +
          `                align="end"\n` +
          `                :side-offset="8"\n` +
          `                class="ai-agent-content"\n` +
          `              >\n` +
          `                <SelectGroup>\n` +
          `                  <SelectItem\n` +
          `                    v-for="choice in option.options"\n` +
          `                    :key="choice.value"\n` +
          `                    class="ai-agent-item"\n` +
          `                    :value="choice.value"\n` +
          `                  >\n` +
          `                    <span class="ai-agent-item__label" v-text="choice.name"></span>\n` +
          `                  </SelectItem>\n` +
          `                </SelectGroup>\n` +
          `              </SelectContent>\n` +
          `            </Select>\n` +
          `          </template>\n` +
          `          <Context v-bind="resolvedTokenContext" :cost="tokenUsageCost">`,
      },
    ],
  },
  {
    path: SPEC,
    edits: [
      {
        id: '④⑤-g import flushPromises',
        done: `import { flushPromises, mount } from '@vue/test-utils';`,
        probe: [`@vue/test-utils`],
        find: `import { mount } from '@vue/test-utils';`,
        replace: `import { flushPromises, mount } from '@vue/test-utils';`,
      },
      {
        id: '④⑤-h mock 原生文件选择器',
        done: `vi.mock('@/components/business/ai/chat/attachment-file-picker'`,
        probe: [`attachment-file-picker`, `@/types/ai/sidecar`],
        find: `import type { IAcpSessionConfigOptionsState } from '@/types/ai/sidecar';`,
        replace:
          `import type { IAcpSessionConfigOptionsState } from '@/types/ai/sidecar';\n` +
          `import { pickAttachmentFilesViaNativeDialog } from '@/components/business/ai/chat/attachment-file-picker';\n\n` +
          `vi.mock('@/components/business/ai/chat/attachment-file-picker', () => ({\n` +
          `  pickAttachmentFilesViaNativeDialog: vi.fn(() => Promise.resolve([] as File[])),\n` +
          `}));`,
      },
      {
        id: '④-i routes chosen files',
        done:
          `    const file = new File(['readme'], 'README.md', { type: 'text/markdown' });\n` +
          `    vi.mocked(pickAttachmentFilesViaNativeDialog).mockResolvedValueOnce([file]);`,
        probe: [`routes chosen files`, `input[type="file"]`],
        find:
          `    const file = new File(['readme'], 'README.md', { type: 'text/markdown' });\n` +
          `    const fileInput = wrapper.get('input[type="file"]');\n\n` +
          `    Object.defineProperty(fileInput.element, 'files', {\n` +
          `      configurable: true,\n` +
          `      value: [file],\n` +
          `    });\n\n` +
          `    await fileInput.trigger('change');\n`,
        replace:
          `    const file = new File(['readme'], 'README.md', { type: 'text/markdown' });\n` +
          `    vi.mocked(pickAttachmentFilesViaNativeDialog).mockResolvedValueOnce([file]);\n\n` +
          `    await wrapper.get('.ai-attachment-button').trigger('click');\n` +
          `    await flushPromises();\n`,
      },
      {
        id: '⑤-j processing overlay',
        done:
          `    const file = new File(['image-bytes'], 'pasted-image.png', { type: 'image/png' });\n` +
          `    vi.mocked(pickAttachmentFilesViaNativeDialog).mockResolvedValueOnce([file]);`,
        probe: [`processing overlay`, `input[type="file"]`],
        find:
          `    const file = new File(['image-bytes'], 'pasted-image.png', { type: 'image/png' });\n` +
          `    const fileInput = wrapper.get('input[type="file"]');\n\n` +
          `    Object.defineProperty(fileInput.element, 'files', {\n` +
          `      configurable: true,\n` +
          `      value: [file],\n` +
          `    });\n\n` +
          `    await fileInput.trigger('change');\n` +
          `    await nextTick();\n`,
        replace:
          `    const file = new File(['image-bytes'], 'pasted-image.png', { type: 'image/png' });\n` +
          `    vi.mocked(pickAttachmentFilesViaNativeDialog).mockResolvedValueOnce([file]);\n\n` +
          `    await wrapper.get('.ai-attachment-button').trigger('click');\n` +
          `    await flushPromises();\n` +
          `    await nextTick();\n`,
      },
    ],
  },
];

const count = (h, n) => h.split(n).length - 1;
const dump = (text, probes) => {
  const out = [];
  text.split('\n').forEach((ln, i) => {
    if (probes.some((p) => ln.includes(p))) out.push(`        ${String(i + 1).padStart(4)}| ${ln}`);
  });
  return out.length ? out.slice(0, 10).join('\n') : '        （probe 未匹配到任何行）';
};

let hadSkip = false;
for (const file of FILES) {
  let text;
  try {
    text = readFileSync(file.path, 'utf8');
  } catch {
    console.log(`✗ ${file.path} · 读不到文件，跳过。`);
    hadSkip = true;
    continue;
  }

  const plan = [];
  const skipped = [];
  const errors = [];
  for (const e of file.edits) {
    if (text.includes(e.done)) {
      skipped.push(e.id);
      continue;
    }
    const n = count(text, e.find);
    if (n === 1) plan.push(e);
    else errors.push({ e, n });
  }

  if (errors.length) {
    console.log(`✗ ${file.path} · 跳过整个文件：`);
    for (const { e, n } of errors) {
      console.log(`    - ${e.id}：未应用且 find 命中 ${n} 次（应为 1）。本地相关行：`);
      console.log(dump(text, e.probe));
    }
    if (skipped.length) console.log(`    （已应用、本可跳过：${skipped.join(' / ')}）`);
    hadSkip = true;
    continue;
  }

  let next = text;
  for (const e of plan) next = next.replace(e.find, () => e.replace);
  if (plan.length) writeFileSync(file.path, next, 'utf8');
  console.log(
    `✓ ${file.path} · 应用 ${plan.length} 处` +
      (skipped.length ? `，跳过 ${skipped.length} 处(已应用：${skipped.join(' / ')})` : ''),
  );
}

console.log(
  hadSkip
    ? '\n有文件未完成，请勿提交。把上面打印的「本地相关行」贴给我。'
    : '\n就绪：vue 应用 6 处、spec 4 处已应用跳过。请 pnpm test 验证后再决定是否提交。',
);
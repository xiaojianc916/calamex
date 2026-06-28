#!/usr/bin/env node
// P2 收尾：清理 AiAssistantPanel.spec.ts 里的三处死 mock（useFrontendTool / useCopilotContext / @copilotkit/vue）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const WRITE = process.argv.includes('--write');
const ROOT = process.cwd();
const SPEC = 'src/components/business/ai/shell/AiAssistantPanel.spec.ts';

const file = resolve(ROOT, SPEC);
if (!existsSync(file)) { console.error('缺文件:', SPEC); process.exit(1); }

const raw = readFileSync(file, 'utf8');
const eol = /\r\n/.test(raw) ? '\r\n' : '\n';
let norm = raw.replace(/\r\n/g, '\n');

const ops = [
  ["useFrontendToolMock hoisted",   "const useFrontendToolMock = vi.hoisted(() => vi.fn());\n"],
  ["useCopilotContextMock hoisted",  "const useCopilotContextMock = vi.hoisted(() => vi.fn());\n"],
  ["vi.mock @copilotkit/vue",        "vi.mock('@copilotkit/vue', () => ({\n  useFrontendTool: useFrontendToolMock,\n}));\n\n"],
  ["vi.mock useCopilotContext",      "vi.mock('@/composables/ai/useCopilotContext', () => ({\n  useCopilotContext: useCopilotContextMock,\n}));\n\n"],
  ["beforeEach useFrontendToolMock", "    useFrontendToolMock.mockReturnValue(undefined);\n"],
  ["beforeEach useCopilotContextMock","    useCopilotContextMock.mockReturnValue(undefined);\n"],
];

let ok = 0, skip = 0;
for (const [label, snippet] of ops) {
  const n = norm.split(snippet).length - 1;
  if (n === 0) { console.log(`  · 跳过(已删) :: ${label}`); skip++; continue; }
  if (n > 1)   { console.error(`  ✗ 非唯一(x${n}) :: ${label}`); process.exit(1); }
  norm = norm.replace(snippet, '');
  console.log(`  ✓ ${WRITE ? '已删除' : '将删除'} :: ${label}`);
  ok++;
}

if (WRITE && ok > 0) writeFileSync(file, eol === '\n' ? norm : norm.replace(/\n/g, eol));
console.log(`\n小结：变更 ${ok}，跳过 ${skip}。${WRITE ? ' 落盘完成。' : ' (dry-run) 加 --write 落盘。'}`);
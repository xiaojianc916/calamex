#!/usr/bin/env node
// fix-kimi-modes.mjs —— KIMI_MODES 首项 key：normal → default
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'src/components/business/ai/chat/AiPromptInput.vue';
const OLD = `{ key: 'normal', label: 'Default' },`;
const NEW = `{ key: 'default', label: 'Default' },`;

const abs = join(process.cwd(), FILE);
if (!existsSync(abs)) { console.log(`[MISS] 文件不存在：${FILE}`); process.exit(1); }

const original = readFileSync(abs, 'utf8');
const eol = /\r\n/.test(original) ? '\r\n' : '\n';
const text = original.replace(/\r\n/g, '\n');

if (text.includes(NEW)) { console.log('[skip] 已应用，无需改动'); process.exit(0); }

const hits = text.split(OLD).length - 1;
if (hits !== 1) {
  console.log(`[FAIL] 命中 ${hits} 次（期望 1）：${FILE}`);
  process.exit(1);
}

writeFileSync(abs, (text.split(OLD).join(NEW)).replace(/\n/g, eol), 'utf8');
console.log(`[ok]   ${FILE} :: KIMI_MODES 首项 key normal→default，已写入。`);
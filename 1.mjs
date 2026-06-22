// 1.mjs  （仓库根目录跑：node 1.mjs）
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/components/business/ai/chat/AiChatThread.vue';
let s = readFileSync(path, 'utf8');

if (s.includes('scrollbar-gutter')) {
  console.log('· 已包含 scrollbar-gutter，跳过');
  process.exit(0);
}

// 容错匹配：行首缩进 + scrollbar-width: thin; + 行尾（CRLF 或 LF 均可）
const re = /^([ \t]*)scrollbar-width:[ \t]*thin;[ \t]*\r?\n/m;
const m = s.match(re);

if (!m) throw new Error('找不到 "scrollbar-width: thin;" 行，请确认文件未被改过');

const indent = m[1];
const eol = m[0].endsWith('\r\n') ? '\r\n' : '\n';

s = s.replace(re, (full) => `${full}${indent}scrollbar-gutter: stable;${eol}`);

writeFileSync(path, s, 'utf8');
console.log('✓ 已为聊天滚动容器加上 scrollbar-gutter: stable');
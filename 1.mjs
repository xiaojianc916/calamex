#!/usr/bin/env node
/**
 * C1.3 — drop commitDisplayMessagesToStore (definition + all 15 call sites).
 *
 * 背景：post-C1.2，`messages` 计算属性的 setter 已直接持久化活动线程写入，
 * updateLiveThreadFromSidecarEvents 经 overlayStreamingActiveThread / 后台
 * replaceThreadMessages 直接写权威 entries。commitDisplayMessagesToStore 只是
 * 用 store 重写 store，其唯一真实副作用是 legacy message 往返
 * (threadEntriesToMessages -> legacyMessageToEntries)，会把多个 thought chunk
 * 塌缩成一个。删除后 reasoning 按 entries 真源保留多段（与流式视图一致）。
 *
 * 安全性：每处调用要么前置 `messages.value` 赋值（setter 落库），要么在
 * finalize 之后（overlay 落库），故不丢任何 store 写入，只去掉塌缩往返。
 *
 * 用法：
 *   node scripts/c1-3-drop-commit-display-messages.mjs           # 干跑
 *   node scripts/c1-3-drop-commit-display-messages.mjs --apply   # 写入
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/composables/ai/useAiAssistant.ts';
const APPLY = process.argv.includes('--apply');
const EXPECTED_CALLS = 15;

const raw = readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
let text = crlf ? raw.split('\r\n').join('\n') : raw;

const errors = [];
const fail = (m) => errors.push(m);

// 1) 用无引号区域锚点删除函数定义块。
const DEF_START = '  const commitDisplayMessagesToStore = (';
const DEF_END_MARK = 'conversationStore.replaceMessages(messages.value);';
const NEXT_ANCHOR =
  '  const clearActiveBufferedThread = (threadId: string | null): void => {';

const startIdx = text.indexOf(DEF_START);
const startIdx2 = startIdx === -1 ? -1 : text.indexOf(DEF_START, startIdx + DEF_START.length);
const endMarkIdx = text.indexOf(DEF_END_MARK);
const endMarkIdx2 =
  endMarkIdx === -1 ? -1 : text.indexOf(DEF_END_MARK, endMarkIdx + DEF_END_MARK.length);
const nextIdx = text.indexOf(NEXT_ANCHOR);
const nextIdx2 = nextIdx === -1 ? -1 : text.indexOf(NEXT_ANCHOR, nextIdx + NEXT_ANCHOR.length);

if (startIdx === -1) fail('definition start anchor not found');
if (startIdx2 !== -1) fail('definition start anchor not unique');
if (endMarkIdx === -1) fail('definition end marker not found');
if (endMarkIdx2 !== -1) fail('definition end marker not unique');
if (nextIdx === -1) fail('next-const anchor not found');
if (nextIdx2 !== -1) fail('next-const anchor not unique');

if (errors.length === 0) {
  if (!(startIdx < endMarkIdx && endMarkIdx < nextIdx)) {
    fail('anchors out of expected order; aborting to avoid bad cut');
  } else {
    text = text.slice(0, startIdx) + text.slice(nextIdx);
  }
}

// 2) 删除全部独立调用语句。
let callCount = 0;
if (errors.length === 0) {
  const CALL_RE = /^[ \t]*commitDisplayMessagesToStore\([^)]*\);\n/gm;
  callCount = (text.match(CALL_RE) || []).length;
  if (callCount !== EXPECTED_CALLS) {
    fail(`expected ${EXPECTED_CALLS} call statements, found ${callCount}`);
  } else {
    text = text.replace(CALL_RE, '');
  }
}

// 3) 不得残留任何引用。
if (errors.length === 0 && text.includes('commitDisplayMessagesToStore')) {
  fail('residual reference to commitDisplayMessagesToStore remains');
}

if (errors.length > 0) {
  console.error('FAILED — no changes written:\n - ' + errors.join('\n - '));
  process.exit(1);
}

const out = crlf ? text.split('\n').join('\r\n') : text;
if (APPLY) {
  writeFileSync(FILE, out, 'utf8');
  console.log(`applied: removed definition + ${callCount} call sites in ${FILE}`);
} else {
  console.log(`dry-run OK: would remove definition + ${callCount} call sites in ${FILE}`);
}
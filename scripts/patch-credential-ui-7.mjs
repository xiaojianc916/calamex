#!/usr/bin/env node
// patch-credential-ui-7.mjs
// 问题:厂商 / 小模型两个下拉框里每一项都显示对勾(应只勾选中项)。
//       对勾是 <span class="icon-[lucide--check]">(图标=span 遮罩,不是 <svg>),
//       而隐藏样式写的是 svg:last-child,匹配不到 span,默认 opacity:0 从未生效。
// 修复:把选择器改为命中选项的最后一个子元素(即对勾),默认隐藏,仅 .is-selected 显示。
// 两个下拉框共用同一套 .ai-credential-combobox-option 样式,一处改好两个都正常。
// 特性:幂等(已应用则跳过) + CRLF 安全(匹配前归一化为 \n,写回还原行尾)。仅改 AiProviderSettings.vue。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(
  __dirname,
  '../src/components/business/ai/provider/AiProviderSettings.vue',
);

const raw = readFileSync(TARGET, 'utf8');
const usesCRLF = raw.includes('\r\n');
let src = raw.replace(/\r\n/g, '\n');

let applied = 0;
let skipped = 0;

function applyEdit({ label, find, replace, done }) {
  if (done && src.includes(done)) {
    console.log(`\u2022 \u8df3\u8fc7(\u5df2\u5e94\u7528):${label}`);
    skipped += 1;
    return;
  }
  const idx = src.indexOf(find);
  if (idx === -1) {
    throw new Error(`\u274c \u672a\u627e\u5230\u951a\u70b9:${label}`);
  }
  if (src.indexOf(find, idx + 1) !== -1) {
    throw new Error(`\u274c \u951a\u70b9\u4e0d\u552f\u4e00:${label}`);
  }
  src = src.slice(0, idx) + replace + src.slice(idx + find.length);
  console.log(`\u2713 \u5df2\u5e94\u7528:${label}`);
  applied += 1;
}

// A) 默认隐藏对勾:svg:last-child -> 选项最后一个子元素
applyEdit({
  label: '#Check-A \u9ed8\u8ba4\u9690\u85cf\u5bf9\u52fe',
  find: `.ai-credential-combobox-option :deep(svg:last-child) {\n  width: 13px;\n  height: 13px;\n  opacity: 0;\n}`,
  replace: `.ai-credential-combobox-option > :last-child {\n  flex: none;\n  width: 13px;\n  height: 13px;\n  opacity: 0;\n}`,
  done: `.ai-credential-combobox-option > :last-child {`,
});

// B) 选中项显示对勾
applyEdit({
  label: '#Check-B \u9009\u4e2d\u9879\u663e\u793a\u5bf9\u52fe',
  find: `.ai-credential-combobox-option.is-selected :deep(svg:last-child) {\n  opacity: 1;\n}`,
  replace: `.ai-credential-combobox-option.is-selected > :last-child {\n  opacity: 1;\n}`,
  done: `.ai-credential-combobox-option.is-selected > :last-child {`,
});

const out = usesCRLF ? src.replace(/\n/g, '\r\n') : src;
writeFileSync(TARGET, out, 'utf8');
console.log(`\n\u5b8c\u6210:\u5e94\u7528 ${applied} \u5904,\u8df3\u8fc7 ${skipped} \u5904 -> ${TARGET}`);

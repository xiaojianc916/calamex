#!/usr/bin/env node
// patch-credential-ui-8.mjs
// 问题:下拉选项 .ai-credential-combobox-option span { flex:1 } 用的是后代选择器,
//       把图标包裹 span / 文字 span / 对勾 全部拉伸,导致图标与文字被推向中间,整体发散。
// 修复:只让标签文字(唯一无类名的直接子 span)占 flex:1,图标 / 对勾 不再被拉伸。
//       效果:图标+文字靠左紧贴,对勾留在最右。
// 特性:幂等(已应用则跳过) + CRLF 安全。仅改 AiProviderSettings.vue。

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

// 只让标签文字 span 占 flex:1(图标与对勾都有类名,被 :not([class]) 排除)
applyEdit({
  label: '#Align \u6807\u7b7e\u72ec\u5360 flex:1',
  find: `.ai-credential-combobox-option span {\n  min-width: 0;\n  flex: 1;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}`,
  replace: `.ai-credential-combobox-option > span:not([class]) {\n  min-width: 0;\n  flex: 1;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}`,
  done: `.ai-credential-combobox-option > span:not([class]) {`,
});

const out = usesCRLF ? src.replace(/\n/g, '\r\n') : src;
writeFileSync(TARGET, out, 'utf8');
console.log(`\n\u5b8c\u6210:\u5e94\u7528 ${applied} \u5904,\u8df3\u8fc7 ${skipped} \u5904 -> ${TARGET}`);

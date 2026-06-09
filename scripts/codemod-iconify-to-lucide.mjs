#!/usr/bin/env node
// scripts/codemod-iconify-to-lucide.mjs
// 把 Vue 模板里的 icon-[lucide--xxx](@iconify/tailwind4) 图标 span
// 改写为 @lucide/vue 组件，并自动合并/插入 import。
// 默认 dry-run；--write 才写入。不生成 .bak（用 git 回滚）。
//
//   node scripts/codemod-iconify-to-lucide.mjs           # 预览
//   node scripts/codemod-iconify-to-lucide.mjs --write   # 写入
//   node scripts/codemod-iconify-to-lucide.mjs --root src
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const ROOT = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : 'src';

// 非全局用于布尔判断，全局用工厂函数避免 lastIndex 状态污染
const ICON_T = /icon-\[lucide--([a-z0-9]+(?:-[a-z0-9]+)*)\]/;
const ICON_G = () => /icon-\[lucide--([a-z0-9]+(?:-[a-z0-9]+)*)\]/g;

const toPascal = (name) =>
  name.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

const warnings = [];
const warn = (file, kind, snippet) => warnings.push({ file, kind, snippet });

function splitIconClass(classValue) {
  const matches = [...classValue.matchAll(ICON_G())];
  if (matches.length === 0) return null;
  if (matches.length > 1) return { multi: true };
  return {
    iconName: matches[0][1],
    rest: classValue.replace(ICON_G(), '').replace(/\s+/g, ' ').trim(),
  };
}

function injectImports(src, iconSet, file) {
  const sorted = [...iconSet].sort();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]@lucide\/vue['"]\s*;?/;
  const m = src.match(importRe);
  if (m) {
    const merged = [...new Set([...m[1].split(',').map((s) => s.trim()).filter(Boolean), ...sorted])].sort();
    return src.replace(importRe, `import { ${merged.join(', ')} } from '@lucide/vue';`);
  }
  const open = src.match(/<script\b[^>]*>/);
  if (!open) { warn(file, 'no-script-block', '需手动加 import'); return src; }
  const at = open.index + open[0].length;
  return src.slice(0, at) + `\nimport { ${sorted.join(', ')} } from '@lucide/vue';` + src.slice(at);
}

let convertedTags = 0, changedFiles = 0;

for (const file of walk(ROOT)) {
  const ext = extname(file);
  if (!['.vue', '.ts', '.mts', '.css', '.scss'].includes(ext)) continue;
  const src = readFileSync(file, 'utf8');
  if (!ICON_T.test(src)) continue;

  if (ext !== '.vue') {
    const names = [...src.matchAll(ICON_G())].map((m) => m[1]);
    warn(file, ext.includes('css') ? 'css-usage' : 'js-string', names.join(', '));
    continue;
  }

  const templateMatch = src.match(/<template>[\s\S]*<\/template>/);
  const scriptMatch = src.match(/<script\b[^>]*>[\s\S]*?<\/script>/);
  const usedIcons = new Set();
  let newSrc = src;

  if (templateMatch) {
    let tpl = templateMatch[0];
    // 只吃「纯图标 span」：自闭合或空内容
    const SPAN_RE = /<span\b([^>]*?)\bclass="([^"]*icon-\[lucide--[^"\]]+\][^"]*)"([^>]*?)(\/>|>\s*<\/span>)/g;
    tpl = tpl.replace(SPAN_RE, (full, pre, classValue, post) => {
      const s = splitIconClass(classValue);
      if (!s) return full;
      if (s.multi) { warn(file, 'multi-icon-span', full.trim()); return full; }
      const comp = toPascal(s.iconName);
      usedIcons.add(comp);
      const others = [pre.trim(), post.trim()].filter(Boolean).join(' ');
      convertedTags += 1;
      return `<${comp}${s.rest ? ` class="${s.rest}"` : ''}${others ? ` ${others}` : ''} />`;
    });
    if (ICON_T.test(tpl)) // 残留 = 动态绑定等复杂情况
      warn(file, 'template-manual', [...tpl.matchAll(ICON_G())].map((m) => m[1]).join(', '));
    newSrc = newSrc.replace(templateMatch[0], tpl);
  }

  if (scriptMatch && ICON_T.test(scriptMatch[0]))
    warn(file, 'js-string', [...scriptMatch[0].matchAll(ICON_G())].map((m) => m[1]).join(', '));

  if (usedIcons.size) newSrc = injectImports(newSrc, usedIcons, file);
  if (newSrc !== src) { changedFiles += 1; if (WRITE) writeFileSync(file, newSrc, 'utf8'); }
}

console.log(`根目录: ${ROOT} | 模式: ${WRITE ? '写入' : '预览(dry-run)'}`);
console.log(`转换图标标签: ${convertedTags} | 改动文件: ${changedFiles}\n`);
if (warnings.length) {
  console.log('⚠️ 需人工处理:');
  for (const w of warnings) console.log(`  [${w.kind}] ${w.file} -> ${w.snippet}`);
} else console.log('✓ 无需人工处理的残留。');
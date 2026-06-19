#!/usr/bin/env node
/**
 * 回滚 #27: codemirror-shiki-highlight.ts tokenInlineStyle CSS class 改动
 *
 * 已逐行核对 main 分支最新代码（commit c81909b），确保 find 精确匹配。
 * 把 tokenInlineStyle 从 CSS class 方案恢复为原始 inline style 方案。
 * 把 tokenDecoration 的 { class: style } 恢复为 { style }。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

let modified = false;

const filePath = join(__dirname, 'src', 'services', 'editor', 'codemirror-shiki-highlight.ts');

if (!existsSync(filePath)) {
  console.error('文件不存在: ' + filePath);
  process.exit(1);
}

let content = readFileSync(filePath, 'utf-8');

// ── 1. 回滚 tokenInlineStyle ──
// main 最新代码中 #27 改动后的 CSS class 版本（逐行核对 commit c81909b）
const classVersion = [
  'const tokenInlineStyle = (token: IShikiThemedToken): string => {',
  '  // 生成 CSS class 名而非内联 style：减少 DOM 属性体积。',
  '  const parts: string[] = [];',
  '  if (token.color) {',
  '    parts.push(`cm-shiki-c-${token.color.replace(/[^a-zA-Z0-9]/g, \'\')}`);',
  '  }',
  '  if (token.bgColor) {',
  '    parts.push(`cm-shiki-b-${token.bgColor.replace(/[^a-zA-Z0-9]/g, \'\')}`);',
  '  }',
  '  const fontStyle = token.fontStyle ?? 0;',
  '  if (fontStyle > 0) {',
  '    if ((fontStyle & FONT_STYLE_ITALIC) !== 0) {',
  "      parts.push('cm-shiki-i');",
  '    }',
  '    if ((fontStyle & FONT_STYLE_BOLD) !== 0) {',
  "      parts.push('cm-shiki-bold');",
  '    }',
  '    if ((fontStyle & FONT_STYLE_UNDERLINE) !== 0) {',
  "      parts.push('cm-shiki-u');",
  '    }',
  '  }',
  "  return parts.join(' ');",
  '};',
].join('\n');

// 原始 inline style 版本（回滚目标）
const originalVersion = [
  'const tokenInlineStyle = (token: IShikiThemedToken): string => {',
  '  const declarations: string[] = [];',
  '  if (token.color) {',
  '    declarations.push(`color:${token.color}`);',
  '  }',
  '  if (token.bgColor) {',
  '    declarations.push(`background-color:${token.bgColor}`);',
  '  }',
  '  const fontStyle = token.fontStyle ?? 0;',
  '  if (fontStyle > 0) {',
  '    if ((fontStyle & FONT_STYLE_ITALIC) !== 0) {',
  "      declarations.push('font-style:italic');",
  '    }',
  '    if ((fontStyle & FONT_STYLE_BOLD) !== 0) {',
  "      declarations.push('font-weight:600');",
  '    }',
  '    if ((fontStyle & FONT_STYLE_UNDERLINE) !== 0) {',
  "      declarations.push('text-decoration:underline');",
  '    }',
  '  }',
  "  return declarations.join(';');",
  '};',
].join('\n');

if (content.includes(classVersion)) {
  if (DRY_RUN) {
    console.log('[DRY-RUN] tokenInlineStyle: 将从 CSS class 版本回滚为 inline style 版本');
  } else {
    content = content.replace(classVersion, originalVersion);
    console.log('OK tokenInlineStyle: 已回滚为 inline style');
  }
  modified = true;
} else if (content.includes(originalVersion)) {
  console.log('SKIP tokenInlineStyle: 已经是原始 inline style 版本，无需回滚');
} else {
  console.log('SKIP tokenInlineStyle: 未找到 class 版本，可能已被其他方式修改或未应用 #27');
}

// ── 2. 回滚 tokenDecoration ──
// main 最新代码中是: Decoration.mark({ attributes: { class: style } });
const classDeco = '  const decoration = Decoration.mark({ attributes: { class: style } });';
const originalDeco = '  const decoration = Decoration.mark({ attributes: { style } });';

if (content.includes(classDeco)) {
  if (DRY_RUN) {
    console.log('[DRY-RUN] tokenDecoration: 将从 { class: style } 回滚为 { style }');
  } else {
    content = content.replace(classDeco, originalDeco);
    console.log('OK tokenDecoration: 已回滚为 { style }');
  }
  modified = true;
} else if (content.includes(originalDeco)) {
  console.log('SKIP tokenDecoration: 已经是原始 { style } 版本，无需回滚');
} else {
  console.log('SKIP tokenDecoration: 未找到 class 版本');
}

// 写回文件
if (modified && !DRY_RUN) {
  writeFileSync(filePath, content, 'utf-8');
  console.log('\n回滚完成。请运行: pnpm lint && pnpm typecheck');
} else if (DRY_RUN && modified) {
  console.log('\nDRY-RUN: 未写入文件。去掉 --dry-run 参数执行实际回滚。');
} else {
  console.log('\n无需回滚（#27 改动不存在或已是原始版本）。');
}
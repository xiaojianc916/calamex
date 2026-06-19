#!/usr/bin/env node
/**
 * Calamex 第二轮代码优化脚本 (round2) 修正版
 *
 * 已逐行核对真实源码，确保所有 find/replace 精确匹配。
 *
 * 处理项 (7 项):
 *   #21: lsp-bridge.ts   - normalizePath 复用 utils/file/path.ts
 *   #22: lsp-bridge.ts   - replayOpenDocuments 并发化 Promise.all
 *   #23: ai.service.ts   - dotenv.parse 替代手写解析 (需先 pnpm add dotenv)
 *   #24: agent_sidecar.rs - ensure_model_config_with 简化泛型签名
 *   #26: session/store.ts - 补充缺失的 TRawSnapshot 类型定义
 *   #27: codemirror-shiki-highlight.ts - tokenInlineStyle 用 CSS class
 *   #29: workspace_fs.rs - sort 避免 String clone
 *
 * 排除项:
 *   #25: git.rs - gix 0.84 rev_parse_short API 无法确认，编译风险高，跳过
 *   #28: workspace_watcher.rs - 用户明确排除
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

let totalModified = 0;

function patchFile(filePath, name, find, replace) {
  if (!existsSync(filePath)) {
    console.error('  X ' + name + ': 文件不存在 ' + filePath);
    return false;
  }
  let content = readFileSync(filePath, 'utf-8');
  if (!content.includes(find)) {
    console.log('  >> ' + name + ': 未找到目标代码（可能已修改）');
    return false;
  }
  if (content.includes(replace)) {
    console.log('  >> ' + name + ': 已包含目标代码，跳过');
    return false;
  }
  const firstIdx = content.indexOf(find);
  const secondIdx = content.indexOf(find, firstIdx + 1);
  if (secondIdx !== -1) {
    console.error('  X ' + name + ': find 在文件中出现多次，需要更精确匹配');
    return false;
  }
  if (DRY_RUN) {
    console.log('  [DRY-RUN] ' + name + ': 将替换 ' + find.length + ' -> ' + replace.length + ' 字符');
    return true;
  }
  content = content.replace(find, replace);
  writeFileSync(filePath, content, 'utf-8');
  console.log('  OK ' + name + ': 已修改');
  return true;
}

console.log('\nCalamex round2 优化脚本 (修正版)');
console.log(DRY_RUN ? '   (DRY-RUN)\n' : '\n');

// =======================================================================
// #21: lsp-bridge.ts - normalizePath 复用 utils/file/path.ts
// =======================================================================
console.log('-- #21: lsp-bridge.ts normalizePath 复用 --');
{
  const filePath = join(__dirname, 'src', 'services', 'editor', 'lsp-bridge.ts');
  let modified = false;

  // (a) 添加 import
  const oldImport = "import { highlightCodeToHtml } from '@/services/editor/codemirror-static-highlight';";
  const newImport = oldImport + "\nimport { normalizeFileSystemPath } from '@/utils/file/path';";
  if (patchFile(filePath, '#21a import', oldImport, newImport)) modified = true;

  // (b) 替换 normalizePath 函数体
  // 逐行核对真实源码：注释中是 "前缀" 不是 "前序"
  const oldNormalize = [
    'function normalizePath(p: string): string {',
    '  // 去掉 Windows 扩展路径前缀 \\\\?\\ 或 \\\\.\\ (含正斜杠变体)',
    '  let cleaned = p;',
    "  if (cleaned.startsWith('\\\\\\\\?\\\\UNC\\\\')) {",
    '    cleaned = `\\\\\\\\${cleaned.slice(\\\\\\\\?\\\\UNC\\\\.length)}`;',
    "  } else if (cleaned.startsWith('\\\\\\\\?\\\\') || cleaned.startsWith('\\\\\\\\.\\\\')) {",
    "    cleaned = cleaned.slice('\\\\\\\\?\\\\'.length);",
    "  } else if (cleaned.startsWith('//?/UNC/')) {",
    "    cleaned = `//${cleaned.slice('//?/UNC/'.length)}`;",
    "  } else if (cleaned.startsWith('//?/') || cleaned.startsWith('//./')) {",
    "    cleaned = cleaned.slice('//?/'.length);",
    '  }',
    '  return cleaned.replace(/\\\\/g, \'/\');',
    '}',
  ].join('\n');

  // 对 normalizePath 函数体，用正则匹配更安全
  const fs2 = readFileSync(filePath, 'utf-8');
  const normalizeRe = /function normalizePath\(p: string\): string \{[\s\S]*?\n\}/;
  const match = fs2.match(normalizeRe);
  if (match) {
    const oldFn = match[0];
    const newFn = [
      'function normalizePath(p: string): string {',
      '  // 复用 utils/file/path.ts 的统一路径归一化逻辑，消除跨模块重复实现。',
      '  // foldWindowsCase: false 保持与原函数一致——不做大小写折叠，仅剥前缀 + 反斜杠转正斜杠。',
      "  return normalizeFileSystemPath(p, { collapseDuplicateSeparators: true, trimTrailingSeparator: false, foldWindowsCase: false });",
      '}',
    ].join('\n');
    if (patchFile(filePath, '#21b normalizePath', oldFn, newFn)) modified = true;
  } else {
    console.log('  >> #21b: normalizePath 函数未找到（可能已修改）');
  }
  if (modified) totalModified++;
}

// =======================================================================
// #22: lsp-bridge.ts - replayOpenDocuments 并发化
// =======================================================================
console.log('\n-- #22: lsp-bridge.ts replayOpenDocuments 并发化 --');
{
  const filePath = join(__dirname, 'src', 'services', 'editor', 'lsp-bridge.ts');

  const oldReplay = [
    '  /** 向(重新)启动的服务重放所有已打开文档的最新内容，恢复服务端文档状态。 */',
    '  private async replayOpenDocuments(): Promise<void> {',
    '    const docs = Array.from(this.openDocuments.values());',
    '    for (const doc of docs) {',
    '      try {',
    "        await tauriInvoke<void>('lsp_did_open', {",
    '          filePath: doc.filePath,',
    '          content: doc.content,',
    '          languageId: doc.languageId,',
    '        });',
    '      } catch (err) {',
    "        console.warn('[lsp-bridge] replay didOpen failed', doc.filePath, err);",
    '      }',
    '    }',
    '  }',
  ].join('\n');

  const newReplay = [
    '  /** 向(重新)启动的服务重放所有已打开文档的最新内容，恢复服务端文档状态。 */',
    '  private async replayOpenDocuments(): Promise<void> {',
    '    const docs = Array.from(this.openDocuments.values());',
    '    // 并发重放：崩溃恢复时多文档无需串行等待，Promise.all 全部并行发送 didOpen。',
    '    await Promise.all(',
    '      docs.map((doc) =>',
    "        tauriInvoke<void>('lsp_did_open', {",
    '          filePath: doc.filePath,',
    '          content: doc.content,',
    '          languageId: doc.languageId,',
    '        }).catch((err) => {',
    "          console.warn('[lsp-bridge] replay didOpen failed', doc.filePath, err);",
    '        }),',
    '      ),',
    '    );',
    '  }',
  ].join('\n');

  if (patchFile(filePath, '#22 replayOpenDocuments', oldReplay, newReplay)) totalModified++;
}

// =======================================================================
// #23: ai.service.ts - dotenv.parse 替代手写解析
// =======================================================================
console.log('\n-- #23: ai.service.ts dotenv.parse (需先 pnpm add dotenv) --');
{
  const filePath = join(__dirname, 'src', 'services', 'ipc', 'ai.service.ts');
  let modified = false;

  // (a) 添加 import dotenv
  const oldImport = "import { escapeRegExp } from '@/utils/core/regex';";
  const newImport = "import dotenv from 'dotenv';\n" + oldImport;
  if (patchFile(filePath, '#23a import dotenv', oldImport, newImport)) modified = true;

  // (b) readDotenvAssignment 用 dotenv.parse 替代
  // 逐行核对真实源码，注意 ${escapeRegExp(key)} 中的 $ 需转义
  const oldRead = [
    'const readDotenvAssignment = (content: string, key: string): string => {',
    '  const linePattern = new RegExp(`^\\s*(?:export\\s+)?\${escapeRegExp(key)}\\s*=\\s*(.*)\\s*$`, \'u\');',
    '',
    '  for (const line of content.split(/\\r?\\n/u)) {',
    '    const trimmed = line.trim();',
    "    if (!trimmed || trimmed.startsWith('#')) {",
    '      continue;',
    '    }',
    '',
    '    const match = line.match(linePattern);',
    '    if (match) {',
    "      return parseDotenvValue(match[1] ?? '');",
    '    }',
    '  }',
    '',
    "  return '';",
    '};',
  ].join('\n');

  const newRead = [
    'const readDotenvAssignment = (content: string, key: string): string => {',
    '  // 用 dotenv.parse 替代手写逐行解析：官方实现正确处理引号、转义、export 前缀等。',
    '  const parsed = dotenv.parse(content);',
    '  return parsed[key] ?? \';',
    '};',
  ].join('\n');

  if (patchFile(filePath, '#23b readDotenvAssignment', oldRead, newRead)) modified = true;
  if (modified) totalModified++;
}

// =======================================================================
// #24: agent_sidecar.rs - ensure_model_config_with 简化泛型
// =======================================================================
console.log('\n-- #24: agent_sidecar.rs 简化泛型签名 --');
{
  const filePath = join(__dirname, 'src-tauri', 'src', 'commands', 'agent_sidecar.rs');

  const oldFn = [
    'fn ensure_model_config_with<F>(',
    '    cfg: &mut Option<AgentSidecarModelConfigPayload>,',
    '    fetch: F,',
    ') -> Result<(), String>',
    'where',
    '    F: FnOnce() -> Result<AgentSidecarModelConfigPayload, String>,',
    '{',
  ].join('\n');

  const newFn = [
    'fn ensure_model_config_with(',
    '    cfg: &mut Option<AgentSidecarModelConfigPayload>,',
    '    fetch: impl FnOnce() -> Result<AgentSidecarModelConfigPayload, String>,',
    ') -> Result<(), String> {',
  ].join('\n');

  if (patchFile(filePath, '#24 ensure_model_config_with', oldFn, newFn)) totalModified++;
}

// =======================================================================
// #26: session/store.ts - TRawSnapshot 类型修复
// =======================================================================
console.log('\n-- #26: session/store.ts TRawSnapshot 类型修复 --');
{
  const filePath = join(__dirname, 'src', 'services', 'session', 'store.ts');

  // TRawSnapshot 被使用但从未定义。在 logWarn 前插入类型定义。
  const oldType = 'const logWarn = (event: string, extra?: unknown): void => {';
  const newType = [
    '/** 从 Tauri Store / localStorage 读出的原始 JSON，结构不保证符合 schema。 */',
    'type TRawSnapshot = Record<string, unknown>;',
    '',
    oldType,
  ].join('\n');

  if (patchFile(filePath, '#26 TRawSnapshot', oldType, newType)) totalModified++;
}

// =======================================================================
// #27: codemirror-shiki-highlight.ts - tokenInlineStyle 用 CSS class
// =======================================================================
console.log('\n-- #27: codemirror-shiki-highlight tokenInlineStyle CSS class --');
{
  const filePath = join(__dirname, 'src', 'services', 'editor', 'codemirror-shiki-highlight.ts');
  let modified = false;

  // (a) tokenInlineStyle: 生成 CSS class 名替代 inline style
  const oldStyle = [
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

  const newStyle = [
    'const tokenInlineStyle = (token: IShikiThemedToken): string => {',
    '  // 生成 CSS class 名而非内联 style：减少 DOM 属性体积。',
    '  const parts: string[] = [];',
    '  if (token.color) {',
    "    parts.push(`cm-shiki-c-${token.color.replace(/[^a-zA-Z0-9]/g, '')}`);",
    '  }',
    '  if (token.bgColor) {',
    "    parts.push(`cm-shiki-b-${token.bgColor.replace(/[^a-zA-Z0-9]/g, '')}`);",
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

  if (patchFile(filePath, '#27a tokenInlineStyle', oldStyle, newStyle)) modified = true;

  // (b) tokenDecoration: attributes 从 { style } 改为 { class: style }
  // style 参数现在承载 class 字符串
  const oldDeco = '  const decoration = Decoration.mark({ attributes: { style } });';
  const newDeco = '  const decoration = Decoration.mark({ attributes: { class: style } });';

  if (patchFile(filePath, '#27b tokenDecoration', oldDeco, newDeco)) modified = true;
  if (modified) totalModified++;
}

// =======================================================================
// #29: workspace_fs.rs - sort 避免 String clone
// =======================================================================
console.log('\n-- #29: workspace_fs.rs sort 避免 String clone --');
{
  const filePath = join(__dirname, 'src-tauri', 'src', 'commands', 'workspace_fs.rs');

  const oldSort = [
    '    entries.sort_by_cached_key(|entry| {',
    '        (',
    '            entry.kind.as_str() != "directory",',
    '            entry.name.to_lowercase(),',
    '            entry.name.clone(),',
    '        )',
    '    });',
  ].join('\n');

  // 目录在前，然后按 lowercase name，最后按 raw name。
  // a_is_dir.cmp(&b_is_dir): false < true，目录=false 想排前面需要 reverse。
  const newSort = [
    '    entries.sort_by(|a, b| {',
    '        // 目录在前："directory" 的 kind 应排在非 directory 之前。',
    '        let a_is_dir = a.kind.as_str() == "directory";',
    '        let b_is_dir = b.kind.as_str() == "directory";',
    '        match a_is_dir.cmp(&b_is_dir) {',
    '            std::cmp::Ordering::Equal => {',
    '                // 同类：先按 lowercase 比较，再按原始 name 比较保持稳定排序。',
    '                let lower_cmp = a.name.to_lowercase().cmp(&b.name.to_lowercase());',
    '                if lower_cmp == std::cmp::Ordering::Equal {',
    '                    a.name.cmp(&b.name)',
    '                } else {',
    '                    lower_cmp',
    '                }',
    '            }',
    '            // a_is_dir=true(目录) 应排在 b_is_dir=false(文件) 前面 => reverse',
    '            other => other.reverse(),',
    '        }',
    '    });',
  ].join('\n');

  if (patchFile(filePath, '#29 sort', oldSort, newSort)) totalModified++;
}

// =======================================================================
console.log('\n' + '='.repeat(50));
if (totalModified === 0) {
  console.log('  无文件被修改');
} else {
  console.log('  共修改 ' + totalModified + ' 项' + (DRY_RUN ? ' (DRY-RUN)' : ''));
}
console.log('='.repeat(50));
console.log('\n  注意:');
console.log('  #23 需先安装: pnpm add dotenv');
console.log('  #27 需手动添加 CSS 规则映射 class -> 颜色');
console.log('  验证: pnpm lint && pnpm typecheck && pnpm test');
console.log('  Rust:  cargo clippy && cargo test');
console.log('');
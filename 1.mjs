// fix-batch3.mjs
// 第三批代码审查修复脚本（#23 ~ #31）
// 用法: node fix-batch3.mjs
// 幂等：可重复运行，不会重复追加

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const readFile = (rel) => {
  if (!existsSync(rel)) { console.warn('⚠ 文件不存在: ' + rel); return null; }
  return readFileSync(rel, 'utf-8');
};

const writeFile = (rel, content) => {
  writeFileSync(rel, content, 'utf-8');
  console.log('✅ 已修改: ' + rel);
};

const replaceInFile = (rel, oldStr, newStr) => {
  let content = readFile(rel);
  if (content === null) return false;
  if (!content.includes(oldStr)) {
    console.warn('⚠ 未找到匹配: ' + rel + '\n   首行: ' + oldStr.split('\n')[0]);
    return false;
  }
  content = content.replace(oldStr, newStr);
  writeFile(rel, content);
  return true;
};

// ---------------------------------------------------------------------------
// #23 file-assets.ts: getFileExtension 改用 getPathBaseName + lastIndexOf
// ---------------------------------------------------------------------------
function fix23() {
  console.log('\n--- #23 file-assets.ts getFileExtension ---');
  const f = 'src/utils/file/file-assets.ts';
  let content = readFile(f);
  if (!content) return;

  // 确保有 getPathBaseName 的 import（如果没有则添加）
  if (!content.includes('getPathBaseName')) {
    content = content.replace(
      "import { normalizeFileSystemPath } from '@/utils/file/path';",
      "import { getPathBaseName } from '@/utils/file/path';"
    );
  }

  // 替换 getFileExtension
  const oldFn = [
    'const getFileExtension = (path: string | null | undefined): string => {',
    '  if (!path) {',
    '    return \'\';',
    '  }',
    '',
    '  const normalizedPath = normalizeFileSystemPath(path);',
    '  const extension = normalizedPath.split(\'.\').pop();',
    '  return extension ? extension.toLowerCase() : \'\';',
    '};',
  ].join('\n');

  const newFn = [
    '/**',
    ' * 从路径中提取文件扩展名（小写）。',
    ' * 使用 getPathBaseName 取末段，避免对整条路径做规范化；',
    ' * 用 lastIndexOf 正确处理多段扩展名（如 .tar.gz 只取 gz）。',
    ' */',
    'const getFileExtension = (path: string | null | undefined): string => {',
    '  if (!path) {',
    '    return \'\';',
    '  }',
    '',
    '  const baseName = getPathBaseName(path);',
    '  const dotIndex = baseName.lastIndexOf(\'.\');',
    '  // dotIndex <= 0: 无扩展名或隐藏文件（如 .bashrc）',
    '  if (dotIndex <= 0) {',
    '    return \'\';',
    '  }',
    '  return baseName.slice(dotIndex + 1).toLowerCase();',
    '};',
  ].join('\n');

  if (content.includes(oldFn)) {
    content = content.replace(oldFn, newFn);
    writeFile(f, content);
  } else {
    console.warn('⚠ #23: getFileExtension 函数体未找到匹配');
  }
}

// ---------------------------------------------------------------------------
// #24 file-assets.ts: formatBytes 改用级联 log(1024)
// ---------------------------------------------------------------------------
function fix24() {
  console.log('\n--- #24 file-assets.ts formatBytes ---');
  const f = 'src/utils/file/file-assets.ts';
  let content = readFile(f);
  if (!content) return;

  // 检查是否已被替换（幂等）
  if (content.includes('BYTE_UNITS')) {
    console.log('   #24 已修复，跳过');
    return;
  }

  const oldFn = [
    'export const formatBytes = (value: number): string => {',
    '  if (!Number.isFinite(value) || value <= 0) {',
    '    return \'0 B\';',
    '  }',
    '',
    '  if (value < 1024) {',
    '    return `${value} B`;',
    '  }',
    '',
    '  if (value < 1024 * 1024) {',
    '    return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;',
    '  }',
    '',
    '  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;',
    '};',
  ].join('\n');

  const newFn = [
    'const BYTE_UNITS = [\'B\', \'KB\', \'MB\', \'GB\', \'TB\', \'PB\'] as const;',
    '',
    '/**',
    ' * 将字节数格式化为人类可读的字符串，按 1024 级联覆盖 B ~ PB。',
    ' * 精度规则：scaled < 10 时保留 1 位小数，否则取整。',
    ' */',
    'export const formatBytes = (value: number): string => {',
    '  if (!Number.isFinite(value) || value <= 0) {',
    '    return \'0 B\';',
    '  }',
    '',
    '  const exponent = Math.min(',
    '    Math.floor(Math.log(value) / Math.log(1024)),',
    '    BYTE_UNITS.length - 1,',
    '  );',
    '  const scaled = value / 1024 ** exponent;',
    '  return `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${BYTE_UNITS[exponent]}`;',
    '};',
  ].join('\n');

  if (content.includes(oldFn)) {
    content = content.replace(oldFn, newFn);
    writeFile(f, content);
  } else {
    console.warn('⚠ #24: formatBytes 函数体未找到匹配');
  }
}

// ---------------------------------------------------------------------------
// #25 ssh-file-preview.ts: LANGUAGE_BY_EXTENSION 迁到 codemirror-language.ts
// ---------------------------------------------------------------------------
function fix25() {
  console.log('\n--- #25 LANGUAGE_BY_EXTENSION 迁移 ---');
  const targetFile = 'src/services/editor/codemirror-language.ts';
  const sourceFile = 'src/utils/file/ssh-file-preview.ts';

  // 1. 在 codemirror-language.ts 末尾添加映射表
  let target = readFile(targetFile);
  if (target === null) {
    console.warn('⚠ #25: ' + targetFile + ' 不存在，跳过迁移');
    return;
  }

  if (target.includes('FILE_LANGUAGE_BY_EXTENSION')) {
    console.log('   #25 映射表已存在于 ' + targetFile + '，跳过');
  } else {
    const langMap = [
      '',
      '/**',
      ' * 文件扩展名 → CodeMirror 语言 ID 映射。',
      ' * 由 ssh-file-preview.ts 和其他需要文件类型推断的模块共用。',
      ' */',
      'export const FILE_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {',
      "  bash: 'bash',",
      "  bat: 'bat',",
      "  c: 'c',",
      "  cc: 'cpp',",
      "  cpp: 'cpp',",
      "  css: 'css',",
      "  cts: 'typescript',",
      "  cxx: 'cpp',",
      "  dockerfile: 'dockerfile',",
      "  go: 'go',",
      "  h: 'c',",
      "  hpp: 'cpp',",
      "  htm: 'html',",
      "  html: 'html',",
      "  ini: 'ini',",
      "  java: 'java',",
      "  js: 'javascript',",
      "  json: 'json',",
      "  jsonc: 'jsonc',",
      "  jsx: 'jsx',",
      "  less: 'less',",
      "  log: 'text',",
      "  md: 'markdown',",
      "  mts: 'typescript',",
      "  ps1: 'powershell',",
      "  py: 'python',",
      "  rb: 'ruby',",
      "  rs: 'rust',",
      "  scss: 'scss',",
      "  sh: 'bash',",
      "  sql: 'sql',",
      "  svg: 'svg',",
      "  toml: 'toml',",
      "  ts: 'typescript',",
      "  tsx: 'tsx',",
      "  txt: 'text',",
      "  vue: 'vue',",
      "  xml: 'xml',",
      "  yaml: 'yaml',",
      "  yml: 'yaml',",
      "  zsh: 'bash',",
      '};',
      '',
    ].join('\n');

    target = target.trimEnd() + '\n' + langMap;
    writeFile(targetFile, target);
  }

  // 2. 在 ssh-file-preview.ts 中删除本地映射表，改用 import
  let source = readFile(sourceFile);
  if (source === null) return;

  // 检查是否已经 import
  if (source.includes('FILE_LANGUAGE_BY_EXTENSION')) {
    console.log('   #25 ' + sourceFile + ' 已完成迁移，跳过');
    return;
  }

  // 删除本地 LANGUAGE_BY_EXTENSION 定义
  const oldMapStart = 'const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {';
  const oldMapEnd = "  zsh: 'bash',\n};\n";

  const mapStartIdx = source.indexOf(oldMapStart);
  if (mapStartIdx === -1) {
    console.warn('⚠ #25: 在 ' + sourceFile + ' 中未找到 LANGUAGE_BY_EXTENSION');
    return;
  }

  const mapEndIdx = source.indexOf(oldMapEnd, mapStartIdx);
  if (mapEndIdx === -1) {
    console.warn('⚠ #25: 在 ' + sourceFile + ' 中未找到映射表结束位置');
    return;
  }

  // 删除整段映射表
  const beforeMap = source.slice(0, mapStartIdx);
  const afterMap = source.slice(mapEndIdx + oldMapEnd.length);
  source = beforeMap + afterMap;

  // 在 import 块中添加 FILE_LANGUAGE_BY_EXTENSION 的 import
  source = source.replace(
    "import {\n  CODEMIRROR_LANGUAGE_LABELS,\n  resolveCodeMirrorLanguageId,\n} from '@/services/editor/codemirror-language';",
    "import {\n  CODEMIRROR_LANGUAGE_LABELS,\n  FILE_LANGUAGE_BY_EXTENSION,\n  resolveCodeMirrorLanguageId,\n} from '@/services/editor/codemirror-language';"
  );

  // 替换使用处 LANGUAGE_BY_EXTENSION → FILE_LANGUAGE_BY_EXTENSION
  source = source.replace(/LANGUAGE_BY_EXTENSION\[/g, 'FILE_LANGUAGE_BY_EXTENSION[');

  writeFile(sourceFile, source);
}

// ---------------------------------------------------------------------------
// #26 ssh-file-preview.ts: countSshPreviewLines 复用 computeDocumentMetrics
// ---------------------------------------------------------------------------
function fix26() {
  console.log('\n--- #26 countSshPreviewLines 复用 computeDocumentMetrics ---');
  const f = 'src/utils/file/ssh-file-preview.ts';
  let content = readFile(f);
  if (!content) return;

  if (content.includes('computeDocumentMetrics')) {
    console.log('   #26 已修复，跳过');
    return;
  }

  // 添加 import
  content = content.replace(
    "import { splitTextGraphemes } from '@/utils/file/text-preview';",
    "import { computeDocumentMetrics } from '@/utils/editor/document-metrics';\nimport { splitTextGraphemes } from '@/utils/file/text-preview';"
  );

  // 替换 countSshPreviewLines
  const oldFn = [
    'export const countSshPreviewLines = (value: string): number =>',
    '  value.length === 0 ? 1 : normalizeSshPreviewContent(value).split(\'\\n\').length;',
  ].join('\n');

  const newFn = [
    'export const countSshPreviewLines = (value: string): number =>',
    '  computeDocumentMetrics(normalizeSshPreviewContent(value)).lineCount;',
  ].join('\n');

  if (content.includes(oldFn)) {
    content = content.replace(oldFn, newFn);
    writeFile(f, content);
  } else {
    console.warn('⚠ #26: countSshPreviewLines 函数体未找到匹配');
  }
}

// ---------------------------------------------------------------------------
// #27 提取共享 performanceMs 到 utils/core/perf.ts
//    runtime-diagnostics.ts 和 startup-profiler.ts 各自引用
// ---------------------------------------------------------------------------
function fix27() {
  console.log('\n--- #27 提取共享 performanceMs ---');

  // 1. 创建 utils/core/perf.ts
  const perfFile = 'src/utils/core/perf.ts';
  let perfContent = readFile(perfFile);
  if (perfContent !== null) {
    console.log('   #27 ' + perfFile + ' 已存在，跳过创建');
  } else {
    writeFile(perfFile, [
      '/**',
      ' * 高精度时间戳辅助（performance.now 优先，回退 Date.now）。',
      ' * 统一 runtime-diagnostics.ts、startup-profiler.ts 等处的 performance 检测逻辑。',
      ' */',
      '',
      'export const performanceMs = (): number =>',
      '  typeof performance !== \'undefined\' && typeof performance.now === \'function\'',
      '    ? performance.now()',
      '    : Date.now();',
      '',
    ].join('\n'));
  }

  // 2. runtime-diagnostics.ts: 用 performanceMs 替换本地 nowMs
  const rdFile = 'src/utils/platform/runtime-diagnostics.ts';
  let rd = readFile(rdFile);
  if (rd !== null && !rd.includes('performanceMs')) {
    // 添加 import
    rd = rd.replace(
      "import { toErrorMessage } from '@/utils/error/error';",
      "import { performanceMs } from '@/utils/core/perf';\nimport { toErrorMessage } from '@/utils/error/error';"
    );

    // 替换 nowMs 定义
    const oldNowMs = [
      'const nowMs = (): number =>',
      '  typeof performance !== \'undefined\' && typeof performance.now === \'function\'',
      '    ? Math.round(performance.now())',
      '    : Date.now();',
    ].join('\n');

    const newNowMs = [
      'const nowMs = (): number => Math.round(performanceMs());',
    ].join('\n');

    if (rd.includes(oldNowMs)) {
      rd = rd.replace(oldNowMs, newNowMs);
      writeFile(rdFile, rd);
    } else {
      console.warn('⚠ #27: runtime-diagnostics.ts nowMs 未找到匹配');
    }
  } else if (rd !== null) {
    console.log('   #27 runtime-diagnostics.ts 已修复，跳过');
  }

  // 3. startup-profiler.ts: 不替换 roundDuration（精度语义不同），
  //    但在 hasPerformanceMark 旁添加注释指向 perf.ts
  const spFile = 'src/utils/platform/startup-profiler.ts';
  let sp = readFile(spFile);
  if (sp !== null && !sp.includes('perf.ts')) {
    const oldMark = [
      'const hasPerformanceMark = (): boolean =>',
      '  typeof performance !== \'undefined\' && typeof performance.mark === \'function\';',
    ].join('\n');

    const newMark = [
      '// performance.now 的 fallback 检测已统一到 utils/core/perf.ts 的 performanceMs()。',
      '// 此处仍需检测 performance.mark（而非 performance.now），故保留本地检查。',
      'const hasPerformanceMark = (): boolean =>',
      '  typeof performance !== \'undefined\' && typeof performance.mark === \'function\';',
    ].join('\n');

    if (sp.includes(oldMark)) {
      sp = sp.replace(oldMark, newMark);
      writeFile(spFile, sp);
    } else {
      console.warn('⚠ #27: startup-profiler.ts hasPerformanceMark 未找到匹配');
    }
  } else if (sp !== null) {
    console.log('   #27 startup-profiler.ts 已修复，跳过');
  }
}

// ---------------------------------------------------------------------------
// #28 file-assets.ts IMAGE_EXTENSIONS 添加注释指向 file-icons.ts
// ---------------------------------------------------------------------------
function fix28() {
  console.log('\n--- #28 IMAGE_EXTENSIONS 添加交叉引用注释 ---');
  const f = 'src/utils/file/file-assets.ts';
  let content = readFile(f);
  if (!content) return;

  if (content.includes('file-icons.ts')) {
    console.log('   #28 已修复，跳过');
    return;
  }

  const old = "const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);";
  const replacement = [
    '// 注意：如需扩展图片格式，请同步更新 file-icons.ts 中的 Pierre 主题 fileExtensions 映射。',
    '// 长期计划：将文件类型分类（isImageAssetPath / isShellScriptPath）抽取到',
    '// utils/file/file-classification.ts 作为唯一入口，图标系统只管「类型→图标」。',
    "const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);",
  ].join('\n');

  if (content.includes(old)) {
    content = content.replace(old, replacement);
    writeFile(f, content);
  } else {
    console.warn('⚠ #28: IMAGE_EXTENSIONS 未找到匹配');
  }
}

// ---------------------------------------------------------------------------
// #29 workspace.ts 和 ssh-file-preview.ts normalize 函数添加交叉引用
// ---------------------------------------------------------------------------
function fix29() {
  console.log('\n--- #29 normalize 函数交叉引用 ---');

  // workspace.ts
  const wsFile = 'src/utils/file/workspace.ts';
  let ws = readFile(wsFile);
  if (ws !== null && !ws.includes('ssh-file-preview.ts')) {
    const old = 'const normalizeWorkspaceQuery = (value: string): string => value.trim().toLocaleLowerCase();';
    const replacement = [
      '// 注意：ssh-file-preview.ts 的 normalizeSearchGrapheme 做了更完整的 NFC + locale 归一化。',
      '// 如果未来搜索场景需要统一，考虑将这两处合并到 utils/file/text/normalize.ts。',
      'const normalizeWorkspaceQuery = (value: string): string => value.trim().toLocaleLowerCase();',
    ].join('\n');

    if (ws.includes(old)) {
      ws = ws.replace(old, replacement);
      writeFile(wsFile, ws);
    } else {
      console.warn('⚠ #29: workspace.ts normalizeWorkspaceQuery 未找到匹配');
    }
  } else if (ws !== null) {
    console.log('   #29 workspace.ts 已修复，跳过');
  }

  // ssh-file-preview.ts
  const sshFile = 'src/utils/file/ssh-file-preview.ts';
  let ssh = readFile(sshFile);
  if (ssh !== null && !ssh.includes('workspace.ts') && ssh.includes('normalizeSearchGrapheme')) {
    const old = "const normalizeSearchGrapheme = (value: string): string =>\n  value.normalize('NFC').toLocaleLowerCase('zh-CN');";
    const replacement = [
      '// 注意：workspace.ts 的 normalizeWorkspaceQuery 仅做 trim + toLocaleLowerCase（无 NFC）。',
      '// 两处语义不同（搜索图素 vs 工作区查询），如需统一请抽到 utils/file/text/normalize.ts。',
      "const normalizeSearchGrapheme = (value: string): string =>",
      "  value.normalize('NFC').toLocaleLowerCase('zh-CN');",
    ].join('\n');

    if (ssh.includes(old)) {
      ssh = ssh.replace(old, replacement);
      writeFile(sshFile, ssh);
    } else {
      console.warn('⚠ #29: ssh-file-preview.ts normalizeSearchGrapheme 未找到匹配');
    }
  } else if (ssh !== null) {
    console.log('   #29 ssh-file-preview.ts 已修复，跳过');
  }
}

// ---------------------------------------------------------------------------
// #30 提取共享 skipSurrogatePair 工具函数到 utils/core/surrogate.ts
// ---------------------------------------------------------------------------
function fix30() {
  console.log('\n--- #30 提取共享 surrogate pair 检测 ---');

  // 1. 创建 utils/core/surrogate.ts
  const surrFile = 'src/utils/core/surrogate.ts';
  let surr = readFile(surrFile);
  if (surr !== null) {
    console.log('   #30 ' + surrFile + ' 已存在，跳过创建');
  } else {
    writeFile(surrFile, [
      '/**',
      ' * UTF-16 代理对检测与跳过辅助。',
      ' *',
      ' * 多处代码（document-metrics.ts、agent-sidecar/text-metrics.ts、',
      ' * terminal-output-buffer.ts）各自手写了相同的 charCodeAt + surrogate range check。',
      ' * 此处提供共享实现，消除重复。',
      ' */',
      '',
      '/**',
      ' * 检查指定位置是否是高位代理项（high surrogate, 0xD800..0xDBFF）。',
      ' * 如果是且下一个 code unit 是低位代理项，返回 true（表示应跳过下一个 unit）。',
      ' */',
      'export const isHighSurrogateAt = (value: string, index: number): boolean => {',
      '  const code = value.charCodeAt(index);',
      '  return code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&',
      '    value.charCodeAt(index + 1) >= 0xdc00 &&',
      '    value.charCodeAt(index + 1) <= 0xdfff;',
      '};',
      '',
      '/**',
      ' * 检查指定位置是否是低位代理项（low surrogate, 0xDC00..0xDFFF）。',
      ' * 用于在截断点检测不完整的代理对（如 terminal-output-buffer 的 trimLeadingCodeUnitBoundary）。',
      ' */',
      'export const isLowSurrogateAt = (value: string, index: number): boolean => {',
      '  if (index >= value.length) return false;',
      '  const code = value.charCodeAt(index);',
      '  return code >= 0xdc00 && code <= 0xdfff;',
      '};',
      '',
      '/**',
      ' * 如果 index 处是一个完整的代理对，返回 2（跳过低位代理）；否则返回 1。',
      ' * 用于 charCodeAt 遍历中的 index 前进。',
      ' */',
      'export const surrogatePairStep = (value: string, index: number): 1 | 2 =>',
      '  isHighSurrogateAt(value, index) ? 2 : 1;',
      '',
    ].join('\n'));
  }

  // 2. document-metrics.ts: 用 isHighSurrogateAt 替换内联检测
  const dmFile = 'src/utils/editor/document-metrics.ts';
  let dm = readFile(dmFile);
  if (dm !== null && !dm.includes('surrogate')) {
    // 添加 import
    dm = dm.replace(
      "export interface IDocumentMetrics {",
      "import { isHighSurrogateAt } from '@/utils/core/surrogate';\n\nexport interface IDocumentMetrics {"
    );

    // 替换内联代理对检测
    const oldCheck = [
      '    // 高位代理项 + 紧随其后的低位代理项 → 合并为一个码点，跳过下一个 code unit',
      '    if (code >= 0xd800 && code <= 0xdbff && index + 1 < length) {',
      '      const nextCode = content.charCodeAt(index + 1);',
      '      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {',
      '        index += 1;',
      '      }',
      '    }',
    ].join('\n');

    const newCheck = [
      '    // 高位代理项 + 紧随其后的低位代理项 → 合并为一个码点，跳过下一个 code unit',
      '    if (isHighSurrogateAt(content, index)) {',
      '      index += 1;',
      '    }',
    ].join('\n');

    if (dm.includes(oldCheck)) {
      dm = dm.replace(oldCheck, newCheck);
      writeFile(dmFile, dm);
    } else {
      console.warn('⚠ #30: document-metrics.ts 代理对检测未找到匹配');
    }
  } else if (dm !== null) {
    console.log('   #30 document-metrics.ts 已修复，跳过');
  }

  // 3. terminal-output-buffer.ts: 用 isLowSurrogateAt 替换内联检测
  const tobFile = 'src/utils/terminal/terminal-output-buffer.ts';
  let tob = readFile(tobFile);
  if (tob !== null && !tob.includes('surrogate')) {
    // 添加 import
    tob = tob.replace(
      "export type TTerminalOutputBufferOptions = {",
      "import { isLowSurrogateAt } from '@/utils/core/surrogate';\n\nexport type TTerminalOutputBufferOptions = {"
    );

    // 替换内联检测
    const oldCheck = [
      '  const firstCode = sliced.charCodeAt(0);',
      '  if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {',
      '    sliced = sliced.slice(1);',
      '  }',
    ].join('\n');

    const newCheck = [
      '  if (isLowSurrogateAt(sliced, 0)) {',
      '    sliced = sliced.slice(1);',
      '  }',
    ].join('\n');

    if (tob.includes(oldCheck)) {
      tob = tob.replace(oldCheck, newCheck);
      writeFile(tobFile, tob);
    } else {
      console.warn('⚠ #30: terminal-output-buffer.ts 代理对检测未找到匹配');
    }
  } else if (tob !== null) {
    console.log('   #30 terminal-output-buffer.ts 已修复，跳过');
  }

  // 4. agent-sidecar/src/text-metrics.ts: 添加注释指向 surrogate.ts
  const tmFile = 'agent-sidecar/src/text-metrics.ts';
  let tm = readFile(tmFile);
  if (tm !== null && !tm.includes('surrogate.ts') && tm.includes('countTextChars')) {
    const oldComment = [
      '/**',
      ' * Shared character/token measurement helpers.',
    ].join('\n');

    const newComment = [
      '/**',
      ' * Shared character/token measurement helpers.',
      ' *',
      ' * 注意：前端 utils/core/surrogate.ts 提供了共享的 isHighSurrogateAt 工具函数。',
      ' * agent-sidecar 作为独立进程不 import 前端模块，故此处保留内联实现。',
      ' * 如有变更请同步更新 surrogate.ts 和 document-metrics.ts。',
    ].join('\n');

    if (tm.includes(oldComment)) {
      tm = tm.replace(oldComment, newComment);
      writeFile(tmFile, tm);
    } else {
      console.warn('⚠ #30: text-metrics.ts 注释未找到匹配');
    }
  } else if (tm !== null) {
    console.log('   #30 text-metrics.ts 已修复，跳过');
  }
}

// ---------------------------------------------------------------------------
// #31 shell_tools.rs 和 ssh-file-preview.ts 跨语言交叉引用注释
// ---------------------------------------------------------------------------
function fix31() {
  console.log('\n--- #31 跨语言行结束符归一化交叉引用 ---');

  // Rust 侧
  const rsFile = 'src-tauri/src/commands/shell_tools.rs';
  let rs = readFile(rsFile);
  if (rs !== null && !rs.includes('ssh-file-preview.ts')) {
    const old = 'fn normalize_shellcheck_content(content: &str) -> String {\n    content.replace("\\r\\n", "\\n").replace(\'\\r\', "\\n")\n}';
    const replacement = [
      '/// 行结束符归一化：将 CRLF 和 lone CR 统一为 LF。',
      '/// 跨语言约定：TS 侧 src/utils/file/ssh-file-preview.ts 的 normalizeSshPreviewContent',
     '/// 做完全相同的操作，修改时请同步两端。',
      'fn normalize_shellcheck_content(content: &str) -> String {',
      '    content.replace("\\r\\n", "\\n").replace(\'\\r\', "\\n")',
      '}',
    ].join('\n');

    if (rs.includes(old)) {
      rs = rs.replace(old, replacement);
      writeFile(rsFile, rs);
    } else {
      console.warn('⚠ #31: shell_tools.rs normalize_shellcheck_content 未找到匹配');
    }
  } else if (rs !== null) {
    console.log('   #31 shell_tools.rs 已修复，跳过');
  }

  // TS 侧
  const tsFile = 'src/utils/file/ssh-file-preview.ts';
  let ts = readFile(tsFile);
  if (ts !== null && !ts.includes('shell_tools.rs') && ts.includes('normalizeSshPreviewContent')) {
    const old = [
      'export const normalizeSshPreviewContent = (value: string): string =>',
      "  value.replace(/\\r\\n/gu, '\\n').replace(/\\r/gu, '\\n');",
    ].join('\n');

    const replacement = [
      '/**',
      ' * 行结束符归一化：将 CRLF 和 lone CR 统一为 LF。',
      ' * 跨语言约定：Rust 侧 src-tauri/src/commands/shell_tools.rs 的',
      ' * normalize_shellcheck_content 做完全相同的操作，修改时请同步两端。',
      ' */',
      'export const normalizeSshPreviewContent = (value: string): string =>',
      "  value.replace(/\\r\\n/gu, '\\n').replace(/\\r/gu, '\\n');",
    ].join('\n');

    if (ts.includes(old)) {
      ts = ts.replace(old, replacement);
      writeFile(tsFile, ts);
    } else {
      console.warn('⚠ #31: ssh-file-preview.ts normalizeSshPreviewContent 未找到匹配');
    }
  } else if (ts !== null) {
    console.log('   #31 ssh-file-preview.ts 已修复，跳过');
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
const fixes = [
  fix23, fix24, fix25, fix26,
  fix27, fix28, fix29,
  fix30, fix31,
];

console.log('🔧 开始执行代码审查修复脚本（第三批）...\n');

let success = 0;
let failed = 0;
for (let i = 0; i < fixes.length; i++) {
  try {
    fixes[i]();
    success++;
  } catch (err) {
    console.error('❌ 修复 #' + (i + 23) + ' 失败:', err);
    failed++;
  }
}

console.log('\n--- 完成: ' + success + ' 项成功, ' + failed + ' 项失败 ---');
console.log('\n⚠️ 改完后请运行:');
console.log('   npx biome check --write');
console.log('   cd src-tauri && cargo check\n');
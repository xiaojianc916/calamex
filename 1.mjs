// fix-batch4.mjs — 第四批代码审查修复（#32~#40）
// 用法: node fix-batch4.mjs  |  幂等可重复运行
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const readFile = (rel) => {
  if (!existsSync(rel)) { console.warn('⚠ 文件不存在: ' + rel); return null; }
  return readFileSync(rel, 'utf-8');
};
const writeFile = (rel, content) => {
  writeFileSync(rel, content, 'utf-8');
  console.log('✅ 已修改: ' + rel);
};

// ---------------------------------------------------------------------------
// #32 useSidecarChangedDocumentRefresh.ts: 复用 path.ts 的 joinFileSystemPath
// ---------------------------------------------------------------------------
function fix32() {
  console.log('\n--- #32 useSidecarChangedDocumentRefresh.ts 路径函数复用 ---');
  const f = 'src/composables/useSidecarChangedDocumentRefresh.ts';
  let content = readFile(f);
  if (!content) return;

  if (content.includes("from '@/utils/file/path'") && content.includes('joinFileSystemPath')) {
    console.log('   #32 已修复，跳过');
    return;
  }

  // 1. 替换 import — 添加 joinFileSystemPath
  content = content.replace(
    "import { areFileSystemPathsEqual } from '@/utils/file/path';",
    "import { areFileSystemPathsEqual, joinFileSystemPath } from '@/utils/file/path';"
  );

  // 2. 删除手写 joinWorkspacePath 函数（多种可能的缩进/空行版本）
  const joinFuncPatterns = [
    `const joinWorkspacePath = (workspaceRootPath: string, path: string): string => {
  const root = workspaceRootPath.replace(/[\\\\/]+$/u, '');
  const child = path.replace(/^[\\\\/]+/u, '');
  return \`\${root}/\${child}\`;
};\n`,
    `const joinWorkspacePath = (workspaceRootPath: string, path: string): string => {
  const root = workspaceRootPath.replace(/[\\\\/]+$/u, "");
  const child = path.replace(/^[\\\\/]+/u, "");
  return \`\${root}/\${child}\`;
};\n`,
  ];
  let removed = false;
  for (const p of joinFuncPatterns) {
    if (content.includes(p)) {
      content = content.replace(p, '');
      removed = true;
      break;
    }
  }
  if (!removed) {
    console.warn('⚠ #32: joinWorkspacePath 函数未找到精确匹配，尝试正则删除');
    content = content.replace(
      /const joinWorkspacePath = \(workspaceRootPath: string, path: string\): string => \{[\s\S]*?\};\n?/,
      ''
    );
  }

  // 3. 替换调用处
  content = content.replace(/joinWorkspacePath\(/g, 'joinFileSystemPath(');

  writeFile(f, content);
}

// ---------------------------------------------------------------------------
// #33 useDocumentNavigationHistory.ts: 提取 trimStack 消除重复 slice
// ---------------------------------------------------------------------------
function fix33() {
  console.log('\n--- #33 useDocumentNavigationHistory.ts trimStack 提取 ---');
  const f = 'src/composables/useDocumentNavigationHistory.ts';
  let content = readFile(f);
  if (!content) return;

  if (content.includes('trimStack')) {
    console.log('   #33 已修复，跳过');
    return;
  }

  const insertionPoint = 'const MAX_HISTORY_SIZE = 120;\n';
  const trimStackDef = [
    'const MAX_HISTORY_SIZE = 120;',
    '',
    '/** 栈超出上限时只保留最尾部 MAX_HISTORY_SIZE 个条目。 */',
    'const trimStack = (stack: string[]): string[] =>',
    '  stack.length > MAX_HISTORY_SIZE',
    '    ? stack.slice(stack.length - MAX_HISTORY_SIZE)',
    '    : stack;',
  ].join('\n');

  if (content.includes(insertionPoint)) {
    content = content.replace(insertionPoint, trimStackDef);
  }

  // 替换两处内联 trim 逻辑（可能有多种空格变体）
  const slicePatterns = [
    {
      old: [
        '    backStack.value = [...backStack.value, previousDocumentId].slice(',
        '      Math.max(0, backStack.value.length + 1 - MAX_HISTORY_SIZE),',
        '    );',
      ].join('\n'),
      new: '    backStack.value = trimStack([...backStack.value, previousDocumentId]);',
    },
    {
      old: [
        '    targetStack.value = [...targetStack.value, currentDocumentId].slice(',
        '      Math.max(0, targetStack.value.length + 1 - MAX_HISTORY_SIZE),',
        '    );',
      ].join('\n'),
      new: '    targetStack.value = trimStack([...targetStack.value, currentDocumentId]);',
    },
  ];

  for (const { old: oldStr, new: newStr } of slicePatterns) {
    if (content.includes(oldStr)) {
      content = content.replace(oldStr, newStr);
    } else {
      // 正则回退：匹配 .slice( \n ... MAX_HISTORY_SIZE ... \n ... ) 模式
      content = content.replace(
        /(\w+Stack)\.value = \[\.\.\.(\w+Stack)\.value, (\w+DocumentId)\]\.slice\(\s*\n\s*Math\.max\(0, \2\.value\.length \+ 1 - MAX_HISTORY_SIZE\),\s*\n\s*\);/g,
        '$1.value = trimStack([...$1.value, $3]);'
      );
    }
  }

  writeFile(f, content);
}

// ---------------------------------------------------------------------------
// #34 useShellWorkbenchViewportState.ts: 提取 clamp 到 utils/core/math.ts
// ---------------------------------------------------------------------------
function fix34() {
  console.log('\n--- #34 clamp 提取到 utils/core/math.ts ---');

  const mathFile = 'src/utils/core/math.ts';
  let mathContent = readFile(mathFile);
  const clampDef = [
    '/**',
    ' * 将数值限制在 [min, max] 区间内。',
    ' */',
    'export const clamp = (value: number, min: number, max: number): number =>',
    '  Math.min(max, Math.max(min, value));',
    '',
  ].join('\n');

  if (mathContent !== null) {
    if (mathContent.includes('export const clamp')) {
      console.log('   #34 math.ts 已有 clamp 导出，跳过创建');
    } else {
      mathContent = mathContent.trimEnd() + '\n\n' + clampDef;
      writeFile(mathFile, mathContent);
    }
  } else {
    writeFile(mathFile, [
      '/**',
      ' * 通用数学工具。',
      ' */',
      '',
      clampDef,
    ].join('\n'));
  }

  // 2. 在 useShellWorkbenchViewportState.ts 中替换 clampNumber
  const f = 'src/composables/useShellWorkbenchViewportState.ts';
  let content = readFile(f);
  if (!content) return;

  if (content.includes("from '@/utils/core/math'")) {
    console.log('   #34 viewportState 已修复，跳过');
    return;
  }

  // 删除 clampNumber 本地定义（多种变体）
  const clampDefs = [
    'const clampNumber = (value: number, min: number, max: number): number =>\n  Math.min(max, Math.max(min, value));\n',
    'const clampNumber = (value: number, min: number, max: number): number =>\n  Math.min(max, Math.max(min, value));',
  ];
  for (const d of clampDefs) {
    if (content.includes(d)) {
      content = content.replace(d, '');
      break;
    }
  }

  // 添加 import
  const refImport = "import { ref } from 'vue';\n";
  if (content.includes(refImport)) {
    content = content.replace(refImport, refImport + "import { clamp } from '@/utils/core/math';\n");
  }

  // 替换调用处
  content = content.replace(/clampNumber\(/g, 'clamp(');

  writeFile(f, content);
}

// ---------------------------------------------------------------------------
// #35 lsp-bridge.ts: normalizePath 添加交叉引用注释
// ---------------------------------------------------------------------------
function fix35() {
  console.log('\n--- #35 lsp-bridge.ts normalizePath 交叉引用 ---');
  const f = 'src/services/editor/lsp-bridge.ts';
  let content = readFile(f);
  if (!content) return;

  if (content.includes('path.ts')) {
    console.log('   #35 已修复，跳过');
    return;
  }

  // 找到 normalizePath 的 JSDoc 注释开头，插入交叉引用说明
  const oldComment = [
    ' * 统一前后端 filePath 表示:去掉 Windows 扩展路径前缀，全部用正斜杠。',
    ' *',
    ' * Windows 上 Tauri 可能返回',
  ].join('\n');

  const newComment = [
    ' * 统一前后端 filePath 表示:去掉 Windows 扩展路径前缀，全部用正斜杠。',
    ' *',
    ' * 注意：此函数与 utils/file/path.ts 的 stripWindowsVerbatimPrefix + normalizeFileSystemPath',
    ' * 功能重叠。本模块位于 editor service 层，暂保留本地实现以避免对 utils/file 的依赖。',
    ' * 如未来允许跨层依赖，请直接复用 normalizeFileSystemPath 并删除此函数。',
    ' *',
    ' * Windows 上 Tauri 可能返回',
  ].join('\n');

  if (content.includes(oldComment)) {
    content = content.replace(oldComment, newComment);
    writeFile(f, content);
  } else {
    // 宽松匹配：只找第一行
    const firstLine = ' * 统一前后端 filePath 表示:去掉 Windows 扩展路径前缀，全部用正斜杠。';
    if (content.includes(firstLine)) {
      const insertAfter = firstLine + '\n *\n';
      const crossRef = firstLine + '\n *\n * 注意：此函数与 utils/file/path.ts 的 stripWindowsVerbatimPrefix + normalizeFileSystemPath\n * 功能重叠。本模块位于 editor service 层，暂保留本地实现以避免对 utils/file 的依赖。\n * 如未来允许跨层依赖，请直接复用 normalizeFileSystemPath 并删除此函数。\n *\n';
      content = content.replace(insertAfter, crossRef);
      writeFile(f, content);
    } else {
      console.warn('⚠ #35: normalizePath 注释未找到匹配');
    }
  }
}

// ---------------------------------------------------------------------------
// #36 github-author.ts: 统一 URL 解析
// ---------------------------------------------------------------------------
function fix36() {
  console.log('\n--- #36 github-author.ts 统一 URL 解析 ---');
  const f = 'src/services/github-author.ts';
  let content = readFile(f);
  if (!content) return;

  if (content.includes('parseRepoUrl')) {
    console.log('   #36 已修复，跳过');
    return;
  }

  // 替换 resolveGithubHost + 添加 parseRepoUrl
  const oldHost = [
    'const resolveGithubHost = (repoUrl: string): string | null => {',
    '  try {',
    '    return new URL(repoUrl).host.toLowerCase();',
    '  } catch {',
    '    const match = repoUrl.match(/^https:\\/\\/([^/]+)/);',
    '    return match?.[1]?.toLowerCase() ?? null;',
    '  }',
    '};',
  ].join('\n');

  const newHostAndParser = [
    '/**',
    ' * 统一解析 repo URL 的 host / owner / repo，供所有 GitHub API 构造共用。',
    ' * 一个 URL 只做一次 new URL() 解析，不再各处重复正则后援。',
    ' */',
    'const parseRepoUrl = (repoUrl: string): { host: string; owner: string; repo: string } | null => {',
    '  try {',
    '    const url = new URL(repoUrl);',
    "    const [owner, repo] = url.pathname.split('/').filter(Boolean);",
    '    if (!owner || !repo) return null;',
    "    return { host: url.host.toLowerCase(), owner, repo: repo.replace(/\\.git$/, '') };",
    '  } catch {',
    '    return null;',
    '  }',
    '};',
    '',
    'const resolveGithubHost = (repoUrl: string): string | null =>',
    '  parseRepoUrl(repoUrl)?.host ?? null;',
  ].join('\n');

  if (content.includes(oldHost)) {
    content = content.replace(oldHost, newHostAndParser);
  } else {
    console.warn('⚠ #36: resolveGithubHost 未找到精确匹配');
  }

  // 替换 resolveGithubCommitApiUrl
  const oldApiUrl = [
    'const resolveGithubCommitApiUrl = (repoUrl: string, commitId: string): string | null => {',
    '  const match = repoUrl.match(/^https:\\/\\/([^/]+)\\/([^/]+)\\/([^/]+)\\/?$/);',
    '  if (!match) return null;',
    '',
    '  const [, host, owner, repo] = match;',
    '  const cleanRepo = repo.replace(/\\.git$/, "");',
    '  const apiBase =',
    "    host.toLowerCase() === 'github.com'",
    "      ? 'https://api.github.com'",
    "      : ['https://api.', host].join('');",
    '  return `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(cleanRepo)}/commits/${commitId}`;',
    '};',
  ].join('\n');

  const oldApiUrl2 = [
    'const resolveGithubCommitApiUrl = (repoUrl: string, commitId: string): string | null => {',
    "  const match = repoUrl.match(/^https:\\/\\/([^/]+)\\/([^/]+)\\/([^/]+)\\/?$/);",
    '  if (!match) return null;',
    '',
    '  const [, host, owner, repo] = match;',
    "  const cleanRepo = repo.replace(/\\.git$/, '');",
    '  const apiBase =',
    "    host.toLowerCase() === 'github.com'",
    "      ? 'https://api.github.com'",
    "      : ['https://api.', host].join('');",
    '  return `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(cleanRepo)}/commits/${commitId}`;',
    '};',
  ].join('\n');

  const newApiUrl = [
    'const resolveGithubCommitApiUrl = (repoUrl: string, commitId: string): string | null => {',
    '  const parsed = parseRepoUrl(repoUrl);',
    '  if (!parsed) return null;',
    '',
    '  const apiBase =',
    "    parsed.host === 'github.com'",
    "      ? 'https://api.github.com'",
    '      : `https://api.${parsed.host}`;',
    '  return `${apiBase}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${commitId}`;',
    '};',
  ].join('\n');

  if (content.includes(oldApiUrl)) {
    content = content.replace(oldApiUrl, newApiUrl);
  } else if (content.includes(oldApiUrl2)) {
    content = content.replace(oldApiUrl2, newApiUrl);
  } else {
    console.warn('⚠ #36: resolveGithubCommitApiUrl 未找到精确匹配');
  }

  writeFile(f, content);
}

// ---------------------------------------------------------------------------
// #37 useLsp.ts: 退避计算添加注释
// ---------------------------------------------------------------------------
function fix37() {
  console.log('\n--- #37 useLsp.ts 退避计算注释 ---');
  const f = 'src/composables/useLsp.ts';
  let content = readFile(f);
  if (!content) return;

  if (content.includes('指数退避')) {
    console.log('   #37 已修复，跳过');
    return;
  }

  const oldLine = '  const delay = AUTO_RESTART_BASE_DELAY_MS * 2 ** restartIndex;';
  const newLines = [
    '  // 指数退避：base × 2^attempt。当前仅此一处使用，暂不提取为共享函数。',
    '  // 若未来 IPC 重连 / SSH 重连等场景有同类需求，请提取到 utils/core/async-lifecycle.ts。',
    '  const delay = AUTO_RESTART_BASE_DELAY_MS * 2 ** restartIndex;',
  ].join('\n');

  if (content.includes(oldLine)) {
    content = content.replace(oldLine, newLines);
    writeFile(f, content);
  } else {
    console.warn('⚠ #37: 退避计算行未找到匹配');
  }
}

// ---------------------------------------------------------------------------
// #38 useMessage.ts: generateMessageId 改用 id.ts 的 createPrefixedId
// ---------------------------------------------------------------------------
function fix38() {
  console.log('\n--- #38 useMessage.ts 复用 id.ts ---');
  const f = 'src/composables/useMessage.ts';
  let content = readFile(f);
  if (!content) return;

  if (content.includes('createPrefixedId')) {
    console.log('   #38 已修复，跳过');
    return;
  }

  // 添加 import（找最后一个 import 行追加）
  const importPatterns = [
    "import { type ExternalToast, toast } from 'vue-sonner';\n",
    "import { toast, type ExternalToast } from 'vue-sonner';\n",
  ];
  let importAdded = false;
  for (const ip of importPatterns) {
    if (content.includes(ip)) {
      content = content.replace(ip, ip + "import { createPrefixedId } from '@/utils/core/id';\n");
      importAdded = true;
      break;
    }
  }
  if (!importAdded) {
    // 找最后一个 import 行
    const importMatch = content.match(/^import[^\n]+\n/gm);
    if (importMatch && importMatch.length > 0) {
      const lastImport = importMatch[importMatch.length - 1];
      content = content.replace(lastImport, lastImport + "import { createPrefixedId } from '@/utils/core/id';\n");
    }
  }

  // 删除手写 autoIdCounter + generateMessageId（多种变体）
  const oldGenVariants = [
    [
      'let autoIdCounter = 0;',
      'const generateMessageId = (): string => {',
      '  autoIdCounter = (autoIdCounter + 1) >>> 0;',
      '  return `msg-${Date.now().toString(36)}-${autoIdCounter.toString(36)}`;',
      '};',
    ].join('\n'),
    [
      'let autoIdCounter = 0;',
      "const generateMessageId = (): string => {",
      '  autoIdCounter = (autoIdCounter + 1) >>> 0;',
      '  return `msg-${Date.now().toString(36)}-${autoIdCounter.toString(36)}`;',
      '};',
    ].join('\n'),
  ];

  const newGen = [
    '/** 生成消息唯一 ID，复用 utils/core/id.ts 的 UUID 标准实现。 */',
    "const generateMessageId = (): string => createPrefixedId('msg');",
  ].join('\n');

  let replaced = false;
  for (const old of oldGenVariants) {
    if (content.includes(old)) {
      content = content.replace(old, newGen);
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    console.warn('⚠ #38: generateMessageId 函数未找到精确匹配');
  }

  writeFile(f, content);
}

// ---------------------------------------------------------------------------
// #39 useWindowResizeState.ts: 简化 Reflect.get 为直接属性访问
// ---------------------------------------------------------------------------
function fix39() {
  console.log('\n--- #39 useWindowResizeState.ts 简化 Reflect.get ---');
  const f = 'src/composables/useWindowResizeState.ts';
  let content = readFile(f);
  if (!content) return;

  if (!content.includes('Reflect.get')) {
    console.log('   #39 已修复，跳过');
    return;
  }

  const oldFnVariants = [
    [
      "const readObjectProperty = (source: unknown, key: string): unknown => {",
      "  if (typeof source !== 'object' || source === null) {",
      '    return undefined;',
      '  }',
      '',
      '  return Reflect.get(source, key);',
      '};',
    ].join('\n'),
    [
      "const readObjectProperty = (source: unknown, key: string): unknown => {",
      "  if (typeof source !== 'object' || source === null) {",
      '    return undefined;',
      '  }',
      '',
      '  return Reflect.get(source as object, key);',
      '};',
    ].join('\n'),
  ];

  const newFn = [
    "const readObjectProperty = (source: unknown, key: string): unknown =>",
    "  typeof source === 'object' && source !== null",
    '    ? (source as Record<string, unknown>)[key]',
    '    : undefined;',
  ].join('\n');

  let replaced = false;
  for (const old of oldFnVariants) {
    if (content.includes(old)) {
      content = content.replace(old, newFn);
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    // 正则回退
    content = content.replace(
      /const readObjectProperty = \(source: unknown, key: string\): unknown => \{[\s\S]*?return Reflect\.get[\s\S]*?\};/,
      newFn
    );
  }

  writeFile(f, content);
}

// ---------------------------------------------------------------------------
// #40 agent-sidecar/utils.ts: createSessionId 添加交叉引用注释
// ---------------------------------------------------------------------------
function fix40() {
  console.log('\n--- #40 agent-sidecar createSessionId 交叉引用 ---');
  const f = 'agent-sidecar/src/engines/shared/utils.ts';
  let content = readFile(f);
  if (!content) return;

  if (content.includes('前端 id.ts') || content.includes('crypto.randomUUID')) {
    console.log('   #40 已修复，跳过');
    return;
  }

  const oldLine = [
    'export const createSessionId = (prefix: string): string =>',
    "    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;",
  ].join('\n');

  const newLines = [
    '// 注意：前端 utils/core/id.ts 使用 crypto.randomUUID() 生成 ID（密码学级随机、无进程内状态）。',
    '// agent-sidecar 作为独立 Node 进程不 import 前端模块，故此处保留 Date.now + Math.random 实现。',
    '// 如有变更请同步更新前端 id.ts 和此函数。未来可考虑在 agent-sidecar 内部提取 shared/id.ts。',
    'export const createSessionId = (prefix: string): string =>',
    "    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;",
  ].join('\n');

  if (content.includes(oldLine)) {
    content = content.replace(oldLine, newLines);
    writeFile(f, content);
  } else {
    console.warn('⚠ #40: createSessionId 函数未找到精确匹配');
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
const fixes = [fix32, fix33, fix34, fix35, fix36, fix37, fix38, fix39, fix40];

console.log('🔧 开始执行代码审查修复脚本（第四批）...\n');

let success = 0;
let failed = 0;
for (let i = 0; i < fixes.length; i++) {
  try {
    fixes[i]();
    success++;
  } catch (err) {
    console.error('❌ 修复 #' + (i + 32) + ' 失败:', err);
    failed++;
  }
}

console.log('\n--- 完成: ' + success + ' 项成功, ' + failed + ' 项失败 ---');
console.log('\n⚠️ 改完后请运行:');
console.log('   npx biome check --write');
console.log('');
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { snippet } from '@codemirror/autocomplete';
import bashLanguageWasmUrl from 'tree-sitter-bash/tree-sitter-bash.wasm?url';
import { Language, type Node, Parser, type Point, type Tree } from 'web-tree-sitter';
import treeSitterWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';
import { listShellCommandLabels, loadShellCommandSpec } from '@/services/shell/command-catalog';
import type {
  IShellCommandArgumentSpec,
  IShellCommandNodeSpec,
  IShellCommandOptionSpec,
  IShellCommandValueSuggestionSpec,
  IShellCompletionEntry,
} from '@/types/shell-completion';
import { computeFuzzyScore } from '@/utils/core/fuzzy-score';

const MAX_SUGGESTIONS = 80;

const VARIABLE_BRACE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)?$/;
const VARIABLE_DIRECT_PATTERN = /\$([A-Za-z_][A-Za-z0-9_]*)?$/;
const OPTION_PATTERN = /--?[A-Za-z0-9-]*$/;
const WORD_PATTERN = /[A-Za-z_][A-Za-z0-9._:-]*$/;
const COMMAND_POSITION_PATTERN =
  /(?:^|[|;&(]\s*|\b(?:then|do|else|elif|until|while|in)\s+)([A-Za-z_][A-Za-z0-9._:-]*)?$/;
const DECLARATION_PATTERN =
  /\b(?:export|local|readonly|declare|unset)\s+([A-Za-z_][A-Za-z0-9_]*)?$/;
const CURRENT_TOKEN_PATTERN = /(?:^|[\s|;&()])([^\s|;&()]+)$/;

interface IShellParseCacheEntry {
  source: string;
  tree: Tree;
  symbols: ISymbolSnapshot | null;
  refCount: number;
  superseded: boolean;
}

interface IParsedShellDocument {
  language: Language;
  entry: IShellParseCacheEntry;
}

interface IShellSourceEdit {
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;
  startPosition: Point;
  oldEndPosition: Point;
  newEndPosition: Point;
}

interface IVariableContext {
  partial: string;
  withBraces: boolean;
}

interface ICompletionContext {
  tree: Tree;
  cursorByteOffset: number;
  linePrefix: string;
  lineSuffix: string;
  currentToken: string;
  wordPrefix: string;
  optionPrefix: string;
  variableContext: IVariableContext | null;
  currentNode: Node;
  ancestors: Node[];
  activeCommandNode: Node | null;
  isInComment: boolean;
  isInString: boolean;
  isCommandNameContext: boolean;
  isDeclarationContext: boolean;
  activeCommandName: string | null;
}

interface ISymbolSnapshot {
  variableNames: string[];
  functionNames: string[];
  recentCommandNames: string[];
}

interface IFlagValueContext {
  flag: IShellCommandOptionSpec;
  argumentIndex: number;
}

interface ICommandCatalogContext {
  activeNode: IShellCommandNodeSpec | null;
  awaitingFlagValue: IFlagValueContext | null;
  visitedNodes: IShellCommandNodeSpec[];
  wrapperAwaitingCommand: boolean;
  positionalArgumentIndex: number;
}

let runtimePromise: Promise<Language> | null = null;
let parserPromise: Promise<Parser> | null = null;
let shellParseCache: IShellParseCacheEntry | null = null;
let commandCatalogRootEntriesPromise: Promise<IShellCompletionEntry[]> | null = null;
let lastProviderErrorMessage: string | null = null;

const getPrimarySpecName = (entry: { names: string[] }): string => entry.names[0] ?? '';
const getSpecAliases = (entry: { names: string[] }): string[] => entry.names.slice(1);

const loadCommandCatalogRootEntries = async (): Promise<IShellCompletionEntry[]> => {
  if (!commandCatalogRootEntriesPromise) {
    commandCatalogRootEntriesPromise = listShellCommandLabels().then((labels) =>
      labels.map((label) => ({
        label,
        kind: 'command',
        detail: '命令目录条目',
        priority: 60,
      })),
    );
  }
  return commandCatalogRootEntriesPromise;
};

const wrapperCommandSet = new Set(['command', 'env', 'nohup', 'sudo', 'time']);
const wrapperOptionsWithValue: Record<string, Set<string>> = {
  command: new Set<string>(),
  env: new Set(['-u']),
  nohup: new Set<string>(),
  sudo: new Set(['-g', '-h', '-p', '-u']),
  time: new Set(['-f', '-o']),
};
const envAssignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const commandTokenPattern = /^[A-Za-z0-9_./:-]+(?:=[A-Za-z0-9_./:-]+)?$/;

const SHELL_KEYWORD_ENTRIES: IShellCompletionEntry[] = [
  { label: 'if', kind: 'keyword', detail: '条件判断起始关键字', priority: 40 },
  { label: 'then', kind: 'keyword', detail: 'if 语句体起始关键字', priority: 44 },
  { label: 'elif', kind: 'keyword', detail: '附加条件分支', priority: 42 },
  { label: 'else', kind: 'keyword', detail: '默认分支', priority: 43 },
  { label: 'fi', kind: 'keyword', detail: '结束 if 语句', priority: 45 },
  { label: 'for', kind: 'keyword', detail: 'for 循环', priority: 41 },
  { label: 'in', kind: 'keyword', detail: 'for/case 模式列表分隔', priority: 46 },
  { label: 'do', kind: 'keyword', detail: '循环体起始关键字', priority: 47 },
  { label: 'done', kind: 'keyword', detail: '结束循环', priority: 48 },
  { label: 'while', kind: 'keyword', detail: 'while 循环', priority: 41 },
  { label: 'until', kind: 'keyword', detail: 'until 循环', priority: 41 },
  { label: 'case', kind: 'keyword', detail: '模式匹配语句', priority: 41 },
  { label: 'esac', kind: 'keyword', detail: '结束 case 语句', priority: 48 },
  { label: 'function', kind: 'keyword', detail: '函数定义关键字', priority: 41 },
  { label: 'select', kind: 'keyword', detail: '交互式选择循环', priority: 41 },
];

const SHELL_SNIPPET_ENTRIES: IShellCompletionEntry[] = [
  {
    label: 'if then fi',
    kind: 'snippet',
    detail: '插入 if 条件语句骨架',
    insertText: 'if [[ ${1:condition} ]]; then\n  ${0}\nfi',
    insertAsSnippet: true,
    priority: 20,
  },
  {
    label: 'for do done',
    kind: 'snippet',
    detail: '插入 for 循环骨架',
    insertText: 'for ${1:item} in ${2:"$@"}; do\n  ${0}\ndone',
    insertAsSnippet: true,
    priority: 21,
  },
  {
    label: 'while do done',
    kind: 'snippet',
    detail: '插入 while 循环骨架',
    insertText: 'while [[ ${1:condition} ]]; do\n  ${0}\ndone',
    insertAsSnippet: true,
    priority: 21,
  },
  {
    label: 'case esac',
    kind: 'snippet',
    detail: '插入 case 模式匹配骨架',
    insertText: 'case "${1:value}" in\n  ${2:pattern})\n    ${0}\n    ;;\nesac',
    insertAsSnippet: true,
    priority: 22,
  },
  {
    label: 'shell function',
    kind: 'snippet',
    detail: '插入 shell 函数骨架',
    insertText: '${1:name}() {\n  ${0}\n}',
    insertAsSnippet: true,
    priority: 22,
  },
  {
    label: 'bash header',
    kind: 'snippet',
    detail: '插入 bash 安全头部',
    insertText: '#!/bin/bash\n\nset -euo pipefail\n\n${1:main}() {\n  ${0}\n}\n\n${1:main} "$@"',
    insertAsSnippet: true,
    priority: 24,
  },
];

const SHELL_COMMAND_ENTRIES: IShellCompletionEntry[] = [
  { label: 'awk', kind: 'command', detail: '文本字段处理工具', priority: 50 },
  { label: 'bash', kind: 'command', detail: '执行 bash shell', priority: 50 },
  { label: 'cat', kind: 'command', detail: '输出文件内容', priority: 50 },
  { label: 'cd', kind: 'command', detail: '切换当前目录', priority: 49 },
  { label: 'chmod', kind: 'command', detail: '修改文件权限', priority: 50 },
  { label: 'cp', kind: 'command', detail: '复制文件或目录', priority: 50 },
  { label: 'curl', kind: 'command', detail: '发起 HTTP 请求', priority: 50 },
  { label: 'date', kind: 'command', detail: '输出当前日期时间', priority: 51 },
  { label: 'docker', kind: 'command', detail: '容器管理命令', priority: 50 },
  { label: 'echo', kind: 'command', detail: '输出文本到终端', priority: 49 },
  { label: 'export', kind: 'command', detail: '导出环境变量', priority: 49 },
  { label: 'find', kind: 'command', detail: '递归查找文件', priority: 50 },
  { label: 'git', kind: 'command', detail: '版本控制命令', priority: 50 },
  { label: 'grep', kind: 'command', detail: '文本搜索工具', priority: 50 },
  { label: 'head', kind: 'command', detail: '查看文件前几行', priority: 51 },
  { label: 'journalctl', kind: 'command', detail: '查看 systemd 日志', priority: 51 },
  { label: 'local', kind: 'command', detail: '声明局部变量', priority: 49 },
  { label: 'ls', kind: 'command', detail: '列出目录内容', priority: 50 },
  { label: 'mkdir', kind: 'command', detail: '创建目录', priority: 50 },
  { label: 'mv', kind: 'command', detail: '移动或重命名文件', priority: 50 },
  { label: 'printf', kind: 'command', detail: '格式化输出', priority: 49 },
  { label: 'pwd', kind: 'command', detail: '显示当前目录', priority: 49 },
  { label: 'read', kind: 'command', detail: '读取标准输入', priority: 49 },
  { label: 'rm', kind: 'command', detail: '删除文件或目录', priority: 50 },
  { label: 'rsync', kind: 'command', detail: '同步目录内容', priority: 50 },
  { label: 'scp', kind: 'command', detail: '通过 SSH 复制文件', priority: 50 },
  { label: 'sed', kind: 'command', detail: '流式文本替换', priority: 50 },
  { label: 'sh', kind: 'command', detail: '执行 POSIX shell', priority: 50 },
  { label: 'sort', kind: 'command', detail: '排序文本输出', priority: 51 },
  { label: 'source', kind: 'command', detail: '加载当前 shell 脚本', priority: 49 },
  { label: 'ssh', kind: 'command', detail: '建立 SSH 连接', priority: 50 },
  { label: 'sudo', kind: 'command', detail: '提升权限执行命令', priority: 50 },
  { label: 'systemctl', kind: 'command', detail: '管理 systemd 服务', priority: 50 },
  { label: 'tail', kind: 'command', detail: '查看文件末尾内容', priority: 51 },
  { label: 'tar', kind: 'command', detail: '打包或解压归档文件', priority: 50 },
  { label: 'tee', kind: 'command', detail: '输出同时写入文件', priority: 51 },
  { label: 'test', kind: 'command', detail: '条件测试命令', priority: 49 },
  { label: 'touch', kind: 'command', detail: '创建空文件或更新时间戳', priority: 51 },
  { label: 'tr', kind: 'command', detail: '字符替换工具', priority: 51 },
  { label: 'unset', kind: 'command', detail: '删除变量或函数', priority: 49 },
  { label: 'xargs', kind: 'command', detail: '把标准输入转为命令参数', priority: 51 },
];

const TEST_OPERATOR_ENTRIES: IShellCompletionEntry[] = [
  { label: '-f', kind: 'operator', detail: '文件存在且是普通文件', priority: 30 },
  { label: '-d', kind: 'operator', detail: '路径存在且是目录', priority: 30 },
  { label: '-e', kind: 'operator', detail: '文件或目录存在', priority: 30 },
  { label: '-n', kind: 'operator', detail: '字符串非空', priority: 30 },
  { label: '-z', kind: 'operator', detail: '字符串为空', priority: 30 },
  { label: '=', kind: 'operator', detail: '字符串相等', priority: 31 },
  { label: '!=', kind: 'operator', detail: '字符串不相等', priority: 31 },
  { label: '-eq', kind: 'operator', detail: '整数相等', priority: 31 },
  { label: '-ne', kind: 'operator', detail: '整数不相等', priority: 31 },
  { label: '-gt', kind: 'operator', detail: '左值大于右值', priority: 31 },
  { label: '-lt', kind: 'operator', detail: '左值小于右值', priority: 31 },
  { label: '-ge', kind: 'operator', detail: '左值大于等于右值', priority: 31 },
  { label: '-le', kind: 'operator', detail: '左值小于等于右值', priority: 31 },
];

const COMMON_VARIABLE_ENTRIES: IShellCompletionEntry[] = [
  { label: 'HOME', kind: 'variable', detail: '当前用户主目录', priority: 10 },
  { label: 'PATH', kind: 'variable', detail: '命令搜索路径', priority: 10 },
  { label: 'PWD', kind: 'variable', detail: '当前工作目录', priority: 10 },
  { label: 'OLDPWD', kind: 'variable', detail: '上一次工作目录', priority: 11 },
  { label: 'USER', kind: 'variable', detail: '当前登录用户名', priority: 10 },
  { label: 'SHELL', kind: 'variable', detail: '当前 shell 路径', priority: 11 },
  { label: 'TERM', kind: 'variable', detail: '终端类型', priority: 11 },
  { label: 'LANG', kind: 'variable', detail: '当前语言环境', priority: 11 },
  { label: 'LC_ALL', kind: 'variable', detail: '语言环境总开关', priority: 11 },
  { label: 'TMPDIR', kind: 'variable', detail: '临时目录路径', priority: 11 },
  { label: 'EDITOR', kind: 'variable', detail: '默认编辑器', priority: 11 },
  { label: 'HOSTNAME', kind: 'variable', detail: '当前主机名', priority: 11 },
  { label: 'UID', kind: 'variable', detail: '当前用户 ID', priority: 12 },
  { label: 'EUID', kind: 'variable', detail: '当前有效用户 ID', priority: 12 },
  { label: 'RANDOM', kind: 'variable', detail: 'Bash 随机数变量', priority: 12 },
  { label: 'PPID', kind: 'variable', detail: '父进程 ID', priority: 12 },
  { label: 'BASH_SOURCE', kind: 'variable', detail: '当前脚本来源文件', priority: 12 },
  { label: 'BASH_VERSION', kind: 'variable', detail: 'Bash 版本字符串', priority: 12 },
  { label: 'IFS', kind: 'variable', detail: '单词分隔符', priority: 12 },
];

const KEYWORD_ENTRY_MAP = new Map(
  SHELL_KEYWORD_ENTRIES.map((entry) => [entry.label, entry] as const),
);

const ensureTreeSitterLanguage = async (): Promise<Language> => {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      try {
        await Parser.init({
          locateFile: () => treeSitterWasmUrl,
        });
        return await Language.load(bashLanguageWasmUrl);
      } catch (error) {
        runtimePromise = null;
        throw error;
      }
    })();
  }
  return runtimePromise;
};

// 复用单例 Parser：避免每次补全都 new/delete 一个 tree-sitter 解析器。
const ensureParser = async (): Promise<Parser> => {
  if (!parserPromise) {
    parserPromise = (async () => {
      try {
        const language = await ensureTreeSitterLanguage();
        const parser = new Parser();
        parser.setLanguage(language);
        return parser;
      } catch (error) {
        parserPromise = null;
        throw error;
      }
    })();
  }
  return parserPromise;
};

const reportShellCompletionProviderError = (error: unknown): void => {
  const nextMessage = error instanceof Error ? error.message : String(error);
  if (lastProviderErrorMessage === nextMessage) {
    return;
  }
  lastProviderErrorMessage = nextMessage;
  console.error('Shell completion provider failed', error);
};

// 计算 source[start, end) 子串的 UTF-8 字节长度，避免生成中间子串与 Uint8Array。
// 补全热路径上（每次按键都会触发）减少分配；行为与 TextEncoder().encode().byteLength
// 一致：完整代理对计 4 字节，孤立代理项按 U+FFFD 计 3 字节。
const utf8ByteLengthOfRange = (source: string, start: number, end: number): number => {
  let bytes = 0;
  let index = start;
  while (index < end) {
    const code = source.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
      index += 1;
    } else if (code < 0x800) {
      bytes += 2;
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < end) {
      const nextCode = source.charCodeAt(index + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        bytes += 4;
        index += 2;
      } else {
        bytes += 3;
        index += 1;
      }
    } else {
      bytes += 3;
      index += 1;
    }
  }
  return bytes;
};

export const getUtf8ByteLength = (value: string): number =>
  utf8ByteLengthOfRange(value, 0, value.length);

// 将字符下标转换为 tree-sitter 期望的字节坐标 Point（与 getUtf8ByteLength 的约定保持一致）。
const toBytePoint = (source: string, charIndex: number): Point => {
  let row = 0;
  let lineStartChar = 0;
  for (let index = 0; index < charIndex; index += 1) {
    if (source.charCodeAt(index) === 10) {
      row += 1;
      lineStartChar = index + 1;
    }
  }
  return {
    row,
    column: utf8ByteLengthOfRange(source, lineStartChar, charIndex),
  };
};

// 通过最小公共前后缀计算单段替换编辑；该编辑精确描述 oldSource -> newSource 的差异，
// 故 tree-sitter 增量重解析结果始终正确（即便两段文本不相关，最多退化为全量解析）。
const computeShellSourceEdit = (oldSource: string, newSource: string): IShellSourceEdit => {
  const oldLength = oldSource.length;
  const newLength = newSource.length;
  const prefixLimit = Math.min(oldLength, newLength);
  let startChar = 0;
  while (
    startChar < prefixLimit &&
    oldSource.charCodeAt(startChar) === newSource.charCodeAt(startChar)
  ) {
    startChar += 1;
  }
  let oldEndChar = oldLength;
  let newEndChar = newLength;
  while (
    oldEndChar > startChar &&
    newEndChar > startChar &&
    oldSource.charCodeAt(oldEndChar - 1) === newSource.charCodeAt(newEndChar - 1)
  ) {
    oldEndChar -= 1;
    newEndChar -= 1;
  }
  return {
    startIndex: utf8ByteLengthOfRange(newSource, 0, startChar),
    oldEndIndex: utf8ByteLengthOfRange(oldSource, 0, oldEndChar),
    newEndIndex: utf8ByteLengthOfRange(newSource, 0, newEndChar),
    startPosition: toBytePoint(newSource, startChar),
    oldEndPosition: toBytePoint(oldSource, oldEndChar),
    newEndPosition: toBytePoint(newSource, newEndChar),
  };
};

const acquireParseEntry = (entry: IShellParseCacheEntry): IShellParseCacheEntry => {
  entry.refCount += 1;
  return entry;
};

const releaseParseEntry = (entry: IShellParseCacheEntry): void => {
  if (entry.refCount > 0) {
    entry.refCount -= 1;
  }
  if (entry.refCount === 0 && entry.superseded) {
    entry.tree.delete();
  }
};

const supersedeParseEntry = (entry: IShellParseCacheEntry): void => {
  entry.superseded = true;
  if (entry.refCount === 0) {
    entry.tree.delete();
  }
};

const getEntrySymbols = (entry: IShellParseCacheEntry): ISymbolSnapshot => {
  if (!entry.symbols) {
    entry.symbols = collectDocumentSymbols(entry.tree.rootNode);
  }
  return entry.symbols;
};

// 解析 shell 文档：命中缓存直接复用；文本变化时尽量增量重解析，异常回退全量解析。
const parseShellDocument = async (source: string): Promise<IParsedShellDocument> => {
  const language = await ensureTreeSitterLanguage();
  const parser = await ensureParser();
  const cached = shellParseCache;

  if (cached && cached.source === source) {
    return { language, entry: acquireParseEntry(cached) };
  }

  let tree: Tree | null = null;

  // 仅在没有在途读取者时复用旧树做增量解析，避免 edit 影响并发请求正在读取的树。
  if (cached && cached.refCount === 0) {
    try {
      cached.tree.edit(computeShellSourceEdit(cached.source, source));
      tree = parser.parse(source, cached.tree);
    } catch (error) {
      reportShellCompletionProviderError(error);
      tree = null;
    }
  }

  if (!tree) {
    tree = parser.parse(source);
  }
  if (!tree) {
    throw new Error('tree-sitter 返回空语法树。');
  }

  const entry: IShellParseCacheEntry = {
    source,
    tree,
    symbols: null,
    refCount: 0,
    superseded: false,
  };
  shellParseCache = entry;

  if (cached && cached.tree !== tree) {
    supersedeParseEntry(cached);
  }

  return { language, entry: acquireParseEntry(entry) };
};

const collectAncestors = (node: Node | null): Node[] => {
  const ancestors: Node[] = [];
  let activeNode = node;
  while (activeNode) {
    ancestors.push(activeNode);
    activeNode = activeNode.parent;
  }
  return ancestors;
};

const hasAncestorType = (ancestors: Node[], type: string): boolean =>
  ancestors.some((ancestor) => ancestor.type === type);

const findAncestorByType = (ancestors: Node[], types: string[]): Node | null =>
  ancestors.find((ancestor) => types.includes(ancestor.type)) ?? null;

const normalizeCommandName = (value: string): string | null => {
  const normalizedValue = value.trim().replace(/^['"]|['"]$/g, '');
  return /^[A-Za-z0-9._:-]+$/.test(normalizedValue) ? normalizedValue : null;
};

const normalizeCommandToken = (value: string): string | null => {
  const normalizedValue = value.trim().replace(/^['"]|['"]$/g, '');
  return commandTokenPattern.test(normalizedValue) ? normalizedValue : null;
};

const resolveCommandName = (commandNode: Node | null): string | null => {
  if (!commandNode) {
    return null;
  }
  const commandNameNode = commandNode.childForFieldName('name');
  return commandNameNode ? normalizeCommandName(commandNameNode.text) : null;
};

const collectVariableNames = (rootNode: Node): string[] => {
  const names = new Set<string>();
  for (const node of rootNode.descendantsOfType('variable_assignment')) {
    const fieldNode = node.childForFieldName('name');
    if (!fieldNode) {
      continue;
    }
    const targetNode =
      fieldNode.type === 'variable_name'
        ? fieldNode
        : (fieldNode.descendantsOfType('variable_name')[0] ?? null);
    if (targetNode?.text) {
      names.add(targetNode.text);
    }
  }
  return [...names].sort();
};

const collectFunctionNames = (rootNode: Node): string[] => {
  const names = new Set<string>();
  for (const node of rootNode.descendantsOfType('function_definition')) {
    const fieldNode = node.childForFieldName('name');
    const normalizedName = fieldNode ? normalizeCommandName(fieldNode.text) : null;
    if (normalizedName) {
      names.add(normalizedName);
    }
  }
  return [...names].sort();
};

const collectRecentCommandNames = (rootNode: Node): string[] => {
  const names = new Set<string>();
  for (const node of rootNode.descendantsOfType('command_name')) {
    const normalizedName = normalizeCommandName(node.text);
    if (normalizedName) {
      names.add(normalizedName);
    }
  }
  return [...names].sort();
};

const collectDocumentSymbols = (rootNode: Node): ISymbolSnapshot => ({
  variableNames: collectVariableNames(rootNode),
  functionNames: collectFunctionNames(rootNode),
  recentCommandNames: collectRecentCommandNames(rootNode),
});

const resolveVariableContext = (linePrefix: string): IVariableContext | null => {
  const braceMatch = linePrefix.match(VARIABLE_BRACE_PATTERN);
  if (braceMatch) {
    return {
      partial: braceMatch[1] ?? '',
      withBraces: true,
    };
  }
  const directMatch = linePrefix.match(VARIABLE_DIRECT_PATTERN);
  if (directMatch) {
    return {
      partial: directMatch[1] ?? '',
      withBraces: false,
    };
  }
  return null;
};

const resolveCurrentToken = (linePrefix: string): string =>
  linePrefix.match(CURRENT_TOKEN_PATTERN)?.[1] ?? '';

const resolveCompletionContext = (
  tree: Tree,
  cursorByteOffset: number,
  linePrefix: string,
  lineSuffix: string,
  point: Point,
): ICompletionContext => {
  const currentNode =
    tree.rootNode.namedDescendantForPosition(point) ??
    tree.rootNode.descendantForPosition(point) ??
    tree.rootNode;
  const ancestors = collectAncestors(currentNode);
  const activeCommandNode = findAncestorByType(ancestors, ['command']);
  const commandNameNode = activeCommandNode?.childForFieldName('name') ?? null;
  const currentToken = resolveCurrentToken(linePrefix);
  const wordPrefix = linePrefix.match(WORD_PATTERN)?.[0] ?? '';
  const optionPrefix = linePrefix.match(OPTION_PATTERN)?.[0] ?? '';
  return {
    tree,
    cursorByteOffset,
    linePrefix,
    lineSuffix,
    currentToken,
    wordPrefix,
    optionPrefix,
    variableContext: resolveVariableContext(linePrefix),
    currentNode,
    ancestors,
    activeCommandNode,
    isInComment: hasAncestorType(ancestors, 'comment'),
    isInString: hasAncestorType(ancestors, 'string') || hasAncestorType(ancestors, 'raw_string'),
    isCommandNameContext:
      hasAncestorType(ancestors, 'command_name') ||
      (Boolean(commandNameNode) && cursorByteOffset <= (commandNameNode?.endIndex ?? 0)) ||
      COMMAND_POSITION_PATTERN.test(linePrefix),
    isDeclarationContext: DECLARATION_PATTERN.test(linePrefix),
    activeCommandName: resolveCommandName(activeCommandNode),
  };
};

// 模糊匹配门控：当「label / 别名为查询子序列」时命中（fzf 式评分见 utils/core/fuzzy-score），
// 同时保留对 detail 描述的子串搜索。相比此前的 startsWith，'gt' 也能命中 'git'，
// 让更优的对齐候选进入排序。
const entryMatchesQuery = (entry: IShellCompletionEntry, partial: string): boolean => {
  if (!partial) {
    return true;
  }
  if (computeFuzzyScore(entry.label, partial) !== null) {
    return true;
  }
  if (entry.aliases?.some((alias) => computeFuzzyScore(alias, partial) !== null)) {
    return true;
  }
  return entry.detail.toLowerCase().includes(partial.toLowerCase());
};

const filterEntries = (
  entries: IShellCompletionEntry[],
  partial: string,
): IShellCompletionEntry[] => entries.filter((entry) => entryMatchesQuery(entry, partial));

const createCommandEntries = (labels: string[], priority: number): IShellCompletionEntry[] =>
  labels.map((label) => ({
    label,
    kind: 'command',
    detail: '当前脚本中出现过的命令或函数',
    priority,
  }));

const createVariableEntries = (labels: string[], priority: number): IShellCompletionEntry[] =>
  labels.map((label) => ({
    label,
    kind: 'variable',
    detail: '当前脚本中声明的变量',
    priority,
  }));

const createCommandEntryFromCatalog = (entry: IShellCommandNodeSpec): IShellCompletionEntry => ({
  label: getPrimarySpecName(entry),
  kind: 'command',
  detail:
    getSpecAliases(entry).length > 0
      ? `${entry.detail ?? '命令目录条目'} · 别名: ${getSpecAliases(entry).join(', ')}`
      : (entry.detail ?? '命令目录条目'),
  aliases: getSpecAliases(entry),
  priority: entry.priority ?? 6,
});

const createFlagEntryFromSpec = (entry: IShellCommandOptionSpec): IShellCompletionEntry => ({
  label: getPrimarySpecName(entry),
  kind: 'flag',
  detail:
    getSpecAliases(entry).length > 0
      ? `${entry.detail ?? '命令选项'} · 别名: ${getSpecAliases(entry).join(', ')}`
      : (entry.detail ?? '命令选项'),
  aliases: getSpecAliases(entry),
  insertText: entry.insertText,
  insertAsSnippet: entry.insertAsSnippet,
  priority: entry.priority ?? 7,
});

const createValueEntryFromSuggestionSpec = (
  entry: IShellCommandValueSuggestionSpec,
  argumentSpec: IShellCommandArgumentSpec,
): IShellCompletionEntry => ({
  label: getPrimarySpecName(entry),
  kind: 'value',
  detail: entry.detail || argumentSpec.detail || '参数候选值',
  aliases: getSpecAliases(entry),
  insertText: entry.insertText,
  insertAsSnippet: entry.insertAsSnippet,
  priority: entry.priority ?? 5,
});

const getOptionArgumentSpecs = (entry: IShellCommandOptionSpec): IShellCommandArgumentSpec[] => {
  if (entry.arg) {
    return [entry.arg];
  }
  if (entry.args?.length) {
    return entry.args;
  }
  return [];
};

const getArgumentSpecAtIndex = (
  argumentSpecs: IShellCommandArgumentSpec[],
  argumentIndex: number,
): IShellCommandArgumentSpec | null => {
  if (argumentSpecs.length === 0) {
    return null;
  }
  if (argumentIndex < argumentSpecs.length) {
    return argumentSpecs[argumentIndex];
  }
  const lastArgumentSpec = argumentSpecs[argumentSpecs.length - 1] ?? null;
  return lastArgumentSpec?.isVariadic ? lastArgumentSpec : null;
};

const buildArgumentValueEntries = (
  argumentSpec: IShellCommandArgumentSpec | null,
  partial: string,
): IShellCompletionEntry[] => {
  if (!argumentSpec?.suggestions?.length) {
    return [];
  }
  return filterEntries(
    argumentSpec.suggestions.map((entry) =>
      createValueEntryFromSuggestionSpec(entry, argumentSpec),
    ),
    partial,
  );
};

const buildOptionValueEntries = (
  flagSpec: IShellCommandOptionSpec,
  argumentIndex: number,
  partial: string,
): IShellCompletionEntry[] =>
  buildArgumentValueEntries(
    getArgumentSpecAtIndex(getOptionArgumentSpecs(flagSpec), argumentIndex),
    partial,
  );

const buildPositionalArgumentValueEntries = (
  commandNode: IShellCommandNodeSpec,
  argumentIndex: number,
  partial: string,
): IShellCompletionEntry[] =>
  buildArgumentValueEntries(getArgumentSpecAtIndex(commandNode.args ?? [], argumentIndex), partial);

const getCurrentTokenPrefix = (context: ICompletionContext): string =>
  context.optionPrefix || context.wordPrefix;

const collectCommandArgumentNodes = (commandNode: Node): Node[] => {
  const commandNameNode = commandNode.childForFieldName('name');
  const argumentNodes = commandNode.childrenForFieldName('argument');
  return [commandNameNode, ...argumentNodes]
    .filter((node): node is Node => Boolean(node))
    .sort((left, right) => left.startIndex - right.startIndex);
};

const collectCommandTokensBeforeCursor = (
  commandNode: Node,
  cursorByteOffset: number,
  currentTokenPrefix: string,
): string[] => {
  const tokens: string[] = [];
  const tokenNodes = collectCommandArgumentNodes(commandNode);
  for (const node of tokenNodes) {
    if (node.startIndex >= cursorByteOffset) {
      break;
    }
    if (currentTokenPrefix.length > 0 && node.endIndex >= cursorByteOffset) {
      break;
    }
    const normalizedToken = normalizeCommandToken(node.text);
    if (normalizedToken) {
      tokens.push(normalizedToken);
    }
  }
  return tokens;
};

const collectAvailableFlags = (nodes: IShellCommandNodeSpec[]): IShellCommandOptionSpec[] => {
  const uniqueEntries = new Map<string, IShellCommandOptionSpec>();
  for (const node of nodes) {
    for (const entry of node.flags ?? []) {
      const primaryName = getPrimarySpecName(entry);
      if (!uniqueEntries.has(primaryName)) {
        uniqueEntries.set(primaryName, entry);
      }
    }
  }
  return [...uniqueEntries.values()];
};

const matchesCommandCatalogNode = (entry: IShellCommandNodeSpec, token: string): boolean =>
  entry.names.includes(token);

const findCommandCatalogNode = (
  entries: IShellCommandNodeSpec[],
  token: string,
): IShellCommandNodeSpec | null =>
  entries.find((entry) => matchesCommandCatalogNode(entry, token)) ?? null;

const matchesFlagSpec = (entry: IShellCommandOptionSpec, token: string): boolean => {
  const normalizedToken = token.split('=')[0];
  return entry.names.includes(normalizedToken);
};

const findFlagSpec = (
  entries: IShellCommandOptionSpec[],
  token: string,
): IShellCommandOptionSpec | null => entries.find((entry) => matchesFlagSpec(entry, token)) ?? null;

const getOptionArgumentCount = (entry: IShellCommandOptionSpec): number =>
  getOptionArgumentSpecs(entry).length;

const stripWrapperTokens = (
  tokens: string[],
): { awaitingCommand: boolean; strippedTokens: string[] } => {
  let remainingTokens = [...tokens];
  while (remainingTokens.length > 0 && wrapperCommandSet.has(remainingTokens[0])) {
    const wrapperName = remainingTokens[0];
    const optionSpecs = wrapperOptionsWithValue[wrapperName] ?? new Set<string>();
    let index = 1;
    while (index < remainingTokens.length) {
      const token = remainingTokens[index];
      if (wrapperName === 'env' && envAssignmentPattern.test(token)) {
        index += 1;
        continue;
      }
      if (!token.startsWith('-')) {
        break;
      }
      const normalizedToken = token.split('=')[0];
      const takesValue = optionSpecs.has(normalizedToken);
      index += 1;
      if (takesValue && !token.includes('=') && index < remainingTokens.length) {
        index += 1;
      }
    }
    if (index >= remainingTokens.length) {
      return {
        awaitingCommand: true,
        strippedTokens: [],
      };
    }
    remainingTokens = remainingTokens.slice(index);
  }
  return {
    awaitingCommand: false,
    strippedTokens: remainingTokens,
  };
};

const resolveCommandCatalogContext = async (
  tokens: string[],
  currentTokenPrefix: string,
): Promise<ICommandCatalogContext | null> => {
  const wrapperResolution = stripWrapperTokens(tokens);
  const strippedTokens = wrapperResolution.strippedTokens;
  if (strippedTokens.length === 0) {
    return wrapperResolution.awaitingCommand
      ? {
          activeNode: null,
          awaitingFlagValue: null,
          visitedNodes: [],
          wrapperAwaitingCommand: true,
          positionalArgumentIndex: 0,
        }
      : null;
  }
  const rootNode = await loadShellCommandSpec(strippedTokens[0]);
  if (!rootNode) {
    return null;
  }
  let activeNode = rootNode;
  const visitedNodes = [rootNode];
  let awaitingFlagValue: IFlagValueContext | null = null;
  let positionalArgumentIndex = 0;
  const argumentTokens = strippedTokens.slice(1);
  for (let index = 0; index < argumentTokens.length; index += 1) {
    const token = argumentTokens[index];
    const availableFlags = collectAvailableFlags(visitedNodes);
    const matchedFlag = findFlagSpec(availableFlags, token);
    if (matchedFlag) {
      const expectedArgumentCount = getOptionArgumentCount(matchedFlag);
      if (expectedArgumentCount > 0) {
        const inlineArgumentCount = token.includes('=') ? 1 : 0;
        const remainingArgumentCount = Math.max(expectedArgumentCount - inlineArgumentCount, 0);
        const availableFollowingCount = Math.min(
          remainingArgumentCount,
          argumentTokens.length - index - 1,
        );
        index += availableFollowingCount;
        if (
          remainingArgumentCount > availableFollowingCount &&
          !currentTokenPrefix.startsWith('-')
        ) {
          awaitingFlagValue = {
            flag: matchedFlag,
            argumentIndex: inlineArgumentCount + availableFollowingCount,
          };
        }
      }
      continue;
    }
    const nextNode = findCommandCatalogNode(activeNode.subcommands ?? [], token);
    if (nextNode) {
      activeNode = nextNode;
      visitedNodes.push(nextNode);
      positionalArgumentIndex = 0;
      continue;
    }
    positionalArgumentIndex += 1;
  }
  return {
    activeNode,
    awaitingFlagValue,
    visitedNodes,
    wrapperAwaitingCommand: false,
    positionalArgumentIndex,
  };
};

const resolveInlineFlagValueContext = (
  catalogContext: ICommandCatalogContext,
  currentToken: string,
): (IFlagValueContext & { partial: string }) | null => {
  if (!currentToken.startsWith('-')) {
    return null;
  }
  const separatorIndex = currentToken.indexOf('=');
  if (separatorIndex === -1) {
    return null;
  }
  const flagToken = currentToken.slice(0, separatorIndex);
  const matchedFlag = findFlagSpec(collectAvailableFlags(catalogContext.visitedNodes), flagToken);
  if (!matchedFlag || getOptionArgumentCount(matchedFlag) === 0) {
    return null;
  }
  return {
    flag: matchedFlag,
    argumentIndex: 0,
    partial: currentToken.slice(separatorIndex + 1),
  };
};

const collectLookaheadEntries = (
  language: Language,
  context: ICompletionContext,
  symbols: ISymbolSnapshot,
): IShellCompletionEntry[] => {
  const stateCandidates = context.ancestors.flatMap((node) => [
    node.nextParseState,
    node.parseState,
  ]);
  const seenEntries = new Map<string, IShellCompletionEntry>();
  for (const stateId of stateCandidates) {
    const iterator = language.lookaheadIterator(stateId);
    if (!iterator) {
      continue;
    }
    try {
      for (const symbol of iterator) {
        const keywordEntry = KEYWORD_ENTRY_MAP.get(symbol);
        if (keywordEntry) {
          seenEntries.set(`keyword:${keywordEntry.label}`, keywordEntry);
          continue;
        }
        if (
          symbol === 'variable_name' &&
          (context.variableContext || context.isDeclarationContext)
        ) {
          for (const entry of createVariableEntries(symbols.variableNames, 4)) {
            seenEntries.set(`variable:${entry.label}`, entry);
          }
          continue;
        }
        if (symbol === 'word' && context.isCommandNameContext) {
          for (const entry of createCommandEntries(symbols.functionNames, 3)) {
            seenEntries.set(`command:${entry.label}`, entry);
          }
          continue;
        }
        if (symbol === 'test_operator') {
          for (const entry of TEST_OPERATOR_ENTRIES) {
            seenEntries.set(`operator:${entry.label}`, entry);
          }
        }
      }
    } finally {
      iterator.delete();
    }
    if (seenEntries.size > 0) {
      break;
    }
  }
  return [...seenEntries.values()];
};

const isTestCommand = (commandName: string | null): boolean =>
  commandName === 'test' || commandName === '[' || commandName === '[[';

const buildVariableEntries = (
  context: ICompletionContext,
  symbols: ISymbolSnapshot,
): IShellCompletionEntry[] => {
  const partial = context.variableContext?.partial ?? context.wordPrefix;
  const entries = [...createVariableEntries(symbols.variableNames, 2), ...COMMON_VARIABLE_ENTRIES];
  return filterEntries(entries, partial);
};

const buildCommandEntries = async (
  context: ICompletionContext,
  symbols: ISymbolSnapshot,
): Promise<IShellCompletionEntry[]> => {
  const localCommandEntries = createCommandEntries(symbols.functionNames, 1);
  const recentCommandEntries = createCommandEntries(symbols.recentCommandNames, 8);
  const commandCatalogRootEntries = await loadCommandCatalogRootEntries();
  return filterEntries(
    [
      ...localCommandEntries,
      ...recentCommandEntries,
      ...commandCatalogRootEntries,
      ...SHELL_COMMAND_ENTRIES,
    ],
    context.wordPrefix,
  );
};

const buildKeywordEntries = (context: ICompletionContext): IShellCompletionEntry[] =>
  filterEntries([...SHELL_KEYWORD_ENTRIES, ...SHELL_SNIPPET_ENTRIES], context.wordPrefix);

const buildArgumentEntries = async (
  context: ICompletionContext,
): Promise<IShellCompletionEntry[]> => {
  if (!context.activeCommandName || !context.activeCommandNode) {
    return [];
  }
  const normalizedCommandName = context.activeCommandName.toLowerCase();
  const partial = getCurrentTokenPrefix(context);
  if (isTestCommand(normalizedCommandName)) {
    return filterEntries(TEST_OPERATOR_ENTRIES, partial);
  }
  const commandTokens = collectCommandTokensBeforeCursor(
    context.activeCommandNode,
    context.cursorByteOffset,
    partial,
  );
  const catalogContext = await resolveCommandCatalogContext(commandTokens, partial);
  if (!catalogContext) {
    if (wrapperCommandSet.has(normalizedCommandName)) {
      return filterEntries(await loadCommandCatalogRootEntries(), partial);
    }
    return [];
  }
  if (catalogContext.wrapperAwaitingCommand) {
    return filterEntries(await loadCommandCatalogRootEntries(), partial);
  }
  const inlineFlagValueContext = resolveInlineFlagValueContext(
    catalogContext,
    context.currentToken,
  );
  if (inlineFlagValueContext) {
    return buildOptionValueEntries(
      inlineFlagValueContext.flag,
      inlineFlagValueContext.argumentIndex,
      inlineFlagValueContext.partial,
    );
  }
  if (catalogContext.awaitingFlagValue) {
    return buildOptionValueEntries(
      catalogContext.awaitingFlagValue.flag,
      catalogContext.awaitingFlagValue.argumentIndex,
      partial,
    );
  }
  if (!catalogContext.activeNode) {
    return [];
  }
  const positionalArgumentEntries = partial.startsWith('-')
    ? []
    : buildPositionalArgumentValueEntries(
        catalogContext.activeNode,
        catalogContext.positionalArgumentIndex,
        partial,
      );
  const flagEntries = collectAvailableFlags(catalogContext.visitedNodes).map(
    createFlagEntryFromSpec,
  );
  const subcommandEntries = (catalogContext.activeNode.subcommands ?? []).map(
    createCommandEntryFromCatalog,
  );
  const candidates = partial.startsWith('-')
    ? flagEntries
    : [...positionalArgumentEntries, ...subcommandEntries, ...flagEntries];
  return filterEntries(candidates, partial);
};

const dedupeEntries = (entries: IShellCompletionEntry[]): IShellCompletionEntry[] => {
  const uniqueEntries = new Map<string, IShellCompletionEntry>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.label}:${entry.insertText ?? entry.label}`;
    const existingEntry = uniqueEntries.get(key);
    if (!existingEntry || (entry.priority ?? 99) < (existingEntry.priority ?? 99)) {
      uniqueEntries.set(key, entry);
    }
  }
  return [...uniqueEntries.values()].sort((left, right) => {
    const priorityDelta = (left.priority ?? 99) - (right.priority ?? 99);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return left.label.localeCompare(right.label);
  });
};

const buildCompletionEntries = async (
  language: Language,
  context: ICompletionContext,
  symbols: ISymbolSnapshot,
): Promise<IShellCompletionEntry[]> => {
  if (context.isInComment) {
    return [];
  }
  const lookaheadEntries = collectLookaheadEntries(language, context, symbols);
  if (context.variableContext || context.isDeclarationContext) {
    return dedupeEntries([...lookaheadEntries, ...buildVariableEntries(context, symbols)]).slice(
      0,
      MAX_SUGGESTIONS,
    );
  }
  const entries: IShellCompletionEntry[] = [...lookaheadEntries];
  if (context.isCommandNameContext) {
    entries.push(...(await buildCommandEntries(context, symbols)));
    entries.push(...buildKeywordEntries(context));
  } else {
    entries.push(...(await buildArgumentEntries(context)));
    if (context.isInString) {
      entries.push(...buildVariableEntries(context, symbols));
    }
  }
  if (entries.length === 0 || context.wordPrefix.length > 0) {
    entries.push(...buildKeywordEntries(context));
  }
  return dedupeEntries(entries).slice(0, MAX_SUGGESTIONS);
};

const resolveInsertText = (entry: IShellCompletionEntry, context: ICompletionContext): string => {
  if (entry.insertText) {
    return entry.insertText;
  }
  if (entry.kind !== 'variable' || !context.variableContext?.withBraces) {
    return entry.label;
  }
  return context.lineSuffix.startsWith('}') ? entry.label : `${entry.label}}`;
};

const resolveCodeMirrorCompletionType = (
  kind: IShellCompletionEntry['kind'],
): Completion['type'] => {
  switch (kind) {
    case 'keyword':
      return 'keyword';
    case 'command':
      return 'function';
    case 'flag':
      return 'property';
    case 'value':
      return 'constant';
    case 'variable':
      return 'variable';
    case 'snippet':
      return 'snippet';
    default:
      return 'operator';
  }
};

// 当前补全上下文的「有效查询串」：与下方计算 from 偏移所用的前缀保持一致。
const resolveActiveQuery = (context: ICompletionContext): string =>
  context.variableContext
    ? context.variableContext.partial
    : context.optionPrefix || context.wordPrefix;

// 把模糊匹配得分折成 (-1, 1) 的微调量：仅在「同 priority 档位内」按匹配质量打破并列，
// 不跨档（priority 差 ≥ 1，而微调量绝对值 < 1），因此不会扰动既有的优先级排序。
const resolveScoreBoost = (entry: IShellCompletionEntry, query: string): number => {
  if (!query) {
    return 0;
  }
  const score = computeFuzzyScore(entry.label, query);
  return score === null ? 0 : Math.tanh(score / 64);
};

const toCodeMirrorCompletion = (
  entry: IShellCompletionEntry,
  context: ICompletionContext,
): Completion => {
  const insertText = resolveInsertText(entry, context);
  const completion: Completion = {
    label: entry.label,
    detail: entry.detail,
    info: entry.documentation,
    type: resolveCodeMirrorCompletionType(entry.kind),
    boost: -1 * (entry.priority ?? 99) + resolveScoreBoost(entry, resolveActiveQuery(context)),
  };

  if (entry.insertAsSnippet) {
    completion.apply = snippet(insertText);
    return completion;
  }

  if (insertText !== entry.label) {
    completion.apply = insertText;
  }

  return completion;
};

export const createShellCodeMirrorCompletionSource =
  () =>
  async (completionContext: CompletionContext): Promise<CompletionResult | null> => {
    try {
      const source = completionContext.state.doc.toString();
      const line = completionContext.state.doc.lineAt(completionContext.pos);
      const linePrefix = source.slice(line.from, completionContext.pos);
      const lineSuffix = source.slice(completionContext.pos, line.to);
      const cursorByteOffset = utf8ByteLengthOfRange(source, 0, completionContext.pos);
      const point = {
        row: Math.max(0, line.number - 1),
        column: getUtf8ByteLength(linePrefix),
      };
      const { language, entry } = await parseShellDocument(source);
      try {
        if (completionContext.aborted) {
          return null;
        }
        const shellContext = resolveCompletionContext(
          entry.tree,
          cursorByteOffset,
          linePrefix,
          lineSuffix,
          point,
        );
        const entries = await buildCompletionEntries(
          language,
          shellContext,
          getEntrySymbols(entry),
        );
        lastProviderErrorMessage = null;
        const prefixLength = shellContext.variableContext
          ? shellContext.variableContext.partial.length
          : shellContext.optionPrefix
            ? shellContext.optionPrefix.length
            : shellContext.wordPrefix.length;
        const from = Math.max(0, completionContext.pos - prefixLength);
        return {
          from,
          options: entries.map((completionEntry) =>
            toCodeMirrorCompletion(completionEntry, shellContext),
          ),
          validFor: /^[A-Za-z0-9_./:${}-]*$/u,
        };
      } finally {
        releaseParseEntry(entry);
      }
    } catch (error) {
      reportShellCompletionProviderError(error);
      return null;
    }
  };

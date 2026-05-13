import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  existsSync,
  realpathSync,
} from 'node:fs';
import {
  lstat,
  open,
  opendir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
} from 'node:path';
import { createInterface } from 'node:readline';

import { Lang, parse, registerDynamicLanguage, type SgNode } from '@ast-grep/napi';
import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { rgPath } from '@vscode/ripgrep';
import { z } from 'zod';

import { compactModelOutput, truncateModelOutputText } from '../models/model-output-budget.js';
import type { TMcpGatewayToolProfile } from './mcp-gateway.js';

type TFileToolErrorCode =
  | 'NO_WORKSPACE'
  | 'INVALID_PATH'
  | 'ENOENT'
  | 'EACCES'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'BINARY_FILE'
  | 'RG_NOT_FOUND'
  | 'RG_ERROR'
  | 'UNSUPPORTED_LANGUAGE'
  | 'PATCH_CONFLICT'
  | 'TIMEOUT';

interface IFileToolError {
  code: TFileToolErrorCode;
  message: string;
}

interface IResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

interface IReadFileWindowResult {
  path: string;
  totalLines: number;
  totalLinesKnown: boolean;
  totalBytes: number;
  encoding: 'utf8';
  startLine: number;
  endLine: number;
  content: string;
  truncated: boolean;
  nextStartLine: number | null;
  contentTruncated: boolean;
  error?: IFileToolError;
}

interface IGrepMatch {
  line: number;
  column?: number;
  content: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

interface IGrepFileMatches {
  path: string;
  matches: IGrepMatch[];
}

interface IGrepInFilesResult {
  totalMatches: number;
  matchesReturned: number;
  files: IGrepFileMatches[];
  truncated: boolean;
  scanStats: {
    filesScanned: number;
    filesMatched: number;
    bytesScanned: number;
  };
  error?: IFileToolError;
}

interface IListDirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink';
  sizeBytes?: number;
  lines?: number;
}

interface IListDirResult {
  path: string;
  entries: IListDirEntry[];
  totalEntries: number;
  truncated: boolean;
  error?: IFileToolError;
}

type TSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'method';

type TAstGrepLanguage = Lang | string;

interface ISymbolEntry {
  name: string;
  kind: TSymbolKind;
  path: string;
  startLine: number;
  endLine: number;
  preview: string;
}

interface ISearchSymbolsResult {
  query: string | null;
  symbols: ISymbolEntry[];
  totalSymbols: number;
  truncated: boolean;
  scanStats: {
    filesScanned: number;
    filesMatched: number;
    bytesScanned: number;
  };
  error?: IFileToolError;
}

interface IApplyFileEditsResult {
  path: string;
  summary: string;
  editCount: number;
  replacements: number;
  applied: boolean;
  beforeHash: string;
  afterHash: string;
  patch: {
    summary: string;
    files: Array<{
      path: string;
      originalHash: string;
      hunks: Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: string[];
      }>;
    }>;
  } | null;
  error?: IFileToolError;
}

interface IRgJsonText {
  text?: string;
}

interface IRgJsonSubmatch {
  start?: number;
  match?: IRgJsonText;
}

interface IRgJsonData {
  path?: IRgJsonText;
  lines?: IRgJsonText;
  line_number?: number;
  submatches?: IRgJsonSubmatch[];
}

interface IRgJsonEvent {
  type?: string;
  data?: IRgJsonData;
}

interface ILineCountCacheEntry {
  sizeBytes: number;
  mtimeMs: number;
  totalLines: number;
}

interface IGrepGlobPaths {
  include?: string[] | undefined;
  exclude?: string[] | undefined;
}

interface IJsonToolModelOutput {
  type: 'json';
  value: unknown;
}

const DEFAULT_READ_FILE_WINDOW_LIMIT = 200;
const MAX_READ_FILE_WINDOW_LIMIT = 500;
const READ_FILE_WINDOW_CONTENT_MAX_CHARS = 12_000;
const READ_FILE_EXACT_LINE_COUNT_MAX_BYTES = 512 * 1024;
const READ_FILE_LINE_COUNT_CACHE_MAX_ENTRIES = 200;
const FILE_PRIMITIVE_MODEL_OUTPUT_MAX_CHARS = 4_000;
const FILE_PRIMITIVE_MODEL_OUTPUT_MAX_STRING_CHARS = 2_000;
const DEFAULT_GREP_CONTEXT_LINES = 2;
const DEFAULT_GREP_MAX_MATCHES = 50;
const DEFAULT_GREP_MAX_FILES_SCANNED = 500;
const GREP_TIMEOUT_MS = 30_000;
const DEFAULT_LIST_DIR_MAX_ENTRIES = 200;
const MAX_LIST_DIR_MAX_ENTRIES = 1_000;
const DEFAULT_SYMBOL_MAX_SYMBOLS = 120;
const MAX_SYMBOL_MAX_SYMBOLS = 500;
const DEFAULT_SYMBOL_MAX_FILES_SCANNED = 200;
const SYMBOL_FILE_MAX_BYTES = 512 * 1024;
const BASH_AST_GREP_LANGUAGE = 'bash';
const SHELL_SYMBOL_FILE_PATTERN = /\.(?:sh|bash|dash|ksh|bats)$/iu;
const SHELL_SYMBOL_FILE_NAMES = new Set([
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.kshrc',
  'bashrc',
  'profile',
]);
const DEFAULT_EXCLUDE_PATTERNS = ['node_modules', '.git', 'dist', 'target'] as const;
const LIST_DIR_LINE_COUNT_MAX_BYTES = 128 * 1024;
const BINARY_SAMPLE_BYTES = 8 * 1024;
const RG_MAX_FILE_SIZE = '1M';
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;
const lineCountCache = new Map<string, ILineCountCacheEntry>();
const require = createRequire(import.meta.url);
let bashLanguageRegistrationState: 'pending' | 'registered' | 'unavailable' = 'pending';

const readFileWindowInputSchema = z.object({
  path: z.string().trim().min(1),
  startLine: z.number().int().min(1).default(1)
    .describe('1-indexed line number to start reading from.'),
  limit: z.number().int().min(1).max(MAX_READ_FILE_WINDOW_LIMIT)
    .default(DEFAULT_READ_FILE_WINDOW_LIMIT),
  includeLineNumbers: z.boolean().default(true),
});

const grepPathsSchema = z.union([
  z.string().trim().min(1),
  z.array(z.string().trim().min(1)).min(1),
  z.object({
    include: z.array(z.string().trim().min(1)).optional(),
    exclude: z.array(z.string().trim().min(1)).optional(),
  }),
]).default({ include: ['**/*'] });

const grepInFilesInputSchema = z.object({
  pattern: z.string().min(1),
  paths: grepPathsSchema,
  contextLines: z.number().int().min(0).max(10).default(DEFAULT_GREP_CONTEXT_LINES),
  maxMatches: z.number().int().min(1).max(200).default(DEFAULT_GREP_MAX_MATCHES),
  maxFilesScanned: z.number().int().min(1).max(2_000).default(DEFAULT_GREP_MAX_FILES_SCANNED),
  caseSensitive: z.boolean().default(false),
});

const listDirInputSchema = z.object({
  path: z.string().trim().min(1).default('.'),
  recursive: z.boolean().default(false),
  maxEntries: z.number().int().min(1).max(MAX_LIST_DIR_MAX_ENTRIES)
    .default(DEFAULT_LIST_DIR_MAX_ENTRIES),
  includePatterns: z.array(z.string().trim().min(1)).optional(),
  excludePatterns: z.array(z.string().trim().min(1)).default([...DEFAULT_EXCLUDE_PATTERNS]),
});

const searchSymbolsInputSchema = z.object({
  query: z.string().trim().min(1).optional(),
  paths: grepPathsSchema,
  maxSymbols: z.number().int().min(1).max(MAX_SYMBOL_MAX_SYMBOLS)
    .default(DEFAULT_SYMBOL_MAX_SYMBOLS),
  maxFilesScanned: z.number().int().min(1).max(1_000).default(DEFAULT_SYMBOL_MAX_FILES_SCANNED),
});

const applyFileEditInputSchema = z.object({
  op: z.literal('replace_string').default('replace_string'),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().default(false),
});

const applyFileEditsInputSchema = z.object({
  path: z.string().trim().min(1),
  edits: z.array(applyFileEditInputSchema).min(1).max(20),
  summary: z.string().trim().min(1).default('Agent 文件修改'),
});

type TReadFileWindowInput = z.infer<typeof readFileWindowInputSchema>;
type TGrepInFilesInput = z.infer<typeof grepInFilesInputSchema>;
type TListDirInput = z.infer<typeof listDirInputSchema>;
type TSearchSymbolsInput = z.infer<typeof searchSymbolsInputSchema>;
type TApplyFileEditsInput = z.infer<typeof applyFileEditsInputSchema>;

const toFileToolError = (code: TFileToolErrorCode, message: string): IFileToolError => ({
  code,
  message,
});

const getErrorCode = (error: unknown): string | null => (
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
);

const normalizeFsError = (error: unknown): IFileToolError => {
  const code = getErrorCode(error);

  if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR' || code === 'EISDIR') {
    return toFileToolError(code, error instanceof Error ? error.message : code);
  }

  return toFileToolError('INVALID_PATH', error instanceof Error ? error.message : String(error));
};

const normalizePathForModel = (value: string): string => value.replace(/\\/gu, '/');

const isPathInsideRoot = (workspaceRoot: string, targetPath: string): boolean => {
  const relativePath = relative(workspaceRoot, targetPath);

  return relativePath === ''
    || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
};

const createWorkspacePathResolver = (
  workspaceRootPath?: string,
): ((inputPath: string) => IResolvedWorkspacePath | { error: IFileToolError }) => {
  if (!workspaceRootPath) {
    return () => ({ error: toFileToolError('NO_WORKSPACE', '当前没有可用 workspaceRootPath。') });
  }

  if (!existsSync(workspaceRootPath)) {
    return () => ({ error: toFileToolError('NO_WORKSPACE', 'workspaceRootPath 不存在。') });
  }

  const workspaceRoot = realpathSync(resolve(workspaceRootPath));

  return (inputPath: string) => {
    const candidatePath = isAbsolute(inputPath)
      ? resolve(inputPath)
      : resolve(workspaceRoot, inputPath);

    if (!isPathInsideRoot(workspaceRoot, candidatePath)) {
      return {
        error: toFileToolError(
          'INVALID_PATH',
          '路径必须位于当前 workspace 内。',
        ),
      };
    }

    const relativePath = normalizePathForModel(relative(workspaceRoot, candidatePath) || '.');
    let operationPath = candidatePath;

    try {
      operationPath = realpathSync(candidatePath);

      if (!isPathInsideRoot(workspaceRoot, operationPath)) {
        return {
          error: toFileToolError(
            'INVALID_PATH',
            '路径的真实位置必须位于当前 workspace 内。',
          ),
        };
      }
    } catch (error) {
      if (getErrorCode(error) !== 'ENOENT') {
        return { error: normalizeFsError(error) };
      }
    }

    return {
      absolutePath: operationPath,
      relativePath,
    };
  };
};

const isResolvedPath = (
  value: IResolvedWorkspacePath | { error: IFileToolError },
): value is IResolvedWorkspacePath => !('error' in value);

const isBinaryFile = async (filePath: string): Promise<boolean> => {
  const handle = await open(filePath, 'r');

  try {
    const sample = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);

    for (let index = 0; index < bytesRead; index += 1) {
      if (sample[index] === 0) {
        return true;
      }
    }

    return false;
  } finally {
    await handle.close();
  }
};

const countFileLines = async (filePath: string): Promise<number> => {
  let totalLines = 0;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const _line of rl) {
      totalLines += 1;
    }
  } finally {
    rl.close();
  }

  return totalLines;
};

const readCachedLineCount = (
  filePath: string,
  sizeBytes: number,
  mtimeMs: number,
): number | null => {
  const cached = lineCountCache.get(filePath);

  if (!cached || cached.sizeBytes !== sizeBytes || cached.mtimeMs !== mtimeMs) {
    return null;
  }

  return cached.totalLines;
};

const writeCachedLineCount = (
  filePath: string,
  sizeBytes: number,
  mtimeMs: number,
  totalLines: number,
): void => {
  lineCountCache.set(filePath, {
    sizeBytes,
    mtimeMs,
    totalLines,
  });

  while (lineCountCache.size > READ_FILE_LINE_COUNT_CACHE_MAX_ENTRIES) {
    const firstKey = lineCountCache.keys().next().value;

    if (typeof firstKey !== 'string') {
      return;
    }

    lineCountCache.delete(firstKey);
  }
};

const resolveExactLineCount = async (
  filePath: string,
  sizeBytes: number,
  mtimeMs: number,
): Promise<number | null> => {
  const cached = readCachedLineCount(filePath, sizeBytes, mtimeMs);

  if (cached !== null) {
    return cached;
  }

  if (sizeBytes > READ_FILE_EXACT_LINE_COUNT_MAX_BYTES) {
    return null;
  }

  const totalLines = await countFileLines(filePath);

  writeCachedLineCount(filePath, sizeBytes, mtimeMs, totalLines);
  return totalLines;
};

const readWindowLines = async (
  filePath: string,
  startLine: number,
  limit: number,
): Promise<{
  lines: string[];
  lastReadLine: number;
  reachedEnd: boolean;
}> => {
  const lines: string[] = [];
  let lastReadLine = 0;
  let reachedEnd = true;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      lastReadLine += 1;

      if (lastReadLine < startLine) {
        continue;
      }

      if (lines.length < limit) {
        lines.push(line);
        continue;
      }

      reachedEnd = false;
      break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    lines,
    lastReadLine,
    reachedEnd,
  };
};

const formatWindowContent = (
  lines: readonly string[],
  startLine: number,
  includeLineNumbers: boolean,
): string => {
  if (!includeLineNumbers) {
    return lines.join('\n');
  }

  return lines
    .map((line, index) => `${String(startLine + index).padStart(5)} | ${line}`)
    .join('\n');
};

const readFileWindow = async (
  resolveWorkspacePath: (inputPath: string) => IResolvedWorkspacePath | { error: IFileToolError },
  input: TReadFileWindowInput,
): Promise<IReadFileWindowResult> => {
  const resolved = resolveWorkspacePath(input.path);

  if (!isResolvedPath(resolved)) {
    return {
      path: input.path,
      totalLines: 0,
      totalLinesKnown: false,
      totalBytes: 0,
      encoding: 'utf8',
      startLine: input.startLine,
      endLine: input.startLine - 1,
      content: '',
      truncated: false,
      nextStartLine: null,
      contentTruncated: false,
      error: resolved.error,
    };
  }

  try {
    const fileStat = await stat(resolved.absolutePath);

    if (!fileStat.isFile()) {
      return {
        path: resolved.relativePath,
        totalLines: 0,
        totalLinesKnown: false,
        totalBytes: fileStat.size,
        encoding: 'utf8',
        startLine: input.startLine,
        endLine: input.startLine - 1,
        content: '',
        truncated: false,
        nextStartLine: null,
        contentTruncated: false,
        error: toFileToolError('EISDIR', '目标路径不是普通文本文件。'),
      };
    }

    if (await isBinaryFile(resolved.absolutePath)) {
      return {
        path: resolved.relativePath,
        totalLines: 0,
        totalLinesKnown: false,
        totalBytes: fileStat.size,
        encoding: 'utf8',
        startLine: input.startLine,
        endLine: input.startLine - 1,
        content: '',
        truncated: false,
        nextStartLine: null,
        contentTruncated: false,
        error: toFileToolError('BINARY_FILE', '检测到二进制文件，已拒绝读取。'),
      };
    }

    const exactTotalLines = await resolveExactLineCount(
      resolved.absolutePath,
      fileStat.size,
      fileStat.mtimeMs,
    );
    const window = await readWindowLines(resolved.absolutePath, input.startLine, input.limit);
    const lines = window.lines;
    let totalLines = exactTotalLines ?? -1;
    let totalLinesKnown = exactTotalLines !== null;

    if (!totalLinesKnown && window.reachedEnd) {
      totalLines = window.lastReadLine;
      totalLinesKnown = true;
      writeCachedLineCount(resolved.absolutePath, fileStat.size, fileStat.mtimeMs, totalLines);
    }

    const startLine = lines.length > 0
      ? input.startLine
      : totalLinesKnown
        ? Math.min(input.startLine, totalLines + 1)
        : input.startLine;
    const endLine = lines.length > 0 ? startLine + lines.length - 1 : startLine - 1;
    const hasMore = lines.length > 0 && (
      totalLinesKnown
        ? endLine < totalLines
        : !window.reachedEnd
    );
    const content = formatWindowContent(lines, startLine, input.includeLineNumbers);
    const contentPreview = truncateModelOutputText(content, READ_FILE_WINDOW_CONTENT_MAX_CHARS);

    return {
      path: resolved.relativePath,
      totalLines,
      totalLinesKnown,
      totalBytes: fileStat.size,
      encoding: 'utf8',
      startLine,
      endLine,
      content: contentPreview.text,
      truncated: hasMore,
      nextStartLine: hasMore ? endLine + 1 : null,
      contentTruncated: contentPreview.truncated,
    };
  } catch (error) {
    return {
      path: resolved.relativePath,
      totalLines: 0,
      totalLinesKnown: false,
      totalBytes: 0,
      encoding: 'utf8',
      startLine: input.startLine,
      endLine: input.startLine - 1,
      content: '',
      truncated: false,
      nextStartLine: null,
      contentTruncated: false,
      error: normalizeFsError(error),
    };
  }
};

const matchesPattern = (
  relativePath: string,
  name: string,
  pattern: string,
): boolean => {
  const normalizedPattern = normalizePathForModel(pattern);
  const normalizedPath = normalizePathForModel(relativePath);

  if (!normalizedPattern.includes('*') && !normalizedPattern.includes('?')) {
    return name === normalizedPattern
      || normalizedPath === normalizedPattern
      || normalizedPath.split('/').includes(normalizedPattern);
  }

  return matchesGlob(normalizedPath, normalizedPattern) || matchesGlob(name, normalizedPattern);
};

const matchesAnyPattern = (
  relativePath: string,
  name: string,
  patterns: readonly string[] | undefined,
): boolean => Boolean(patterns?.some((pattern) => matchesPattern(relativePath, name, pattern)));

const getEntryType = (entry: { isDirectory: () => boolean; isSymbolicLink: () => boolean }): 'file' | 'dir' | 'symlink' => {
  if (entry.isSymbolicLink()) {
    return 'symlink';
  }

  return entry.isDirectory() ? 'dir' : 'file';
};

const countLinesIfSmallTextFile = async (
  absolutePath: string,
  sizeBytes: number,
): Promise<number | undefined> => {
  if (sizeBytes > LIST_DIR_LINE_COUNT_MAX_BYTES) {
    return undefined;
  }

  if (await isBinaryFile(absolutePath)) {
    return undefined;
  }

  return await countFileLines(absolutePath);
};

const listDir = async (
  resolveWorkspacePath: (inputPath: string) => IResolvedWorkspacePath | { error: IFileToolError },
  input: TListDirInput,
): Promise<IListDirResult> => {
  const resolved = resolveWorkspacePath(input.path);

  if (!isResolvedPath(resolved)) {
    return {
      path: input.path,
      entries: [],
      totalEntries: 0,
      truncated: false,
      error: resolved.error,
    };
  }

  try {
    const rootStat = await stat(resolved.absolutePath);

    if (!rootStat.isDirectory()) {
      return {
        path: resolved.relativePath,
        entries: [],
        totalEntries: 0,
        truncated: false,
        error: toFileToolError('ENOTDIR', '目标路径不是目录。'),
      };
    }

    const entries: IListDirEntry[] = [];
    let totalEntries = 0;
    const queue: IResolvedWorkspacePath[] = [resolved];

    while (queue.length > 0) {
      const current = queue.shift();

      if (!current) {
        continue;
      }

      const dir = await opendir(current.absolutePath);

      try {
        for await (const dirent of dir) {
          const absolutePath = resolve(current.absolutePath, dirent.name);
          const relativePath = normalizePathForModel(relative(resolved.absolutePath, absolutePath));
          const workspaceRelativePath = normalizePathForModel(
            resolved.relativePath === '.'
              ? relativePath
              : `${resolved.relativePath}/${relativePath}`,
          );
          const type = getEntryType(dirent);

          if (matchesAnyPattern(workspaceRelativePath, dirent.name, input.excludePatterns)) {
            continue;
          }

          if (
            input.includePatterns
            && !matchesAnyPattern(workspaceRelativePath, dirent.name, input.includePatterns)
            && type !== 'dir'
          ) {
            continue;
          }

          totalEntries += 1;

          if (entries.length < input.maxEntries) {
            const entry: IListDirEntry = {
              name: dirent.name,
              path: workspaceRelativePath,
              type,
            };

            if (type === 'file') {
              const fileStat = await lstat(absolutePath);
              const lines = await countLinesIfSmallTextFile(absolutePath, fileStat.size);

              entry.sizeBytes = fileStat.size;
              if (lines !== undefined) {
                entry.lines = lines;
              }
            }

            entries.push(entry);
          }

          if (input.recursive && type === 'dir' && entries.length < input.maxEntries) {
            queue.push({
              absolutePath,
              relativePath: workspaceRelativePath,
            });
          }
        }
      } finally {
        await dir.close().catch(() => undefined);
      }

      if (!input.recursive || entries.length >= input.maxEntries) {
        break;
      }
    }

    return {
      path: resolved.relativePath,
      entries,
      totalEntries,
      truncated: totalEntries > entries.length || queue.length > 0,
    };
  } catch (error) {
    return {
      path: resolved.relativePath,
      entries: [],
      totalEntries: 0,
      truncated: false,
      error: normalizeFsError(error),
    };
  }
};

const spawnRg = (
  args: readonly string[],
  options: { cwd?: string } = {},
) => spawn(rgPath, args, {
  ...(options.cwd ? { cwd: options.cwd } : {}),
  windowsHide: true,
});

const readProcessLines = async (
  args: readonly string[],
  options: { cwd?: string; maxLines: number },
): Promise<{ lines: string[]; truncated: boolean; error?: IFileToolError }> =>
  await new Promise((resolvePromise) => {
    const proc = spawnRg(args, options.cwd ? { cwd: options.cwd } : {});
    const lines: string[] = [];
    let stdoutBuffer = '';
    let stderr = '';
    let truncated = false;

    proc.on('error', (error) => {
      resolvePromise({
        lines,
        truncated,
        error: getErrorCode(error) === 'ENOENT'
          ? toFileToolError('RG_NOT_FOUND', '未找到 rg 可执行文件。')
          : normalizeFsError(error),
      });
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const parts = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = parts.pop() ?? '';

      for (const line of parts) {
        if (!line) {
          continue;
        }

        if (lines.length >= options.maxLines) {
          truncated = true;
          proc.kill();
          return;
        }

        lines.push(line);
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('close', (code) => {
      if (stdoutBuffer && lines.length < options.maxLines) {
        lines.push(stdoutBuffer);
      } else if (stdoutBuffer) {
        truncated = true;
      }

      if (code === 0 || code === 1 || truncated) {
        resolvePromise({ lines, truncated });
        return;
      }

      resolvePromise({
        lines,
        truncated,
        error: toFileToolError('RG_ERROR', stderr.trim() || `rg exited with code ${code}`),
      });
    });
  });

const createRgFileArgsForPath = (
  resolved: IResolvedWorkspacePath,
): string[] => [resolved.absolutePath];

const createRgFileArgsForGlob = (
  input: IGrepGlobPaths,
): string[] => [
  ...(input.include ?? ['**/*']).flatMap((pattern) => ['--glob', pattern]),
  ...(input.exclude ?? [...DEFAULT_EXCLUDE_PATTERNS]).flatMap((pattern) => ['--glob', `!${pattern}`]),
  '.',
];

const resolveGrepFiles = async (
  resolveWorkspacePath: (inputPath: string) => IResolvedWorkspacePath | { error: IFileToolError },
  workspaceRootPath: string,
  input: TGrepInFilesInput,
): Promise<{
  files: IResolvedWorkspacePath[];
  truncated: boolean;
  bytesScanned: number;
  error?: IFileToolError;
}> => {
  const paths = input.paths;
  const maxLines = input.maxFilesScanned + 1;
  const fileCandidates: IResolvedWorkspacePath[] = [];
  let truncated = false;

  if (typeof paths === 'string' || Array.isArray(paths)) {
    const rawPaths = Array.isArray(paths) ? paths : [paths];

    for (const rawPath of rawPaths) {
      const resolved = resolveWorkspacePath(rawPath);

      if (!isResolvedPath(resolved)) {
        return { files: [], truncated: false, bytesScanned: 0, error: resolved.error };
      }

      const targetStat = await stat(resolved.absolutePath).catch(() => null);

      if (!targetStat) {
        return {
          files: [],
          truncated: false,
          bytesScanned: 0,
          error: toFileToolError('ENOENT', `路径不存在：${rawPath}`),
        };
      }

      if (targetStat.isFile()) {
        fileCandidates.push(resolved);
        continue;
      }

      if (!targetStat.isDirectory()) {
        continue;
      }

      const fileList = await readProcessLines(
        ['--files', '--max-filesize', RG_MAX_FILE_SIZE, ...createRgFileArgsForPath(resolved)],
        { maxLines },
      );

      if (fileList.error) {
        return { files: [], truncated: false, bytesScanned: 0, error: fileList.error };
      }

      truncated ||= fileList.truncated;
      for (const filePath of fileList.lines) {
        const resolvedFile = resolveWorkspacePath(filePath);

        if (isResolvedPath(resolvedFile)) {
          fileCandidates.push(resolvedFile);
        }
      }
    }
  } else {
    const fileList = await readProcessLines(
      ['--files', '--max-filesize', RG_MAX_FILE_SIZE, ...createRgFileArgsForGlob(paths)],
      { cwd: workspaceRootPath, maxLines },
    );

    if (fileList.error) {
      return { files: [], truncated: false, bytesScanned: 0, error: fileList.error };
    }

    truncated = fileList.truncated;
    for (const filePath of fileList.lines) {
      const resolvedFile = resolveWorkspacePath(filePath);

      if (isResolvedPath(resolvedFile)) {
        fileCandidates.push(resolvedFile);
      }
    }
  }

  const uniqueFiles = new Map<string, IResolvedWorkspacePath>();

  for (const file of fileCandidates) {
    if (uniqueFiles.size >= input.maxFilesScanned) {
      truncated = true;
      break;
    }

    uniqueFiles.set(file.absolutePath, file);
  }

  let bytesScanned = 0;
  for (const file of uniqueFiles.values()) {
    const fileStat = await stat(file.absolutePath).catch(() => null);
    bytesScanned += fileStat?.size ?? 0;
  }

  return {
    files: [...uniqueFiles.values()],
    truncated,
    bytesScanned,
  };
};

const getOrCreateGrepFile = (
  files: Map<string, IGrepFileMatches>,
  filePath: string,
): IGrepFileMatches => {
  const existing = files.get(filePath);

  if (existing) {
    return existing;
  }

  const created: IGrepFileMatches = {
    path: filePath,
    matches: [],
  };

  files.set(filePath, created);
  return created;
};

const readRgText = (text: IRgJsonText | undefined): string => text?.text?.replace(/\r?\n$/u, '') ?? '';

const parseRgJsonLine = (line: string): IRgJsonEvent | null => {
  try {
    return JSON.parse(line) as IRgJsonEvent;
  } catch {
    return null;
  }
};

const grepInResolvedFiles = async (
  input: TGrepInFilesInput,
  filesToScan: readonly IResolvedWorkspacePath[],
): Promise<Pick<IGrepInFilesResult, 'files' | 'matchesReturned' | 'truncated' | 'error'>> =>
  await new Promise((resolvePromise) => {
    if (filesToScan.length === 0) {
      resolvePromise({
        files: [],
        matchesReturned: 0,
        truncated: false,
      });
      return;
    }

    const relativePathByAbsolutePath = new Map(
      filesToScan.map((file) => [file.absolutePath, file.relativePath]),
    );
    const args = [
      '--json',
      '--line-number',
      '--column',
      '--context',
      String(input.contextLines),
      '--max-filesize',
      RG_MAX_FILE_SIZE,
      ...(input.caseSensitive ? [] : ['-i']),
      '--',
      input.pattern,
      ...filesToScan.map((file) => file.absolutePath),
    ];
    const proc = spawnRg(args);
    const files = new Map<string, IGrepFileMatches>();
    const beforeContext = new Map<string, string[]>();
    const lastMatch = new Map<string, IGrepMatch>();
    let stdoutBuffer = '';
    let stderr = '';
    let matchesReturned = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, GREP_TIMEOUT_MS);

    const settle = (result: Pick<IGrepInFilesResult, 'files' | 'matchesReturned' | 'truncated' | 'error'>): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolvePromise(result);
    };

    const handleContext = (event: IRgJsonEvent): void => {
      const pathText = event.data?.path?.text;
      const lineNumber = event.data?.line_number;

      if (!pathText || typeof lineNumber !== 'number') {
        return;
      }

      const relativePath = relativePathByAbsolutePath.get(resolve(pathText))
        ?? normalizePathForModel(pathText);
      const line = readRgText(event.data?.lines);
      const recentMatch = lastMatch.get(relativePath);

      if (recentMatch && lineNumber > recentMatch.line) {
        recentMatch.contextAfter ??= [];

        if (recentMatch.contextAfter.length < input.contextLines) {
          recentMatch.contextAfter.push(line);
        }

        return;
      }

      const context = beforeContext.get(relativePath) ?? [];
      context.push(line);
      beforeContext.set(relativePath, context.slice(-input.contextLines));
    };

    const handleMatch = (event: IRgJsonEvent): void => {
      const pathText = event.data?.path?.text;
      const lineNumber = event.data?.line_number;

      if (!pathText || typeof lineNumber !== 'number') {
        return;
      }

      if (matchesReturned >= input.maxMatches) {
        truncated = true;
        proc.kill();
        return;
      }

      const relativePath = relativePathByAbsolutePath.get(resolve(pathText))
        ?? normalizePathForModel(pathText);
      const file = getOrCreateGrepFile(files, relativePath);
      const column = event.data?.submatches?.[0]?.start;
      const match: IGrepMatch = {
        line: lineNumber,
        ...(typeof column === 'number' ? { column: column + 1 } : {}),
        content: readRgText(event.data?.lines),
      };
      const contextBefore = beforeContext.get(relativePath);

      if (contextBefore && contextBefore.length > 0) {
        match.contextBefore = contextBefore;
      }

      file.matches.push(match);
      lastMatch.set(relativePath, match);
      beforeContext.set(relativePath, []);
      matchesReturned += 1;
    };

    const handleLine = (line: string): void => {
      const event = parseRgJsonLine(line);

      if (!event) {
        return;
      }

      if (event.type === 'context') {
        handleContext(event);
        return;
      }

      if (event.type === 'match') {
        handleMatch(event);
      }
    };

    proc.on('error', (error) => {
      settle({
        files: [...files.values()],
        matchesReturned,
        truncated,
        error: getErrorCode(error) === 'ENOENT'
          ? toFileToolError('RG_NOT_FOUND', '未找到 rg 可执行文件。')
          : normalizeFsError(error),
      });
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() ?? '';
      lines.filter((line) => line.length > 0).forEach(handleLine);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('close', (code) => {
      if (stdoutBuffer) {
        handleLine(stdoutBuffer);
      }

      if (timedOut) {
        settle({
          files: [...files.values()],
          matchesReturned,
          truncated: true,
          error: toFileToolError('TIMEOUT', 'grep_in_files 执行超时。'),
        });
        return;
      }

      if (code === 0 || code === 1 || truncated) {
        settle({
          files: [...files.values()],
          matchesReturned,
          truncated,
        });
        return;
      }

      settle({
        files: [...files.values()],
        matchesReturned,
        truncated,
        error: toFileToolError('RG_ERROR', stderr.trim() || `rg exited with code ${code}`),
      });
    });
  });

const grepInFiles = async (
  resolveWorkspacePath: (inputPath: string) => IResolvedWorkspacePath | { error: IFileToolError },
  workspaceRootPath: string,
  input: TGrepInFilesInput,
): Promise<IGrepInFilesResult> => {
  const resolvedFiles = await resolveGrepFiles(resolveWorkspacePath, workspaceRootPath, input);

  if (resolvedFiles.error) {
    return {
      totalMatches: 0,
      matchesReturned: 0,
      files: [],
      truncated: false,
      scanStats: {
        filesScanned: 0,
        filesMatched: 0,
        bytesScanned: 0,
      },
      error: resolvedFiles.error,
    };
  }

  const grepResult = await grepInResolvedFiles(input, resolvedFiles.files);

  return {
    totalMatches: resolvedFiles.truncated || grepResult.truncated ? -1 : grepResult.matchesReturned,
    matchesReturned: grepResult.matchesReturned,
    files: grepResult.files,
    truncated: resolvedFiles.truncated || grepResult.truncated,
    scanStats: {
      filesScanned: resolvedFiles.files.length,
      filesMatched: grepResult.files.length,
      bytesScanned: resolvedFiles.bytesScanned,
    },
    ...(grepResult.error ? { error: grepResult.error } : {}),
  };
};

const resolveTreeSitterBashLibraryPath = (): string | null => {
  try {
    const packageJsonPath = require.resolve('tree-sitter-bash/package.json');
    const packageRoot = dirname(packageJsonPath);
    const libraryPath = join(
      packageRoot,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'tree-sitter-bash.node',
    );

    return existsSync(libraryPath) ? libraryPath : null;
  } catch {
    return null;
  }
};

const ensureBashAstGrepLanguageRegistered = (): boolean => {
  if (bashLanguageRegistrationState === 'registered') {
    return true;
  }

  if (bashLanguageRegistrationState === 'unavailable') {
    return false;
  }

  const libraryPath = resolveTreeSitterBashLibraryPath();

  if (!libraryPath) {
    bashLanguageRegistrationState = 'unavailable';
    return false;
  }

  try {
    registerDynamicLanguage({
      [BASH_AST_GREP_LANGUAGE]: {
        libraryPath,
        extensions: ['sh', 'bash', 'dash', 'ksh', 'bats'],
        languageSymbol: 'tree_sitter_bash',
      },
    });
    bashLanguageRegistrationState = 'registered';
    return true;
  } catch {
    bashLanguageRegistrationState = 'unavailable';
    return false;
  }
};

const hasShellShebang = (content: string): boolean => {
  const firstLine = content.split(/\r?\n/u, 1)[0]?.toLocaleLowerCase() ?? '';

  return firstLine.startsWith('#!') && /\b(?:ba|da|k)?sh\b/u.test(firstLine);
};

const isShellSymbolPath = (path: string): boolean => {
  const normalizedPath = path.toLowerCase().replace(/\\/gu, '/');
  const fileName = normalizedPath.split('/').filter((part) => part.length > 0).at(-1) ?? normalizedPath;

  return SHELL_SYMBOL_FILE_PATTERN.test(normalizedPath) || SHELL_SYMBOL_FILE_NAMES.has(fileName);
};

const getAstGrepLanguageFromPath = (path: string): TAstGrepLanguage | null => {
  const normalizedPath = path.toLowerCase();

  if (
    normalizedPath.endsWith('.ts')
    || normalizedPath.endsWith('.mts')
    || normalizedPath.endsWith('.cts')
  ) {
    return Lang.TypeScript;
  }

  if (normalizedPath.endsWith('.tsx') || normalizedPath.endsWith('.jsx')) {
    return Lang.Tsx;
  }

  if (
    normalizedPath.endsWith('.js')
    || normalizedPath.endsWith('.mjs')
    || normalizedPath.endsWith('.cjs')
  ) {
    return Lang.JavaScript;
  }

  if (isShellSymbolPath(path) && ensureBashAstGrepLanguageRegistered()) {
    return BASH_AST_GREP_LANGUAGE;
  }

  return null;
};

const getAstGrepLanguage = (path: string, content: string): TAstGrepLanguage | null => {
  const language = getAstGrepLanguageFromPath(path);

  if (language) {
    return language;
  }

  return hasShellShebang(content) && ensureBashAstGrepLanguageRegistered()
    ? BASH_AST_GREP_LANGUAGE
    : null;
};

const isVueFilePath = (path: string): boolean => path.toLowerCase().endsWith('.vue');

const countLineBreaks = (value: string): number => (value.match(/\n/gu) ?? []).length;

const extractVueScriptBlocks = (content: string): Array<{
  content: string;
  startLineOffset: number;
  language: TAstGrepLanguage;
}> => {
  const blocks: Array<{
    content: string;
    startLineOffset: number;
    language: TAstGrepLanguage;
  }> = [];
  const scriptPattern = /<script\b(?<attrs>[^>]*)>(?<content>[\s\S]*?)<\/script>/giu;

  for (const match of content.matchAll(scriptPattern)) {
    const body = match.groups?.content ?? '';
    const attrs = match.groups?.attrs ?? '';
    const fullMatch = match[0] ?? '';
    const matchIndex = match.index ?? 0;
    const bodyOffset = fullMatch.indexOf(body);
    const bodyIndex = bodyOffset >= 0 ? matchIndex + bodyOffset : matchIndex;
    const language = /lang\s*=\s*["']tsx["']/iu.test(attrs)
      ? Lang.Tsx
      : Lang.TypeScript;

    if (body.trim().length === 0) {
      continue;
    }

    blocks.push({
      content: body,
      startLineOffset: countLineBreaks(content.slice(0, bodyIndex)),
      language,
    });
  }

  return blocks;
};

const firstChildTextByKind = (
  node: SgNode,
  kinds: readonly string[],
): string | null => {
  for (const child of node.children()) {
    if (kinds.includes(String(child.kind()))) {
      return child.text();
    }
  }

  return null;
};

const getSymbolKind = (nodeKind: string): TSymbolKind | null => {
  switch (nodeKind) {
    case 'function_declaration':
    case 'function_definition':
      return 'function';
    case 'class_declaration':
      return 'class';
    case 'interface_declaration':
      return 'interface';
    case 'type_alias_declaration':
      return 'type';
    case 'variable_declarator':
    case 'variable_assignment':
      return 'variable';
    case 'method_definition':
      return 'method';
    default:
      return null;
  }
};

const getSymbolName = (node: SgNode, kind: TSymbolKind): string | null => {
  if (String(node.kind()) === 'function_definition') {
    return firstChildTextByKind(node, ['word']);
  }

  if (String(node.kind()) === 'variable_assignment') {
    return firstChildTextByKind(node, ['variable_name', 'subscript']);
  }

  if (kind === 'class' || kind === 'interface' || kind === 'type') {
    return firstChildTextByKind(node, ['type_identifier']);
  }

  if (kind === 'method') {
    return firstChildTextByKind(node, ['property_identifier', 'identifier']);
  }

  return firstChildTextByKind(node, ['identifier']);
};

const normalizeSymbolPreview = (value: string): string =>
  value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .slice(0, 180);

const collectSymbolsFromNode = (
  node: SgNode,
  path: string,
  lineOffset: number,
  symbols: ISymbolEntry[],
): void => {
  const symbolKind = getSymbolKind(String(node.kind()));

  if (symbolKind) {
    const name = getSymbolName(node, symbolKind);
    if (name) {
      const range = node.range();
      symbols.push({
        name,
        kind: symbolKind,
        path,
        startLine: range.start.line + lineOffset + 1,
        endLine: range.end.line + lineOffset + 1,
        preview: normalizeSymbolPreview(node.text()),
      });
    }
  }

  for (const child of node.children()) {
    collectSymbolsFromNode(child, path, lineOffset, symbols);
  }
};

const parseSymbolsFromContent = (
  path: string,
  content: string,
): ISymbolEntry[] | IFileToolError => {
  const parseTargets = isVueFilePath(path)
    ? extractVueScriptBlocks(content)
    : [{
        content,
        startLineOffset: 0,
        language: getAstGrepLanguage(path, content),
      }];
  const symbols: ISymbolEntry[] = [];

  for (const target of parseTargets) {
    if (!target.language) {
      return toFileToolError('UNSUPPORTED_LANGUAGE', '当前文件类型暂不支持 Symbol 导航。');
    }

    try {
      collectSymbolsFromNode(
        parse(target.language, target.content).root(),
        path,
        target.startLineOffset,
        symbols,
      );
    } catch (error) {
      return toFileToolError(
        'INVALID_PATH',
        error instanceof Error ? error.message : 'Symbol 解析失败。',
      );
    }
  }

  return symbols;
};

const matchesSymbolQuery = (symbol: ISymbolEntry, query: string | undefined): boolean => {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLocaleLowerCase();

  return symbol.name.toLocaleLowerCase().includes(normalizedQuery)
    || symbol.preview.toLocaleLowerCase().includes(normalizedQuery);
};

const searchSymbols = async (
  resolveWorkspacePath: (inputPath: string) => IResolvedWorkspacePath | { error: IFileToolError },
  workspaceRootPath: string,
  input: TSearchSymbolsInput,
): Promise<ISearchSymbolsResult> => {
  const resolvedFiles = await resolveGrepFiles(resolveWorkspacePath, workspaceRootPath, {
    pattern: input.query ?? '.',
    paths: input.paths,
    contextLines: 0,
    maxMatches: input.maxSymbols,
    maxFilesScanned: input.maxFilesScanned,
    caseSensitive: false,
  });

  if (resolvedFiles.error) {
    return {
      query: input.query ?? null,
      symbols: [],
      totalSymbols: 0,
      truncated: false,
      scanStats: {
        filesScanned: 0,
        filesMatched: 0,
        bytesScanned: 0,
      },
      error: resolvedFiles.error,
    };
  }

  const symbols: ISymbolEntry[] = [];
  let filesMatched = 0;
  let bytesScanned = 0;
  let truncated = resolvedFiles.truncated;

  for (const file of resolvedFiles.files) {
    const fileStat = await stat(file.absolutePath).catch(() => null);

    if (!fileStat || !fileStat.isFile()) {
      continue;
    }

    bytesScanned += fileStat.size;

    if (fileStat.size > SYMBOL_FILE_MAX_BYTES || await isBinaryFile(file.absolutePath)) {
      continue;
    }

    const content = await readFile(file.absolutePath, 'utf8');
    const language = isVueFilePath(file.relativePath)
      ? Lang.TypeScript
      : getAstGrepLanguage(file.relativePath, content);

    if (!language) {
      continue;
    }

    const parsedSymbols = parseSymbolsFromContent(file.relativePath, content);

    if (!Array.isArray(parsedSymbols)) {
      continue;
    }

    const matchedSymbols = parsedSymbols.filter((symbol) => matchesSymbolQuery(symbol, input.query));

    if (matchedSymbols.length > 0) {
      filesMatched += 1;
    }

    for (const symbol of matchedSymbols) {
      if (symbols.length >= input.maxSymbols) {
        truncated = true;
        break;
      }

      symbols.push(symbol);
    }

    if (symbols.length >= input.maxSymbols) {
      break;
    }
  }

  return {
    query: input.query ?? null,
    symbols,
    totalSymbols: truncated ? -1 : symbols.length,
    truncated,
    scanStats: {
      filesScanned: resolvedFiles.files.length,
      filesMatched,
      bytesScanned,
    },
  };
};

const hashText = (value: string): string => {
  let hash = FNV64_OFFSET;

  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * FNV64_PRIME) & FNV64_MASK;
  }

  return `fnv64:${hash.toString(16).padStart(16, '0')}`;
};

const splitPatchLines = (value: string): string[] => {
  const normalized = value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  const withoutTrailingLineBreak = normalized.endsWith('\n')
    ? normalized.slice(0, -1)
    : normalized;

  return withoutTrailingLineBreak.length > 0 ? withoutTrailingLineBreak.split('\n') : [];
};

const countLines = (value: string): number => Math.max(splitPatchLines(value).length, 1);

const buildFullReplaceLines = (original: string, updated: string): string[] => [
  ...splitPatchLines(original).map((line) => `-${line}`),
  ...splitPatchLines(updated).map((line) => `+${line}`),
  ...(updated.endsWith('\n') ? ['+'] : []),
];

const countOccurrences = (content: string, needle: string): number => {
  let count = 0;
  let offset = 0;

  while (offset <= content.length) {
    const nextIndex = content.indexOf(needle, offset);

    if (nextIndex < 0) {
      break;
    }

    count += 1;
    offset = nextIndex + needle.length;
  }

  return count;
};

const replaceOnce = (content: string, oldString: string, newString: string): string => {
  const index = content.indexOf(oldString);

  if (index < 0) {
    return content;
  }

  return `${content.slice(0, index)}${newString}${content.slice(index + oldString.length)}`;
};

const applyFileEdits = async (
  resolveWorkspacePath: (inputPath: string) => IResolvedWorkspacePath | { error: IFileToolError },
  input: TApplyFileEditsInput,
): Promise<IApplyFileEditsResult> => {
  const resolved = resolveWorkspacePath(input.path);
  const emptyResult = (
    path: string,
    error: IFileToolError,
  ): IApplyFileEditsResult => ({
    path,
    summary: input.summary,
    editCount: input.edits.length,
    replacements: 0,
    applied: false,
    beforeHash: '',
    afterHash: '',
    patch: null,
    error,
  });

  if (!isResolvedPath(resolved)) {
    return emptyResult(input.path, resolved.error);
  }

  try {
    const fileStat = await stat(resolved.absolutePath);

    if (!fileStat.isFile()) {
      return emptyResult(resolved.relativePath, toFileToolError('EISDIR', '目标路径不是普通文本文件。'));
    }

    if (await isBinaryFile(resolved.absolutePath)) {
      return emptyResult(resolved.relativePath, toFileToolError('BINARY_FILE', '检测到二进制文件，已拒绝生成 Patch。'));
    }

    const original = await readFile(resolved.absolutePath, 'utf8');
    let updated = original;
    let replacements = 0;

    for (const edit of input.edits) {
      const occurrences = countOccurrences(updated, edit.oldString);

      if (occurrences === 0) {
        return emptyResult(resolved.relativePath, toFileToolError('PATCH_CONFLICT', 'oldString 与当前文件内容不匹配。'));
      }

      if (occurrences > 1 && !edit.replaceAll) {
        return emptyResult(
          resolved.relativePath,
          toFileToolError('PATCH_CONFLICT', 'oldString 在当前文件中出现多次，请扩大上下文或设置 replaceAll。'),
        );
      }

      updated = edit.replaceAll
        ? updated.split(edit.oldString).join(edit.newString)
        : replaceOnce(updated, edit.oldString, edit.newString);
      replacements += edit.replaceAll ? occurrences : 1;
    }

    const beforeHash = hashText(original);
    const afterHash = hashText(updated);
    await writeFile(resolved.absolutePath, updated, 'utf8');

    return {
      path: resolved.relativePath,
      summary: input.summary,
      editCount: input.edits.length,
      replacements,
      applied: true,
      beforeHash,
      afterHash,
      patch: {
        summary: input.summary,
        files: [{
          path: resolved.absolutePath,
          originalHash: beforeHash,
          hunks: [{
            oldStart: 1,
            oldLines: countLines(original),
            newStart: 1,
            newLines: countLines(updated),
            lines: buildFullReplaceLines(original, updated),
          }],
        }],
      },
    };
  } catch (error) {
    return emptyResult(resolved.relativePath, normalizeFsError(error));
  }
};

const createJsonToolModelOutput = (value: unknown): IJsonToolModelOutput => ({
  type: 'json',
  value,
});

const createFileToolModelOutput = (output: unknown): IJsonToolModelOutput => createJsonToolModelOutput(
  compactModelOutput(output, {
    maxTotalChars: FILE_PRIMITIVE_MODEL_OUTPUT_MAX_CHARS,
    maxStringChars: FILE_PRIMITIVE_MODEL_OUTPUT_MAX_STRING_CHARS,
    maxArrayItems: 40,
    maxObjectKeys: 40,
    maxDepth: 6,
  }),
);

const preserveReadFileWindowModelOutput = (output: unknown): IJsonToolModelOutput =>
  createJsonToolModelOutput(output);

const createPatchToolModelOutput = (output: unknown): IJsonToolModelOutput => {
  const result = output && typeof output === 'object'
    ? output as IApplyFileEditsResult
    : null;

  if (!result) {
    return createJsonToolModelOutput(output);
  }

  return createJsonToolModelOutput(compactModelOutput({
    path: result.path,
    summary: result.summary,
    editCount: result.editCount,
    replacements: result.replacements,
    applied: result.applied,
    beforeHash: result.beforeHash,
    afterHash: result.afterHash,
    patchReady: result.patch !== null,
    fileCount: result.patch?.files.length ?? 0,
    ...(result.error ? { error: result.error } : {}),
  }, {
    maxTotalChars: FILE_PRIMITIVE_MODEL_OUTPUT_MAX_CHARS,
    maxStringChars: FILE_PRIMITIVE_MODEL_OUTPUT_MAX_STRING_CHARS,
    maxArrayItems: 20,
    maxObjectKeys: 30,
    maxDepth: 4,
  }));
};

export const createMastraFileTools = (
  workspaceRootPath?: string,
  profile: TMcpGatewayToolProfile = 'readonly',
): ToolsInput => {
  if (!workspaceRootPath || !existsSync(workspaceRootPath)) {
    return {};
  }

  const workspaceRoot = realpathSync(resolve(workspaceRootPath));
  const resolveWorkspacePath = createWorkspacePathResolver(workspaceRoot);

  return {
    read_file_window: createTool({
      id: 'read_file_window',
      description: 'Read a bounded 1-indexed line window from a text file in the workspace.',
      inputSchema: readFileWindowInputSchema,
      execute: async (inputData) => await readFileWindow(
        resolveWorkspacePath,
        readFileWindowInputSchema.parse(inputData),
      ),
      toModelOutput: preserveReadFileWindowModelOutput,
    }),
    grep_in_files: createTool({
      id: 'grep_in_files',
      description: 'Search workspace files with ripgrep and return bounded matches plus small context.',
      inputSchema: grepInFilesInputSchema,
      execute: async (inputData) => await grepInFiles(
        resolveWorkspacePath,
        workspaceRoot,
        grepInFilesInputSchema.parse(inputData),
      ),
      toModelOutput: createFileToolModelOutput,
    }),
    list_dir: createTool({
      id: 'list_dir',
      description: 'List a workspace directory with bounded entries, sizes, and small-file line counts.',
      inputSchema: listDirInputSchema,
      execute: async (inputData) => await listDir(
        resolveWorkspacePath,
        listDirInputSchema.parse(inputData),
      ),
      toModelOutput: createFileToolModelOutput,
    }),
    search_symbols: createTool({
      id: 'search_symbols',
      description: 'Search or list TypeScript/JavaScript/Vue script symbols with bounded AST output. Use this before reading large files when locating functions, classes, types, variables, or methods.',
      inputSchema: searchSymbolsInputSchema,
      execute: async (inputData) => await searchSymbols(
        resolveWorkspacePath,
        workspaceRoot,
        searchSymbolsInputSchema.parse(inputData),
      ),
      toModelOutput: createFileToolModelOutput,
    }),
    ...(profile === 'write' ? {
      apply_file_edits: createTool({
        id: 'apply_file_edits',
        description: 'Immediately edit one workspace text file using exact string replacements. Returns the applied patch so the host can render a diff preview, ShellCheck diagnostics, and change summary.',
        inputSchema: applyFileEditsInputSchema,
        execute: async (inputData) => await applyFileEdits(
          resolveWorkspacePath,
          applyFileEditsInputSchema.parse(inputData),
        ),
        toModelOutput: createPatchToolModelOutput,
      }),
    } : {}),
  };
};

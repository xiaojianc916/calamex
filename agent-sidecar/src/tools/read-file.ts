import { createTool } from '@mastra/core/tools';
import type { AnyWorkspace } from '@mastra/core/workspace';
import { z } from 'zod';

import { truncateModelOutputText } from '../models/output-budget.js';
import {
  formatNumberedFileSlice,
  formatWithLineNumbers,
  resolveLineRange,
} from '../engines/tools/read-file-format.js';

// 不带行区间时，直接整篇返回的最大行数；超过则改为引导按区间读取（对齐 Zed
// read_file「大文件不整篇 dump、改给 outline / 区间引导」的契约）。
export const READ_FILE_MAX_FULL_LINES = 2_000;
// 单次返回内容的字符上限，兜底防止超大区间擑爆上下文（与仓库其它工具的预算口径一致）。
export const READ_FILE_MAX_OUTPUT_CHARS = 40_000;

export interface IReadFileResult {
  path: string;
  content: string;
  line_count: number;
  truncated: boolean;
  start_line: number | null;
  end_line: number | null;
  ok: boolean;
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unwrapModelToolInput = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return {};
  }
  if (!isObjectRecord(value)) {
    return value;
  }
  const nestedInput = value.input;
  const nestedArguments = value.arguments;
  if (isObjectRecord(nestedInput)) {
    return nestedInput;
  }
  if (isObjectRecord(nestedArguments)) {
    return nestedArguments;
  }
  return value;
};

const removeNullishFields = (value: unknown, fields: readonly string[]): unknown => {
  if (!isObjectRecord(value)) {
    return value;
  }
  let normalized: Record<string, unknown> | null = null;
  for (const field of fields) {
    if (value[field] !== null && value[field] !== undefined) {
      continue;
    }
    normalized ??= { ...value };
    delete normalized[field];
  }
  return normalized ?? value;
};

const looseModelToolInputSchema = z.object({}).passthrough();

const readFileBaseInputSchema = z.object({
  path: z.string().min(1)
    .describe('Workspace-relative path of the file to read.'),
  start_line: z.number().int().optional()
    .describe('1-based inclusive start line. Omit to read from the first line.'),
  end_line: z.number().int().optional()
    .describe('1-based inclusive end line. Omit to read to the end (subject to a size guard).'),
});

const readFileNormalizedInputSchema = z.preprocess(
  (value) => removeNullishFields(unwrapModelToolInput(value), ['start_line', 'end_line']),
  readFileBaseInputSchema,
);

const readFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
  line_count: z.number(),
  truncated: z.boolean(),
  start_line: z.number().nullable(),
  end_line: z.number().nullable(),
  ok: z.boolean(),
});

/** 统计文本行数：尾随换行不额外计一行（等价于 split_inclusive('\n') 的元素个数）。 */
export const countLines = (content: string): number => {
  if (content.length === 0) {
    return 0;
  }
  let newlines = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      newlines += 1;
    }
  }
  return content.endsWith('\n') ? newlines : newlines + 1;
};

/** 大文件引导文案：对齐 Zed「SUCCESS…不要无区间重试…用 start_line/end_line」契约。 */
export const buildLargeFileGuidance = (
  path: string,
  lineCount: number,
  maxFullLines: number,
): string =>
  [
    `SUCCESS: "${path}" has ${lineCount} lines (over the ${maxFullLines}-line direct-read limit), so it was not returned in full.`,
    `Read the part you need with start_line and end_line (1-based, inclusive), e.g. { "path": "${path}", "start_line": 1, "end_line": 200 }.`,
    'Do NOT retry without a line range.',
  ].join('\n');

/** 读取结果的纯函数装配：决定整篇 / 区间 / 大文件引导，并施加字符兜底。 */
export const buildReadFileResult = (params: {
  path: string;
  content: string;
  startLine?: number | null;
  endLine?: number | null;
  maxFullLines?: number;
  maxOutputChars?: number;
}): IReadFileResult => {
  const maxFullLines = params.maxFullLines ?? READ_FILE_MAX_FULL_LINES;
  const maxOutputChars = params.maxOutputChars ?? READ_FILE_MAX_OUTPUT_CHARS;
  const totalLines = countLines(params.content);
  const hasRange =
    (params.startLine !== null && params.startLine !== undefined) ||
    (params.endLine !== null && params.endLine !== undefined);

  if (hasRange) {
    const { start, end } = resolveLineRange(params.startLine, params.endLine);
    const capped = truncateModelOutputText(
      formatNumberedFileSlice(params.content, params.startLine, params.endLine),
      maxOutputChars,
    );
    return {
      path: params.path,
      content: capped.text,
      line_count: totalLines,
      truncated: capped.truncated,
      start_line: start,
      end_line: Math.max(start, Math.min(end, totalLines)),
      ok: true,
    };
  }

  if (totalLines > maxFullLines) {
    return {
      path: params.path,
      content: buildLargeFileGuidance(params.path, totalLines, maxFullLines),
      line_count: totalLines,
      truncated: false,
      start_line: null,
      end_line: null,
      ok: true,
    };
  }

  const capped = truncateModelOutputText(formatWithLineNumbers(params.content, 1), maxOutputChars);
  return {
    path: params.path,
    content: capped.text,
    line_count: totalLines,
    truncated: capped.truncated,
    start_line: totalLines === 0 ? null : 1,
    end_line: totalLines === 0 ? null : totalLines,
    ok: true,
  };
};

const buildReadFileErrorResult = (path: string, error: unknown): IReadFileResult => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    path,
    content:
      `Failed to read "${path}": ${message}\n` +
      'If this path is a directory, list it with the list_files tool. ' +
      'If the path is wrong, verify it with list_files.',
    line_count: 0,
    truncated: false,
    start_line: null,
    end_line: null,
    ok: false,
  };
};

const readFileToolDescription = [
  'Read a workspace file with cat -n style line numbers (1-based).',
  'Prefer reading the section you need: pass start_line/end_line instead of dumping the whole file.',
  '',
  'Behavior:',
  '  - With start_line/end_line: returns that inclusive range, numbered from start_line.',
  '  - Without a range on a small file: returns the whole file, numbered from line 1.',
  `  - Without a range on a large file (> ${READ_FILE_MAX_FULL_LINES} lines): returns guidance instead of dumping; re-call with a line range.`,
  '',
  'Examples:',
  '  { "path": "src/index.ts" }',
  '  { "path": "src/index.ts", "start_line": 40, "end_line": 80 }',
].join('\n');

export const createMastraReadFileTool = (
  workspace: AnyWorkspace,
): Record<'read_file', ReturnType<typeof createTool>> => ({
  read_file: createTool({
    id: 'read_file',
    description: readFileToolDescription,
    inputSchema: looseModelToolInputSchema,
    outputSchema: readFileOutputSchema,
    execute: async (inputData) => {
      const { path, start_line, end_line } = readFileNormalizedInputSchema.parse(inputData);
      const filesystem = workspace.filesystem;
      if (!filesystem) {
        return buildReadFileErrorResult(path, new Error('workspace filesystem is unavailable'));
      }
      try {
        const raw = await filesystem.readFile(path, { encoding: 'utf-8' });
        const content = typeof raw === 'string' ? raw : String(raw);
        return buildReadFileResult({ path, content, startLine: start_line, endLine: end_line });
      } catch (error) {
        return buildReadFileErrorResult(path, error);
      }
    },
  }),
});

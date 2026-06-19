import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { compactModelOutput, truncateModelOutputText } from '../../models/output-budget.js';
import { createJsonToolModelOutput } from '../../engines/budget/budget.js';
import type { IAgentContextReferenceInput } from '../../engines/contracts/runtime-input.js';
import { CURRENT_FILE_TOOL_CONTENT_MAX_CHARS, CURRENT_FILE_TOOL_MODEL_OUTPUT_MAX_CHARS } from '../../engines/shared/types.js';

/** 行号列宽，对齐 Mastra 内置 read_file 的 `cat -n` 输出（行号右对齐到 6 列 + 单个制表符）。 */
const LINE_NUMBER_COLUMN_WIDTH = 6;

/**
 * 以 `cat -n` 风格为文本逐行加行号：行号右对齐到 6 列、后接制表符，再接该行原始内容
 * （含行尾换行符）。空字符串返回空字符串。
 *
 * 输出与 Mastra 内置 `read_file`（showLineNumbers 默认 true，内部走 line-utils.formatWithLineNumbers）
 * 保持一致，使「当前编辑器文件」预览与 read_file 的行号语义统一：模型可据此用 read_file 的
 * offset/limit 精确续读，或用 edit_file 按行匹配。
 */
const formatWithLineNumbers = (text: string, startLine: number): string => {
    if (text.length === 0) {
        return '';
    }
    let output = '';
    let lineNumber = startLine;
    let lineStart = 0;
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== '\n') {
            continue;
        }
        output += `${String(lineNumber).padStart(LINE_NUMBER_COLUMN_WIDTH, ' ')}\t${text.slice(lineStart, index + 1)}`;
        lineNumber += 1;
        lineStart = index + 1;
    }
    if (lineStart < text.length) {
        output += `${String(lineNumber).padStart(LINE_NUMBER_COLUMN_WIDTH, ' ')}\t${text.slice(lineStart)}`;
    }
    return output;
};

export const findCurrentFileReference = (
    contextReferences: readonly IAgentContextReferenceInput[] = [],
): IAgentContextReferenceInput | null =>
    contextReferences.find((reference) => reference.kind === 'current-file') ?? null;

export const createUiContextTools = (
    contextReferences: readonly IAgentContextReferenceInput[] = [],
): Record<string, ReturnType<typeof createTool>> => {
    const currentFile = findCurrentFileReference(contextReferences);

    if (!currentFile) {
        return {};
    }

    return {
        read_current_file: createTool({
            id: 'read_current_file',
            description: 'Read a line-numbered preview of the current editor file (cat -n style: line numbers reflect the file\u0027s real line numbers). Use only when the user asks about the current file. Takes no arguments; output is capped \u2014 use the workspace read_file tool to load the full file or a specific line range.',
            inputSchema: z.object({}).passthrough(),
            execute: async () => {
                const preview = truncateModelOutputText(
                    currentFile.contentPreview,
                    CURRENT_FILE_TOOL_CONTENT_MAX_CHARS,
                    { includeNotice: false },
                );
                // 行号锚定到文件真实行号：引用自带行区间时以其起始行为基准，否则从第 1 行起。
                // 与内置 read_file 的 cat -n 输出对齐，便于据此用 read_file 的 offset/limit 精确续读或编辑。
                const baseLine = currentFile.range?.startLine ?? 1;

                return {
                    path: currentFile.path,
                    label: currentFile.label,
                    range: currentFile.range,
                    redacted: currentFile.redacted,
                    content: formatWithLineNumbers(preview.text, baseLine),
                    truncated: preview.truncated,
                    originalCharCount: preview.originalCharCount,
                };
            },
            toModelOutput: (output) => createJsonToolModelOutput(compactModelOutput(output, {
                maxTotalChars: CURRENT_FILE_TOOL_MODEL_OUTPUT_MAX_CHARS,
                maxStringChars: CURRENT_FILE_TOOL_CONTENT_MAX_CHARS,
                maxArrayItems: 10,
                maxObjectKeys: 20,
                maxDepth: 4,
            })),
        }),
    };
};

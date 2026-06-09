/**
 * Zed 风格的文件读取展示层：行号 + 行区间裁剪。
 *
 * 行为对齐 Zed `crates/agent/src/tools/read_file_tool.rs` 中的
 * `resolve_line_range` / `write_lines_numbered`（Rust → TS 的等价移植，
 * 非源码拷贝）：
 *
 * - 行号采用 `cat -n` 风格：右对齐到 6 列、后接单个制表符，再接该行原始内容
 *   （含其行尾换行符）。这正是编辑工具按行匹配时所期望的格式。
 * - 行区间为 1 基、闭区间。start 至少为 1（模型偶尔传 0 或负数），
 *   end 至少为 start（模型偶尔传 end < start），因此总是至少返回一行。
 * - 切片保留行终止符（等价于 Rust `split_inclusive('\n')`）：CRLF 保持为 CRLF，
 *   最后一行的尾随换行也被保留，便于与原文逐字节对齐。
 */

/** 行号列宽，对齐 Zed 的 `{n:>6}\t`。 */
const LINE_NUMBER_COLUMN_WIDTH = 6;

/** 默认起始行（未显式提供 start_line 时）。 */
const DEFAULT_START_LINE = 1;

export interface IResolvedLineRange {
	/** 1 基、闭区间的起始行。 */
	start: number;
	/** 1 基、闭区间的结束行（>= start）。 */
	end: number;
}

const toLineNumber = (value: number | null | undefined, fallback: number): number => {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.trunc(value);
};

/**
 * 归一化行区间，对齐 Zed `resolve_line_range`：
 * `start = start_line.unwrap_or(1).max(1)`、`end = end_line.unwrap_or(MAX).max(start)`。
 */
export const resolveLineRange = (
	startLine?: number | null,
	endLine?: number | null,
): IResolvedLineRange => {
	const start = Math.max(DEFAULT_START_LINE, toLineNumber(startLine, DEFAULT_START_LINE));
	const end = Math.max(start, toLineNumber(endLine, Number.MAX_SAFE_INTEGER));
	return { start, end };
};

const formatNumberedLine = (lineNumber: number, lineWithTerminator: string): string =>
	`${String(lineNumber).padStart(LINE_NUMBER_COLUMN_WIDTH, ' ')}\t${lineWithTerminator}`;

/**
 * 以 `cat -n` 风格为文本逐行加上行号：行号右对齐到 6 列、后接制表符，再接该行
 * 原始内容（含行尾换行符）。空字符串返回空字符串。行为对齐 Zed `write_lines_numbered`。
 */
export const formatWithLineNumbers = (text: string, startLine: number): string => {
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
		output += formatNumberedLine(lineNumber, text.slice(lineStart, index + 1));
		lineNumber += 1;
		lineStart = index + 1;
	}
	if (lineStart < text.length) {
		output += formatNumberedLine(lineNumber, text.slice(lineStart));
	}
	return output;
};

/** 等价于 Rust `split_inclusive('\n')`：保留每行行终止符，尾随换行不产生空尾元素。 */
const splitInclusive = (content: string): string[] => {
	if (content.length === 0) {
		return [];
	}
	const lines: string[] = [];
	let lineStart = 0;
	for (let index = 0; index < content.length; index += 1) {
		if (content[index] !== '\n') {
			continue;
		}
		lines.push(content.slice(lineStart, index + 1));
		lineStart = index + 1;
	}
	if (lineStart < content.length) {
		lines.push(content.slice(lineStart));
	}
	return lines;
};

export interface ISlicedLineRange {
	/** 裁剪后的文本（保留各行行终止符）。 */
	text: string;
	/** 裁剪结果首行对应的 1 基行号。 */
	firstLineNumber: number;
}

/**
 * 按 1 基闭区间裁剪行，对齐 Zed：
 * `start_idx = (start - 1).min(len)`、`end_idx = end.min(len).max(start_idx)`。
 */
export const sliceInclusiveLineRange = (
	content: string,
	startLine?: number | null,
	endLine?: number | null,
): ISlicedLineRange => {
	const { start, end } = resolveLineRange(startLine, endLine);
	const lines = splitInclusive(content);
	const startIndex = Math.min(start - 1, lines.length);
	const endIndex = Math.max(Math.min(end, lines.length), startIndex);
	return {
		text: lines.slice(startIndex, endIndex).join(''),
		firstLineNumber: start,
	};
};

/**
 * 将文件内容格式化为带行号的模型可读文本。
 * 未提供任何行区间时输出整篇（从第 1 行起编号）；
 * 提供 start_line 或 end_line 时仅输出对应闭区间，并以 start 为首行号编号。
 */
export const formatNumberedFileSlice = (
	content: string,
	startLine?: number | null,
	endLine?: number | null,
): string => {
	const hasExplicitRange =
		(startLine !== null && startLine !== undefined) ||
		(endLine !== null && endLine !== undefined);
	if (!hasExplicitRange) {
		return formatWithLineNumbers(content, DEFAULT_START_LINE);
	}
	const { text, firstLineNumber } = sliceInclusiveLineRange(content, startLine, endLine);
	return formatWithLineNumbers(text, firstLineNumber);
};

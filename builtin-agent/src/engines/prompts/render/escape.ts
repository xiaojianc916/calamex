// 公共基础：把不可信内容（UI 选区、文件预览、技能名等）安全地嵌入提示词，
// 防止其内容破坏 Markdown 结构或伪装成提示词指令（prompt injection）。

const BACKTICK_RUN_PATTERN = /`+/gu;
const LINE_BREAK_PATTERN = /[\r\n]+/gu;
const BACKTICK_PATTERN = /`/gu;
const WHITESPACE_RUN_PATTERN = /\s+/gu;
const MIN_FENCE_LENGTH = 3;

/**
 * 选择一个足够长的代码围栏，避免不可信预览文本用 ``` 提前闭合围栏、
 * 把后续内容伪装成提示词指令。标准做法（GitHub / CommonMark 通用）：
 * 围栏反引号数 = 文本中最长反引号串长度 + 1，且不少于 3。
 */
export const selectCodeFence = (content: string): string => {
    const backtickRuns = content.match(BACKTICK_RUN_PATTERN);
    const longestRun = backtickRuns
        ? backtickRuns.reduce((longest, run) => Math.max(longest, run.length), 0)
        : 0;
    return '`'.repeat(Math.max(MIN_FENCE_LENGTH, longestRun + 1));
};

/**
 * 把不可信文本压成可安全嵌入标题 / 单行字段的形式：折叠换行与空白、
 * 反引号替换为单引号，避免注入额外行或破坏 Markdown 行内结构。
 */
export const toSafeInlineLabel = (value: string): string =>
    value
        .replace(LINE_BREAK_PATTERN, ' ')
        .replace(BACKTICK_PATTERN, "'")
        .replace(WHITESPACE_RUN_PATTERN, ' ')
        .trim();

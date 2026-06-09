import type { TokenizeOptions } from '@mastra/core/workspace';

/**
 * 工作区 BM25 检索的 CJK 感知分词器。
 *
 * 背景：Mastra 内置 BM25 默认分词管线为「小写 → 去标点 → 按 \s+ 切分 → 过滤
 * minLength<2 与英文停用词」。它对以空格分词的西文（含代码标识符）工作良好，但
 * 中文 / 日文 / 韩文没有词间空格，整段 CJK 会被切成一个超长 token，几乎无法命中
 * 检索。官方在 TokenizeOptions.tokenizer 注释中明确建议：CJK 场景应改用自定义
 * 分词器（形态分析或 n-gram）。本模块即为此而生。
 *
 * 设计（取西文管线之长、补 CJK 之短，混排亦正确）：
 *   1. 整体小写；
 *   2. 与官方一致地用 Unicode 感知规则把「非字母 / 数字 / 下划线 / 空白」替换为空格
 *      （\p{L} 涵盖 CJK，故中文字符被保留）；
 *   3. 按空白切分得到原始 token；
 *   4. 每个原始 token 再按「CJK 连续段」与「非 CJK 连续段」拆分（处理「工作区workspace」
 *      这类混排）：
 *        - 非 CJK 段：沿用西文规则——长度 ≥2 且非停用词才保留（保持代码检索行为不退化）；
 *        - CJK 段：生成重叠二元组（bigram）；长度为 1 的孤字退化为一元组（unigram）。
 *
 * 一旦提供 tokenizer，TokenizeOptions 其余字段（lowercase/removePunctuation/…）会被
 * 官方实现完全忽略，故小写、去标点、停用词、最小长度均需在此自行完成。
 */

// 与 Mastra 内置 DEFAULT_STOPWORDS 对齐的英文停用词。该集合未从 @mastra/core/workspace
// 导出，这里内置一份等价表，避免对内部导出做不可靠假设。
const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
    'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to', 'was',
    'were', 'will', 'with',
]);

/** 西文 token 的最小保留长度（与 Mastra 默认 minLength 一致）。 */
const MIN_LATIN_TOKEN_LENGTH = 2;

/** 仅保留字母 / 数字 / 下划线 / 空白，其余替换为空格（与官方 removePunctuation 同义）。 */
const NON_WORD_PATTERN = /[^\p{L}\p{N}_\s]/gu;

/** 按空白切分。 */
const WHITESPACE_PATTERN = /\s+/u;

/**
 * 判断某个 Unicode 码位是否属于 CJK（含中日韩常用区段）。
 * 采用码位（而非 UTF-16 码元）判断，以正确处理增补平面（如 CJK 扩展 B）。
 */
const isCjkCodePoint = (codePoint: number): boolean =>
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // 平假名 + 片假名
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK 扩展 A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK 基本区
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // 谚文音节
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK 兼容表意文字
    (codePoint >= 0x20000 && codePoint <= 0x2ebef); // CJK 扩展 B–F

const isCjkChar = (char: string): boolean => {
    const codePoint = char.codePointAt(0);
    return codePoint !== undefined && isCjkCodePoint(codePoint);
};

/** 为一段连续 CJK 字符生成重叠二元组；孤字退化为一元组。 */
const pushCjkGrams = (chars: readonly string[], out: string[]): void => {
    if (chars.length === 1) {
        out.push(chars[0]!);
        return;
    }
    for (let index = 0; index < chars.length - 1; index += 1) {
        out.push(chars[index]! + chars[index + 1]!);
    }
};

/** 按西文规则收录一个非 CJK 段：长度达标且非停用词才保留。 */
const pushLatinToken = (token: string, out: string[]): void => {
    if (token.length < MIN_LATIN_TOKEN_LENGTH) {
        return;
    }
    if (ENGLISH_STOPWORDS.has(token)) {
        return;
    }
    out.push(token);
};

/** 将单个原始 token 拆成 CJK / 非 CJK 连续段并分别产出子 token。 */
const pushSegmentedTokens = (rawToken: string, out: string[]): void => {
    const chars = Array.from(rawToken); // 以码位切分，正确处理代理对
    let index = 0;
    while (index < chars.length) {
        const segmentIsCjk = isCjkChar(chars[index]!);
        let end = index + 1;
        while (end < chars.length && isCjkChar(chars[end]!) === segmentIsCjk) {
            end += 1;
        }
        const segment = chars.slice(index, end);
        if (segmentIsCjk) {
            pushCjkGrams(segment, out);
        } else {
            pushLatinToken(segment.join(''), out);
        }
        index = end;
    }
};

/**
 * CJK 感知分词：供 BM25 索引与查询共用，保证建索引 / 检索两端口径一致。
 */
export const tokenizeWorkspaceText = (text: string): string[] => {
    const normalized = text.toLowerCase().replace(NON_WORD_PATTERN, ' ');
    const tokens: string[] = [];
    for (const rawToken of normalized.split(WHITESPACE_PATTERN)) {
        if (rawToken.length === 0) {
            continue;
        }
        pushSegmentedTokens(rawToken, tokens);
    }
    return tokens;
};

/**
 * 构造工作区 BM25 的 TokenizeOptions（注入上面的 CJK 感知分词器）。
 * 提供 tokenizer 后其余选项被官方实现忽略，故此处只需返回 { tokenizer }。
 */
export const createWorkspaceBm25TokenizeOptions = (): TokenizeOptions => ({
    tokenizer: tokenizeWorkspaceText,
});

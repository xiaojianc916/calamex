import { resolveCodeMirrorLanguageId } from '@/services/editor/codemirror-language';
import {
  type IShikiThemedToken,
  resolveShikiLanguageId,
  SHIKI_BACKGROUND,
  SHIKI_FOREGROUND,
  tokenizeSnippetWithShikiWorker,
} from '@/services/editor/shiki-highlighter';

export interface ICodeMirrorHighlightToken {
  content: string;
  color?: string;
  bgColor?: string;
  htmlStyle?: Readonly<Record<string, string>>;
  fontStyle?: number;
}

export interface ITokenizedCode {
  tokens: ICodeMirrorHighlightToken[][];
  fg: string;
  bg: string;
}

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const TOKENS_CACHE_LIMIT = 120;

const tokensCache = new Map<string, ITokenizedCode>();

export const isItalic = (fontStyle: number | undefined): boolean =>
  Boolean(fontStyle && (fontStyle & FONT_STYLE_ITALIC) !== 0);

export const isBold = (fontStyle: number | undefined): boolean =>
  Boolean(fontStyle && (fontStyle & FONT_STYLE_BOLD) !== 0);

export const isUnderline = (fontStyle: number | undefined): boolean =>
  Boolean(fontStyle && (fontStyle & FONT_STYLE_UNDERLINE) !== 0);

const getTokensCacheKey = (code: string, language: string): string => {
  const languageId = resolveCodeMirrorLanguageId(language);
  const start = code.slice(0, 100);
  const end = code.length > 100 ? code.slice(-100) : '';
  return `${languageId}:${code.length}:${start}:${end}`;
};

const rememberTokens = (key: string, value: ITokenizedCode): void => {
  if (tokensCache.size >= TOKENS_CACHE_LIMIT) {
    const firstKey = tokensCache.keys().next().value;
    if (typeof firstKey === 'string') {
      tokensCache.delete(firstKey);
    }
  }

  tokensCache.set(key, value);
};

const normalizeFontStyle = (fontStyle: number | undefined): number | undefined =>
  fontStyle && fontStyle > 0 ? fontStyle : undefined;

const toTokenizedCode = (lines: IShikiThemedToken[][]): ITokenizedCode => ({
  tokens: lines.map((line) =>
    line
      .filter((token) => token.content.length > 0)
      .map((token) => ({
        content: token.content,
        color: token.color ?? 'inherit',
        bgColor: token.bgColor,
        fontStyle: normalizeFontStyle(token.fontStyle),
      })),
  ),
  fg: SHIKI_FOREGROUND,
  bg: SHIKI_BACKGROUND,
});

export const createRawTokens = (code: string): ITokenizedCode => ({
  tokens: code
    .split('\n')
    .map((line) => (line === '' ? [] : [{ content: line, color: 'inherit' }])),
  fg: SHIKI_FOREGROUND,
  bg: SHIKI_BACKGROUND,
});

/**
 * 同步高亮：worker-only 下主线程不再同步 tokenize，仅返回 highlightCodeAsync
 * 已写入的缓存命中；未命中时返回 null。
 * 调用方应先用 createRawTokens 兜底，并通过 highlightCodeAsync 在后台升级为高亮。
 */
export const highlightCodeSync = (code: string, language: string): ITokenizedCode | null => {
  const languageId = resolveCodeMirrorLanguageId(language);
  if (languageId === 'text') {
    return null;
  }

  return tokensCache.get(getTokensCacheKey(code, languageId)) ?? null;
};

/**
 * 异步高亮：在独立 worker 线程执行 Shiki tokenize，完成后写入缓存供同步路径命中。
 */
export const highlightCodeAsync = async (
  code: string,
  language: string,
): Promise<ITokenizedCode | null> => {
  const languageId = resolveCodeMirrorLanguageId(language);
  if (languageId === 'text') {
    return null;
  }

  const tokensCacheKey = getTokensCacheKey(code, languageId);
  const cached = tokensCache.get(tokensCacheKey);
  if (cached) {
    return cached;
  }

  const lines = await tokenizeSnippetWithShikiWorker(code, language);
  if (!lines) {
    return null;
  }

  const tokenized = toTokenizedCode(lines);
  rememberTokens(tokensCacheKey, tokenized);
  return tokenized;
};

/** @deprecated 使用 highlightCodeSync(同步缓存) 或 highlightCodeAsync(按需加载)。 */
export const highlightCode = highlightCodeSync;

const escapeHtmlChar = (char: string): string =>
  char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;';

const escapeHtml = (value: string): string => value.replace(/[&<>]/gu, escapeHtmlChar);

const tokenStyleToHtml = (token: ICodeMirrorHighlightToken): string => {
  const declarations: string[] = [];
  if (token.color && token.color !== 'inherit') {
    declarations.push(`color:${token.color}`);
  }
  if (token.bgColor) {
    declarations.push(`background-color:${token.bgColor}`);
  }
  if (isItalic(token.fontStyle)) {
    declarations.push('font-style:italic');
  }
  if (isBold(token.fontStyle)) {
    declarations.push('font-weight:600');
  }
  if (isUnderline(token.fontStyle)) {
    declarations.push('text-decoration:underline');
  }

  return declarations.length > 0 ? ` style="${declarations.join(';')}"` : '';
};

const tokenToHtml = (token: ICodeMirrorHighlightToken): string =>
  `<span${tokenStyleToHtml(token)}>${escapeHtml(token.content)}</span>`;

/**
 * 同步生成高亮 HTML(供 LSP 文档等同步渲染场景)。
 * 若缓存尚未命中，本次先用原始文本兜底，同时后台用 worker 预热，下次渲染即可高亮。
 */
export const highlightCodeToHtml = (code: string, language: string): string => {
  const tokenized = highlightCodeSync(code, language);
  if (!tokenized && resolveShikiLanguageId(language)) {
    // 后台用 worker tokenize 并写入缓存(本次仍用兜底)。
    void highlightCodeAsync(code, language);
  }

  const finalTokenized = tokenized ?? createRawTokens(code);
  const html = finalTokenized.tokens
    .map((line) => line.map((token) => tokenToHtml(token)).join(''))
    .join('\n');

  return `<pre class="cm-static-highlight" style="background-color:${finalTokenized.bg};color:${finalTokenized.fg}"><code>${html}</code></pre>`;
};

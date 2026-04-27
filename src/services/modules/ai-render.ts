import { parseFenceInfo } from '@/services/modules/ai-code-detect';
import type { IAiCodeBlock, TAiMarkdownSegment, TAiSupportedLang } from '@/types/ai-code';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

const MAX_CODE_BLOCK_CHARS = 64 * 1024;
const MAX_CODE_BLOCKS = 30;

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

type TMarkdownToken = ReturnType<MarkdownIt['parse']>[number];

const sanitizeHtml = (html: string): string => DOMPurify.sanitize(html, {
  ALLOWED_TAGS: [
    'a',
    'blockquote',
    'br',
    'code',
    'del',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'hr',
    'li',
    'ol',
    'p',
    'pre',
    'span',
    'strong',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'ul',
  ],
  ALLOWED_ATTR: ['href', 'rel', 'target'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
});

const renderHtmlTokens = (tokens: TMarkdownToken[]): string => {
  if (tokens.length === 0) return '';
  const html = markdown.renderer.render(tokens, markdown.options, {});
  return sanitizeHtml(html);
};

const createCodeBlock = (
  messageId: string,
  index: number,
  token: TMarkdownToken,
  contextLang?: TAiSupportedLang,
): IAiCodeBlock => {
  const rawContent = token.content;
  const chars = [...rawContent];
  const truncated = chars.length > MAX_CODE_BLOCK_CHARS;
  const content = truncated ? chars.slice(0, MAX_CODE_BLOCK_CHARS).join('') : rawContent;
  const fence = parseFenceInfo(token.info, content, contextLang);
  return {
    id: `${messageId}:${index}`,
    messageId,
    index,
    fence,
    content,
    closed: true,
    streamState: 'closed',
    byteLength: new TextEncoder().encode(rawContent).byteLength,
    truncated,
  };
};

export const renderAiMarkdown = (
  messageId: string,
  content: string,
  contextLang?: TAiSupportedLang,
): TAiMarkdownSegment[] => {
  const tokens = markdown.parse(content, {});
  const segments: TAiMarkdownSegment[] = [];
  let htmlTokens: TMarkdownToken[] = [];
  let codeBlockIndex = 0;

  const flushHtml = (): void => {
    const html = renderHtmlTokens(htmlTokens);
    htmlTokens = [];
    if (!html.trim()) return;
    segments.push({
      id: `${messageId}:html:${segments.length}`,
      kind: 'html',
      html,
    });
  };

  for (const token of tokens) {
    if (token.type !== 'fence') {
      htmlTokens.push(token);
      continue;
    }

    flushHtml();
    if (codeBlockIndex >= MAX_CODE_BLOCKS) {
      htmlTokens.push({ ...token, type: 'paragraph_open', tag: 'p', nesting: 1 });
      htmlTokens.push({ ...token, type: 'inline', tag: '', nesting: 0, content: '代码块过多，已折叠超出部分。' });
      htmlTokens.push({ ...token, type: 'paragraph_close', tag: 'p', nesting: -1 });
      continue;
    }

    const block = createCodeBlock(messageId, codeBlockIndex, token, contextLang);
    segments.push({
      id: block.id,
      kind: 'code',
      block,
    });
    codeBlockIndex += 1;
  }

  flushHtml();
  return segments;
};

export const getAiMarkdownRenderer = (): MarkdownIt => markdown;


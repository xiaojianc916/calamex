import { createHighlighter, type HighlighterGeneric } from 'shiki';
import { isAiSupportedLang } from '@/services/modules/ai-code-detect';
import type { TAiSupportedLang } from '@/types/ai-code';

type THighlighter = HighlighterGeneric<string, string>;

let highlighterPromise: Promise<THighlighter> | null = null;

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const getHighlighter = (): Promise<THighlighter> => {
  highlighterPromise ??= createHighlighter({
    themes: ['github-dark-default'],
    langs: ['plaintext', 'bash', 'sh', 'diff', 'ts', 'js', 'json'],
  });
  return highlighterPromise;
};

export const highlightAiCode = async (
  code: string,
  lang: TAiSupportedLang,
): Promise<string> => {
  if (!isAiSupportedLang(lang)) {
    return `<pre class="shiki ai-code-plain"><code>${escapeHtml(code)}</code></pre>`;
  }

  try {
    const highlighter = await getHighlighter();
    await highlighter.loadLanguage(lang).catch(() => undefined);
    return highlighter.codeToHtml(code, {
      lang,
      theme: 'github-dark-default',
    });
  } catch {
    return `<pre class="shiki ai-code-plain"><code>${escapeHtml(code)}</code></pre>`;
  }
};

export const useShikiHighlighter = () => ({
  highlightAiCode,
});

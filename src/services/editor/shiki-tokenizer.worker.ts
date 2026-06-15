import { bundledLanguages } from 'shiki/langs';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import {
  type IShikiThemedToken,
  resolveShikiLanguageId,
  SHIKI_THEME_NAME,
} from './shiki-shared';

type TShikiWorkerRequest = {
  id: number;
  code: string;
  language: string;
};

type TShikiWorkerResponse = {
  id: number;
  tokens: IShikiThemedToken[][] | null;
  error?: string;
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Set<string>();
const pendingLanguages = new Map<string, Promise<boolean>>();

const ensureHighlighter = (): Promise<HighlighterCore> => {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import('@shikijs/themes/github-light')],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    }).catch((error) => {
      highlighterPromise = null;
      throw error;
    });
  }
  return highlighterPromise;
};

const ensureLanguage = async (language: string): Promise<string | null> => {
  const shikiId = resolveShikiLanguageId(language);
  if (!shikiId) {
    return null;
  }
  if (loadedLanguages.has(shikiId)) {
    return shikiId;
  }

  let pending = pendingLanguages.get(shikiId);
  if (!pending) {
    // 全量按需：直接取 shiki/langs 暴露的惰性 loader 全量表（覆盖 Shiki 全部语言）。
    // 每种语言 grammar 由 Vite 切成独立 async chunk，仅在首次用到时才下载；未知语言
    // （不在 bundledLanguages 中）loader 为 undefined，回退纯文本。
    const loader = bundledLanguages[shikiId as keyof typeof bundledLanguages];
    if (!loader) {
      return null;
    }
    pending = (async () => {
      try {
        const highlighter = await ensureHighlighter();
        const mod = (await loader()) as { default?: unknown };
        await highlighter.loadLanguage((mod.default ?? mod) as never);
        loadedLanguages.add(shikiId);
        return true;
      } finally {
        pendingLanguages.delete(shikiId);
      }
    })();
    pendingLanguages.set(shikiId, pending);
  }

  return (await pending) ? shikiId : null;
};

const tokenize = async (code: string, language: string): Promise<IShikiThemedToken[][] | null> => {
  const shikiId = await ensureLanguage(language);
  if (!shikiId) {
    return null;
  }
  const highlighter = await ensureHighlighter();
  return highlighter.codeToTokensBase(code, {
    lang: shikiId,
    theme: SHIKI_THEME_NAME,
  }) as unknown as IShikiThemedToken[][];
};

const workerSelf = self as unknown as {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<TShikiWorkerRequest>) => void,
  ): void;
  postMessage(message: TShikiWorkerResponse): void;
};

workerSelf.addEventListener('message', (event) => {
  const { id, code, language } = event.data;
  void tokenize(code, language)
    .then((tokens) => {
      workerSelf.postMessage({ id, tokens });
    })
    .catch((error: unknown) => {
      workerSelf.postMessage({
        id,
        tokens: null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
});

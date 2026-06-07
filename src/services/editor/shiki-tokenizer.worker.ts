import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import {
  type IShikiThemedToken,
  SHIKI_LANG_LOADERS,
  SHIKI_THEME_NAME,
  resolveShikiLanguageId,
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
    const loader = SHIKI_LANG_LOADERS[shikiId];
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

const tokenize = async (
  code: string,
  language: string,
): Promise<IShikiThemedToken[][] | null> => {
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

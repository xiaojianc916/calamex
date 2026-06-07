import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { resolveCodeMirrorLanguageId } from '@/services/editor/codemirror-language';
import { SHIKI_THEME_NAME, type IShikiThemedToken } from '@/services/editor/shiki-highlighter';

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

const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  bash: () => import('@shikijs/langs/bash'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  docker: () => import('@shikijs/langs/docker'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  ini: () => import('@shikijs/langs/ini'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  jsx: () => import('@shikijs/langs/jsx'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  less: () => import('@shikijs/langs/less'),
  lua: () => import('@shikijs/langs/lua'),
  markdown: () => import('@shikijs/langs/markdown'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  scala: () => import('@shikijs/langs/scala'),
  scss: () => import('@shikijs/langs/scss'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  vue: () => import('@shikijs/langs/vue'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
};

const APP_TO_SHIKI: Record<string, string> = {
  shell: 'bash',
  sh: 'bash',
  zsh: 'bash',
  dockerfile: 'docker',
  md: 'markdown',
  ts: 'typescript',
  js: 'javascript',
  yml: 'yaml',
  svg: 'xml',
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Set<string>();
const pendingLanguages = new Map<string, Promise<boolean>>();

const resolveShikiLanguageId = (language: string): string | null => {
  const appId = resolveCodeMirrorLanguageId(language);
  if (!appId || appId === 'text') {
    return null;
  }
  const shikiId = APP_TO_SHIKI[appId] ?? appId;
  return shikiId in LANG_LOADERS ? shikiId : null;
};

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
    pending = (async () => {
      try {
        const highlighter = await ensureHighlighter();
        const mod = (await LANG_LOADERS[shikiId]()) as { default?: unknown };
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
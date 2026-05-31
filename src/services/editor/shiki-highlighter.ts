import {
  CODEMIRROR_GITHUB_LIGHT_BACKGROUND,
  CODEMIRROR_GITHUB_LIGHT_FOREGROUND,
} from '@/services/editor/codemirror-github-light-highlight';
import { resolveCodeMirrorLanguageId } from '@/services/editor/codemirror-language';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

/**
 * 专业版 Shiki 高亮服务。
 *
 * 设计要点：
 * - 使用 fine-grained 的 `shiki/core`，主题/语法全部按需动态 import，配合打包器做
 *   代码分割，初始 bundle 不含任何语法。
 * - 正则引擎采用官方 Oniguruma WASM（`shiki/engine/oniguruma` + `shiki/wasm`）。
 *   JS 正则引擎虽然更小，但与 Oniguruma 并非 100% 兼容，Vue/HTML 等重度内嵌
 *   语法会出现大片不高亮；WASM 通过 `import('shiki/wasm')` 动态加载、被 Vite 单独
 *   切 chunk，只在首次高亮时拉一次，不影响初始包体积与按需加载。
 * - 只接入 github-light 一个主题，保持与编辑器整体浅色风格一致。
 * - 语言语法用显式静态 import 字面量声明（而非模板字符串），保证 Vite 能静态分析、
 *   为每个语法生成独立 chunk，真正做到按需加载。
 */

export const SHIKI_THEME_NAME = 'github-light';
export const SHIKI_FOREGROUND = CODEMIRROR_GITHUB_LIGHT_FOREGROUND;
export const SHIKI_BACKGROUND = CODEMIRROR_GITHUB_LIGHT_BACKGROUND;

/** Shiki token 的最小结构（避免直接依赖 shiki 的类型导出路径）。 */
export interface IShikiThemedToken {
  content: string;
  offset: number;
  color?: string;
  bgColor?: string;
  /** 位标志：1=italic, 2=bold, 4=underline（与 Shiki FontStyle 一致）。 */
  fontStyle?: number;
}

// 语法按需加载器：key = Shiki 语言 id，value = 动态 import。
// 仅声明确定存在于 @shikijs/langs 的语言，避免 Vite 构建期解析失败。
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

// app 内部语言 id -> Shiki 语言 id 的差异映射。未列出的按同名处理。
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
let highlighterInstance: HighlighterCore | null = null;
const loadedLanguages = new Set<string>();
const pendingLanguages = new Map<string, Promise<boolean>>();

/** 把传入语言解析成受支持的 Shiki 语言 id；不支持时返回 null。 */
export const resolveShikiLanguageId = (language: string): string | null => {
  const appId = resolveCodeMirrorLanguageId(language);
  if (!appId || appId === 'text') {
    return null;
  }
  const shikiId = APP_TO_SHIKI[appId] ?? appId;
  return shikiId in LANG_LOADERS ? shikiId : null;
};

/** 创建（或复用）highlighter 单例，仅加载 github-light 主题，语法后续按需注入。 */
export const ensureHighlighter = (): Promise<HighlighterCore> => {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import('@shikijs/themes/github-light')],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    }).then((highlighter) => {
      highlighterInstance = highlighter;
      return highlighter;
    });
  }
  return highlighterPromise;
};

/** 指定语言对应的语法是否已加载（用于同步高亮判定）。 */
export const isShikiLanguageLoaded = (language: string): boolean => {
  const shikiId = resolveShikiLanguageId(language);
  return shikiId !== null && loadedLanguages.has(shikiId);
};

/** 按需加载语言语法；返回最终可用的 Shiki 语言 id（失败或不支持时返回 null）。 */
export const ensureShikiLanguage = async (language: string): Promise<string | null> => {
  const shikiId = resolveShikiLanguageId(language);
  if (!shikiId) {
    return null;
  }
  if (loadedLanguages.has(shikiId)) {
    return shikiId;
  }

  let pending = pendingLanguages.get(shikiId);
  if (!pending) {
    const loader = LANG_LOADERS[shikiId];
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
      } catch (error) {
        console.error('Shiki 语言按需加载失败:', language, error);
        return false;
      } finally {
        pendingLanguages.delete(shikiId);
      }
    })();
    pendingLanguages.set(shikiId, pending);
  }

  const loaded = await pending;
  return loaded ? shikiId : null;
};

const tokenize = (
  highlighter: HighlighterCore,
  code: string,
  shikiId: string,
): IShikiThemedToken[][] | null => {
  try {
    return highlighter.codeToTokensBase(code, {
      lang: shikiId,
      theme: SHIKI_THEME_NAME,
    }) as unknown as IShikiThemedToken[][];
  } catch (error) {
    console.error('Shiki 高亮失败:', shikiId, error);
    return null;
  }
};

/** 同步高亮：仅当语法已加载时返回 token 行，否则返回 null。 */
export const tokenizeWithShikiSync = (
  code: string,
  language: string,
): IShikiThemedToken[][] | null => {
  const shikiId = resolveShikiLanguageId(language);
  if (!shikiId || !highlighterInstance || !loadedLanguages.has(shikiId)) {
    return null;
  }
  return tokenize(highlighterInstance, code, shikiId);
};

/** 异步高亮：按需加载语法后再 tokenize。 */
export const tokenizeWithShiki = async (
  code: string,
  language: string,
): Promise<IShikiThemedToken[][] | null> => {
  const shikiId = await ensureShikiLanguage(language);
  if (!shikiId) {
    return null;
  }
  const highlighter = await ensureHighlighter();
  return tokenize(highlighter, code, shikiId);
};

import {
  CODEMIRROR_GITHUB_LIGHT_BACKGROUND,
  CODEMIRROR_GITHUB_LIGHT_FOREGROUND,
} from '@/services/editor/codemirror-github-light-highlight';
import { resolveCodeMirrorLanguageId } from '@/services/editor/codemirror-language';

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
export const SHIKI_LANG_LOADERS: Record<string, () => Promise<unknown>> = {
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

/** 把传入语言解析成受支持的 Shiki 语言 id；不支持时返回 null。 */
export const resolveShikiLanguageId = (language: string): string | null => {
  const appId = resolveCodeMirrorLanguageId(language);
  if (!appId || appId === 'text') {
    return null;
  }
  const shikiId = APP_TO_SHIKI[appId] ?? appId;
  return shikiId in SHIKI_LANG_LOADERS ? shikiId : null;
};

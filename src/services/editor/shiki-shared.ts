export const SHIKI_THEME_NAME = 'github-light';
export const SHIKI_FOREGROUND = '#24292f';
export const SHIKI_BACKGROUND = '#ffffff';

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

// 这里故意不 import CodeMirror 的语言解析模块：该文件也会被 Worker import，必须保持
// Shiki-only 依赖，避免 Worker bundle 间接拉入 CodeMirror registry / HighlightStyle。
const SHIKI_LANGUAGE_ALIAS: Record<string, string> = {
  'c++': 'cpp',
  bat: 'text',
  cmd: 'text',
  conf: 'ini',
  cs: 'csharp',
  docker: 'dockerfile',
  dockerfile: 'docker',
  h: 'c',
  htm: 'html',
  js: 'javascript',
  json5: 'jsonc',
  kt: 'kotlin',
  md: 'markdown',
  patch: 'diff',
  plaintext: 'text',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  svg: 'xml',
  ts: 'typescript',
  txt: 'text',
  yml: 'yaml',
  zsh: 'bash',
};

const normalizeShikiLanguageTag = (language: string): string => {
  const tag = language.trim().toLowerCase();
  if (!tag) {
    return 'text';
  }
  return SHIKI_LANGUAGE_ALIAS[tag] ?? tag;
};

/** 把传入语言解析成受支持的 Shiki 语言 id；不支持时返回 null。 */
export const resolveShikiLanguageId = (language: string): string | null => {
  const shikiId = normalizeShikiLanguageTag(language);
  if (shikiId === 'text') {
    return null;
  }
  return shikiId in SHIKI_LANG_LOADERS ? shikiId : null;
};

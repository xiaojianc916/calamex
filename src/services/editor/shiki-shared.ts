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

// 这里故意不 import CodeMirror 的语言解析模块，也不 import 任何 @shikijs/langs：
// 该文件会被主线程与 Worker 同时 import，必须保持零 shiki 依赖，避免把语法 grammar
// 重新拉回主线程模块图（破坏 worker-only 去重）。语言是否真正可加载，统一由 Worker
// 端依据 @shikijs/langs 的 bundledLanguages 判定。
const SHIKI_LANGUAGE_ALIAS: Record<string, string> = {
  'c++': 'cpp',
  bat: 'text',
  cmd: 'text',
  conf: 'ini',
  cs: 'csharp',
  // Shiki 的 bundled 语言 id 为 'docker'（'dockerfile' 是其别名）。把 dockerfile 归一到
  // canonical 'docker'，避免 docker / dockerfile 两种拼写各自加载并缓存一份同一 grammar。
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

/**
 * 把传入语言归一化为 Shiki 语言 id 候选；纯文本/空串返回 null（不高亮）。
 * 不再用硬编码白名单做存在性校验——是否真正受支持交由 Worker 端按 bundledLanguages
 * 判定，未命中时回退纯文本。这样可在保持「按需加载」的同时支持 Shiki 全部语言。
 */
export const resolveShikiLanguageId = (language: string): string | null => {
  const shikiId = normalizeShikiLanguageTag(language);
  if (shikiId === 'text') {
    return null;
  }
  return shikiId;
};

import { LanguageSupport, StreamLanguage } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { LANGUAGE_DEFINITIONS } from '@/utils/editor/language-registry';
import { logger } from '@/utils/platform/logger';
import { withTreeSitterHighlight } from './codemirror-tree-sitter-highlight';

export type TCodeMirrorLanguageId = string;

const PLAIN_TEXT_ID = 'text';

// 显式归一到纯文本(CodeMirror 无需着色)的标签。其余无解析器的标签也会回退为 text。
const PLAIN_TEXT_TAGS: ReadonlySet<string> = new Set([
  'text',
  'txt',
  'plaintext',
  'bat',
  'cmd',
  'pl',
]);

// StreamLanguage.define 的参数类型(legacy stream 模式)。
type CodeMirrorStreamParser = Parameters<typeof StreamLanguage.define>[0];

// 把一个\"动态 import legacy stream parser\"的 loader 包装成返回 LanguageSupport 的懒加载器。
// 语法包只有在该语言首次被用到时才会被动态 import(Vite 代码分割)。
const streamLanguageLoader =
  (loader: () => Promise<CodeMirrorStreamParser>) => async (): Promise<LanguageSupport> =>
    new LanguageSupport(StreamLanguage.define(await loader()));

// 规范 id → 语法支持懒加载器。这是本模块唯一与 @codemirror 解析器强耦合的部分;
// 词表 / 别名 / 标签 / 展示名全部来自 language-registry。
// 共享解析器:javascript 与 jsx 同用 javascript({jsx});css / scss / less 同用 css()。
const CODEMIRROR_LANGUAGE_LOADERS: Readonly<Record<string, () => Promise<Extension>>> = {
  shell: () => import('./codemirror-bash-language').then((m) => m.bashLanguageExtensions()),
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  typescript: () =>
    import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () =>
    import('@codemirror/lang-javascript').then((m) =>
      m.javascript({ jsx: true, typescript: true }),
    ),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  vue: () => import('@codemirror/lang-vue').then((m) => m.vue()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  scss: () => import('@codemirror/lang-css').then((m) => m.css()),
  less: () => import('@codemirror/lang-css').then((m) => m.css()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  dockerfile: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile),
  ),
  diff: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff),
  ),
  c: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  csharp: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp),
  ),
  dart: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => m.dart),
  ),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  kotlin: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin),
  ),
  lua: streamLanguageLoader(() => import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua)),
  powershell: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/powershell').then((m) => m.powerShell),
  ),
  proto: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/protobuf').then((m) => m.protobuf),
  ),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  r: streamLanguageLoader(() => import('@codemirror/legacy-modes/mode/r').then((m) => m.r)),
  ruby: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby),
  ),
  rust: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  scala: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => m.scala),
  ),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql({})),
  latex: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/stex').then((m) => m.stex),
  ),
  swift: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/swift').then((m) => m.swift),
  ),
  toml: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml),
  ),
  ini: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties),
  ),
  xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
};

/** 具备 CodeMirror 解析器的规范语言 id(loader 键集合)。 */
export const CODEMIRROR_SUPPORTED_LANGUAGE_IDS: readonly string[] = Object.freeze(
  Object.keys(CODEMIRROR_LANGUAGE_LOADERS),
);

const CODEMIRROR_LANGUAGE_ID_SET: ReadonlySet<string> = new Set(CODEMIRROR_SUPPORTED_LANGUAGE_IDS);

// 由 language-registry 派生:CodeMirror 标签表(规范 id + text)与 原始标签→规范 id 映射。
const { labels: DERIVED_LABELS, tagToId: TAG_TO_LANGUAGE_ID } = ((): {
  labels: Record<string, string>;
  tagToId: Record<string, string>;
} => {
  const labels: Record<string, string> = { [PLAIN_TEXT_ID]: 'Plain Text' };
  const tagToId: Record<string, string> = {};
  for (const def of LANGUAGE_DEFINITIONS) {
    if (!def.codemirror) {
      continue;
    }
    labels[def.id] = def.label;
    tagToId[def.id] = def.id;
    for (const alias of def.aliases ?? []) {
      tagToId[alias] = def.id;
    }
  }
  return { labels, tagToId };
})();

export const CODEMIRROR_LANGUAGE_LABELS: Readonly<Record<string, string>> = DERIVED_LABELS;

/**
 * 把原始语言标签归一为规范 id:
 * - 空串与显式纯文本标签 → 'text';
 * - 命中 registry 的 id/alias → 对应规范 id;
 * - 其余未知标签原样返回(由 resolveCodeMirrorLanguageId 进一步判定是否有解析器)。
 */
export function normalizeCodeMirrorLanguageTag(raw: string): string {
  const tag = raw.trim().toLowerCase();
  if (!tag || PLAIN_TEXT_TAGS.has(tag)) {
    return PLAIN_TEXT_ID;
  }
  return TAG_TO_LANGUAGE_ID[tag] ?? tag;
}

/**
 * 解析原始标签为「具备 CodeMirror 解析器」的规范 id;无解析器时回退为 'text'。
 * 每种语言只有单一 canonical id(如 bash/sh/zsh→shell、svg→xml、jsonc→json)。
 */
export function resolveCodeMirrorLanguageId(language: string): TCodeMirrorLanguageId {
  const normalized = normalizeCodeMirrorLanguageTag(language);
  return CODEMIRROR_LANGUAGE_ID_SET.has(normalized) ? normalized : PLAIN_TEXT_ID;
}

// 已经按需加载完成的语法支持(同步命中)。
const loadedLanguageSupports = new Map<string, Extension>();
// 正在加载中的语法支持,避免并发重复 import。
const pendingLanguageSupports = new Map<string, Promise<Extension | null>>();

/**
 * 同步获取\"已加载\"的语言支持;若该语法尚未按需加载完成,返回 null。
 * 调用方应配合 loadCodeMirrorLanguageSupport 触发加载。
 */
export const resolveCodeMirrorLanguageSupport = (language: string): Extension | null => {
  const languageId = resolveCodeMirrorLanguageId(language);
  if (languageId === PLAIN_TEXT_ID) {
    return null;
  }
  return loadedLanguageSupports.get(languageId) ?? null;
};

/**
 * 按需加载某语言的语法支持。语法包通过动态 import 被代码分割,
 * 只有该语言首次被用到时才会真正下载/解析。结果会被缓存以便后续同步命中。
 */
export const loadCodeMirrorLanguageSupport = async (
  language: string,
): Promise<Extension | null> => {
  const languageId = resolveCodeMirrorLanguageId(language);
  if (languageId === PLAIN_TEXT_ID) {
    return null;
  }

  const cached = loadedLanguageSupports.get(languageId);
  if (cached) {
    return cached;
  }

  const pending = pendingLanguageSupports.get(languageId);
  if (pending) {
    return pending;
  }

  const loader = CODEMIRROR_LANGUAGE_LOADERS[languageId];
  if (!loader) {
    return null;
  }

  const promise = loader()
    .then((extension) => {
      if (extension) {
        loadedLanguageSupports.set(languageId, extension);
        return extension;
      }
      return null;
    })
    .catch((error) => {
      logger.error({
        event: 'codemirror.language.load_failed',
        err: error,
        language,
      });
      return null;
    })
    .finally(() => {
      pendingLanguageSupports.delete(languageId);
    });

  pendingLanguageSupports.set(languageId, promise);
  return promise;
};

/**
 * 同步返回\"已加载\"语言的扩展;未加载时返回空扩展([]),
 * 配合 loadCodeMirrorLanguageExtension / loadCodeMirrorLanguageSupport 异步补齐。
 */
export const resolveCodeMirrorLanguageExtension = (language: string): Extension => {
  const support = resolveCodeMirrorLanguageSupport(language);
  if (!support) {
    return [];
  }
  return withTreeSitterHighlight(resolveCodeMirrorLanguageId(language), support);
};

/** 按需加载语言扩展(加载完成后可灌入编辑器的 language compartment)。 */
export const loadCodeMirrorLanguageExtension = async (language: string): Promise<Extension> => {
  const support = await loadCodeMirrorLanguageSupport(language);
  if (!support) {
    return [];
  }
  return withTreeSitterHighlight(resolveCodeMirrorLanguageId(language), support);
};

export const isCodeMirrorLanguageSupport = (value: Extension): value is LanguageSupport =>
  value instanceof LanguageSupport;

/**
 * 文件扩展名 → CodeMirror 语言 ID 映射。
 * 由 ssh-file-preview.ts 和其他需要文件类型推断的模块共用。
 */
export const FILE_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  bash: 'bash',
  bat: 'bat',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  css: 'css',
  cts: 'typescript',
  cxx: 'cpp',
  dockerfile: 'dockerfile',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  jsx: 'jsx',
  less: 'less',
  log: 'text',
  md: 'markdown',
  mts: 'typescript',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svg: 'svg',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  txt: 'text',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

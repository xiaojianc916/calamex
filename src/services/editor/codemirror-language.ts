import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";

export type TCodeMirrorLanguageId = string;

export const CODEMIRROR_LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  dart: "Dart",
  diff: "Diff",
  dockerfile: "Dockerfile",
  go: "Go",
  html: "HTML",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  jsonc: "JSONC",
  jsx: "JSX",
  kotlin: "Kotlin",
  latex: "LaTeX",
  less: "Less",
  lua: "Lua",
  markdown: "Markdown",
  powershell: "PowerShell",
  protobuf: "Protobuf",
  python: "Python",
  r: "R",
  ruby: "Ruby",
  rust: "Rust",
  scala: "Scala",
  scss: "SCSS",
  shell: "Shell",
  sql: "SQL",
  svg: "SVG",
  swift: "Swift",
  text: "Plain Text",
  toml: "TOML",
  tsx: "TSX",
  typescript: "TypeScript",
  vue: "Vue",
  xml: "XML",
  yaml: "YAML",
};

const LANGUAGE_ALIAS: Readonly<Record<string, string>> = {
  bat: "text",
  cmd: "text",
  conf: "ini",
  cs: "csharp",
  docker: "dockerfile",
  h: "c",
  htm: "html",
  js: "javascript",
  json5: "jsonc",
  kt: "kotlin",
  md: "markdown",
  patch: "diff",
  pl: "text",
  plaintext: "text",
  ps: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shellscript: "bash",
  tex: "latex",
  ts: "typescript",
  txt: "text",
  yml: "yaml",
  zsh: "bash",
  "c++": "cpp",
};

const PRESERVED_ALIAS_LANGUAGE_IDS = new Set([
  "jsx",
  "jsonc",
  "less",
  "scss",
  "svg",
]);

const LANGUAGE_ID_BY_DESCRIPTION_NAME: Readonly<Record<string, string>> = {
  "c++": "cpp",
  "c#": "csharp",
  c: "c",
  css: "css",
  dart: "dart",
  diff: "diff",
  dockerfile: "dockerfile",
  go: "go",
  html: "html",
  ini: "ini",
  java: "java",
  javascript: "javascript",
  json: "json",
  kotlin: "kotlin",
  latex: "latex",
  lua: "lua",
  markdown: "markdown",
  powershell: "powershell",
  "protocol buffers": "protobuf",
  python: "python",
  r: "r",
  ruby: "ruby",
  rust: "rust",
  scala: "scala",
  shell: "bash",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  tsx: "tsx",
  typescript: "typescript",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
};

// StreamLanguage.define 的参数类型(legacy stream 模式)。
type CodeMirrorStreamParser = Parameters<typeof StreamLanguage.define>[0];

// 把一个"动态 import legacy stream parser"的 loader 包装成 LanguageDescription.load。
// 语法包只有在该语言首次被用到时才会被动态 import(Vite 代码分割)。
const streamLanguageLoader =
  (loader: () => Promise<CodeMirrorStreamParser>) =>
  async (): Promise<LanguageSupport> =>
    new LanguageSupport(StreamLanguage.define(await loader()));

// 所有语言都用 `load` 懒加载,不在模块顶层 import 任何语法包。
const languageDescriptions: readonly LanguageDescription[] = [
  LanguageDescription.of({
    name: "Shell",
    alias: ["shellscript", "bash", "sh", "zsh"],
    extensions: ["bash", "sh", "zsh"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
    ),
  }),
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "jsx"],
    extensions: ["js", "jsx", "mjs", "cjs"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts"],
    extensions: ["ts", "mts", "cts"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ typescript: true }),
      ),
  }),
  LanguageDescription.of({
    name: "TSX",
    extensions: ["tsx"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ jsx: true, typescript: true }),
      ),
  }),
  LanguageDescription.of({
    name: "HTML",
    extensions: ["html", "htm"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  }),
  LanguageDescription.of({
    name: "Vue",
    extensions: ["vue"],
    load: () => import("@codemirror/lang-vue").then((m) => m.vue()),
  }),
  LanguageDescription.of({
    name: "CSS",
    alias: ["scss", "less"],
    extensions: ["css", "scss", "less"],
    load: () => import("@codemirror/lang-css").then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["jsonc"],
    extensions: ["json", "jsonc"],
    load: () => import("@codemirror/lang-json").then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: "Markdown",
    alias: ["md"],
    extensions: ["md", "markdown"],
    load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  }),
  LanguageDescription.of({
    name: "Dockerfile",
    alias: ["docker"],
    filename: /^Dockerfile$/u,
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile),
    ),
  }),
  LanguageDescription.of({
    name: "Diff",
    alias: ["patch"],
    extensions: ["diff", "patch"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff),
    ),
  }),
  LanguageDescription.of({
    name: "C",
    extensions: ["c", "h"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/clike").then((m) => m.c),
    ),
  }),
  LanguageDescription.of({
    name: "C++",
    alias: ["cpp"],
    extensions: ["cpp", "cc", "cxx", "hpp"],
    load: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  }),
  LanguageDescription.of({
    name: "C#",
    alias: ["csharp", "cs"],
    extensions: ["cs"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp),
    ),
  }),
  LanguageDescription.of({
    name: "Dart",
    extensions: ["dart"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/clike").then((m) => m.dart),
    ),
  }),
  LanguageDescription.of({
    name: "Go",
    extensions: ["go"],
    load: () => import("@codemirror/lang-go").then((m) => m.go()),
  }),
  LanguageDescription.of({
    name: "Java",
    extensions: ["java"],
    load: () => import("@codemirror/lang-java").then((m) => m.java()),
  }),
  LanguageDescription.of({
    name: "Kotlin",
    alias: ["kt"],
    extensions: ["kt", "kts"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin),
    ),
  }),
  LanguageDescription.of({
    name: "Lua",
    extensions: ["lua"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua),
    ),
  }),
  LanguageDescription.of({
    name: "PowerShell",
    alias: ["ps", "pwsh"],
    extensions: ["ps1"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell),
    ),
  }),
  LanguageDescription.of({
    name: "Protocol Buffers",
    alias: ["proto", "protobuf"],
    extensions: ["proto"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/protobuf").then((m) => m.protobuf),
    ),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["py"],
    extensions: ["py"],
    load: () => import("@codemirror/lang-python").then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: "R",
    extensions: ["r"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/r").then((m) => m.r),
    ),
  }),
  LanguageDescription.of({
    name: "Ruby",
    alias: ["rb"],
    extensions: ["rb"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby),
    ),
  }),
  LanguageDescription.of({
    name: "Rust",
    alias: ["rs"],
    extensions: ["rs"],
    load: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  }),
  LanguageDescription.of({
    name: "Scala",
    extensions: ["scala"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/clike").then((m) => m.scala),
    ),
  }),
  LanguageDescription.of({
    name: "SQL",
    extensions: ["sql"],
    load: () => import("@codemirror/lang-sql").then((m) => m.sql({})),
  }),
  LanguageDescription.of({
    name: "LaTeX",
    alias: ["stex", "tex"],
    extensions: ["tex"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),
    ),
  }),
  LanguageDescription.of({
    name: "Swift",
    extensions: ["swift"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift),
    ),
  }),
  LanguageDescription.of({
    name: "TOML",
    extensions: ["toml"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml),
    ),
  }),
  LanguageDescription.of({
    name: "INI",
    alias: ["properties"],
    extensions: ["ini", "properties"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
    ),
  }),
  LanguageDescription.of({
    name: "XML",
    alias: ["svg"],
    extensions: ["xml", "svg"],
    load: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  }),
  LanguageDescription.of({
    name: "YAML",
    alias: ["yml"],
    extensions: ["yaml", "yml"],
    load: streamLanguageLoader(() =>
      import("@codemirror/legacy-modes/mode/yaml").then((m) => m.yaml),
    ),
  }),
];

export function normalizeCodeMirrorLanguageTag(raw: string): string {
  const tag = raw.trim().toLowerCase();
  if (!tag) {
    return "text";
  }

  return LANGUAGE_ALIAS[tag] ?? tag;
}

export function resolveCodeMirrorLanguageId(
  language: string,
): TCodeMirrorLanguageId {
  const normalized = normalizeCodeMirrorLanguageTag(language);
  if (normalized === "text") {
    return "text";
  }

  const description = LanguageDescription.matchLanguageName(
    languageDescriptions,
    normalized,
    true,
  );
  if (!description) {
    return "text";
  }
  if (PRESERVED_ALIAS_LANGUAGE_IDS.has(normalized)) {
    return normalized;
  }

  return (
    LANGUAGE_ID_BY_DESCRIPTION_NAME[description.name.toLowerCase()] ??
    normalized
  );
}

const matchLanguageDescription = (
  languageId: string,
): LanguageDescription | null =>
  LanguageDescription.matchLanguageName(languageDescriptions, languageId, true);

// 已经按需加载完成的语法支持(同步命中)。
const loadedLanguageSupports = new Map<string, LanguageSupport>();
// 正在加载中的语法支持,避免并发重复 import。
const pendingLanguageSupports = new Map<
  string,
  Promise<LanguageSupport | null>
>();

/**
 * 同步获取"已加载"的语言支持;若该语法尚未按需加载完成,返回 null。
 * 调用方应配合 loadCodeMirrorLanguageSupport 触发加载。
 */
export const resolveCodeMirrorLanguageSupport = (
  language: string,
): LanguageSupport | null => {
  const languageId = resolveCodeMirrorLanguageId(language);
  if (languageId === "text") {
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
): Promise<LanguageSupport | null> => {
  const languageId = resolveCodeMirrorLanguageId(language);
  if (languageId === "text") {
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

  const description = matchLanguageDescription(languageId);
  if (!description) {
    return null;
  }

  const promise = description
    .load()
    .then((support) => {
      if (support instanceof LanguageSupport) {
        loadedLanguageSupports.set(languageId, support);
        return support;
      }
      return null;
    })
    .catch((error) => {
      console.error("CodeMirror 语言按需加载失败", language, error);
      return null;
    })
    .finally(() => {
      pendingLanguageSupports.delete(languageId);
    });

  pendingLanguageSupports.set(languageId, promise);
  return promise;
};

/**
 * 同步返回"已加载"语言的扩展;未加载时返回空扩展([]),
 * 配合 loadCodeMirrorLanguageExtension / loadCodeMirrorLanguageSupport 异步补齐。
 */
export const resolveCodeMirrorLanguageExtension = (
  language: string,
): Extension => {
  return resolveCodeMirrorLanguageSupport(language) ?? [];
};

/** 按需加载语言扩展(加载完成后可灌入编辑器的 language compartment)。 */
export const loadCodeMirrorLanguageExtension = async (
  language: string,
): Promise<Extension> => {
  return (await loadCodeMirrorLanguageSupport(language)) ?? [];
};

export const isCodeMirrorLanguageSupport = (
  value: Extension,
): value is LanguageSupport => value instanceof LanguageSupport;

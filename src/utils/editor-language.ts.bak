import { stripWindowsVerbatimPrefix } from '@/utils/path';

/**
 * 根据文件路径或文件名推断编辑器语言 ID。
 * 仅在确认为 shell 脚本时返回 shell,未知类型统一回退为 plaintext。
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  bat: 'bat',
  bash: 'shell',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  clj: 'clojure',
  cls: 'apex',
  conf: 'ini',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cts: 'typescript',
  cxx: 'cpp',
  dart: 'dart',
  dockerfile: 'dockerfile',
  env: 'ini',
  ex: 'elixir',
  exs: 'elixir',
  fs: 'fsharp',
  gemspec: 'ruby',
  gql: 'graphql',
  go: 'go',
  graphql: 'graphql',
  h: 'c',
  hh: 'cpp',
  hpp: 'cpp',
  hs: 'haskell',
  htm: 'html',
  html: 'html',
  ini: 'ini',
  java: 'java',
  jl: 'julia',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  ksh: 'shell',
  less: 'less',
  lua: 'lua',
  m: 'objective-c',
  makefile: 'make',
  md: 'markdown',
  mdx: 'markdown',
  mermaid: 'mermaid',
  mjs: 'javascript',
  mm: 'objective-c',
  mts: 'typescript',
  php: 'php',
  proto: 'proto',
  protobuf: 'proto',
  ps1: 'powershell',
  psd1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  r: 'r',
  rake: 'ruby',
  rb: 'ruby',
  rbw: 'ruby',
  rs: 'rust',
  scala: 'scala',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  svelte: 'svelte',
  svg: 'xml',
  swift: 'swift',
  tf: 'terraform',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zig: 'zig',
} as const;

const LANGUAGE_BY_EXACT_NAME: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  gnumakefile: 'make',
  makefile: 'make',
} as const;

const resolveCandidateFileName = (
  filePath: string | null | undefined,
  fileName: string | null | undefined,
): string => {
  const candidate = filePath?.trim() || fileName?.trim() || '';
  if (!candidate) {
    return '';
  }

  const normalizedPath = stripWindowsVerbatimPrefix(candidate);
  const withoutQuery = normalizedPath.toLowerCase().split(/[?#]/u)[0] ?? '';
  return withoutQuery.split(/[\\/]/u).at(-1) ?? '';
};

export const resolveLanguageForPath = (
  filePath: string | null | undefined,
  fileName?: string | null,
): string => {
  const candidateFileName = resolveCandidateFileName(filePath, fileName);
  if (!candidateFileName) {
    return 'plaintext';
  }

  const fileNameWithoutRange = candidateFileName.split(':')[0] ?? candidateFileName;
  const exactLanguage = LANGUAGE_BY_EXACT_NAME[fileNameWithoutRange];
  if (exactLanguage) {
    return exactLanguage;
  }
  if (fileNameWithoutRange.endsWith('.dockerfile')) {
    return 'dockerfile';
  }

  const ext = fileNameWithoutRange.includes('.')
    ? fileNameWithoutRange.split('.').at(-1)
    : undefined;

  return ext ? (LANGUAGE_BY_EXTENSION[ext] ?? 'plaintext') : 'plaintext';
};

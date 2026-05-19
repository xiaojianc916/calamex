import type { BundledLanguage } from 'shiki';

const SHIKI_LANGUAGE_MAP = {
  '': 'text',
  text: 'text',
  txt: 'text',
  plain: 'text',
  plaintext: 'text',

  shell: 'shell',
  sh: 'shell',
  zsh: 'shell',
  bash: 'shell',

  ps: 'powershell',
  pwsh: 'powershell',
  powershell: 'powershell',

  cmd: 'bat',
  batch: 'bat',
  bat: 'bat',

  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',

  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  javascript: 'javascript',
  jsx: 'jsx',

  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',

  vue: 'vue',

  py: 'python',
  python: 'python',

  rb: 'ruby',
  ruby: 'ruby',

  rs: 'rust',
  rust: 'rust',

  go: 'go',

  java: 'java',

  yml: 'yaml',
  yaml: 'yaml',

  md: 'markdown',
  markdown: 'markdown',

  jsonc: 'jsonc',
  json: 'json',

  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',

  sql: 'sql',
  xml: 'xml',
  dockerfile: 'dockerfile',
  diff: 'diff',
  patch: 'diff',
} satisfies Partial<Record<string, BundledLanguage>>;

export const SHIKI_LANGUAGE_LABELS: Partial<Record<BundledLanguage, string>> = {
  bat: 'Batch',
  shell: 'Shell',
  c: 'C',
  cpp: 'C++',
  css: 'CSS',
  diff: 'Diff',
  dockerfile: 'Dockerfile',
  go: 'Go',
  html: 'HTML',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  jsonc: 'JSONC',
  jsx: 'JSX',
  less: 'Less',
  markdown: 'Markdown',
  powershell: 'PowerShell',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  scss: 'SCSS',
  sql: 'SQL',
  text: 'Text',
  tsx: 'TSX',
  typescript: 'TypeScript',
  vue: 'Vue',
  xml: 'XML',
  yaml: 'YAML',
};

export const resolveShikiLanguage = (language: string): BundledLanguage =>
  SHIKI_LANGUAGE_MAP[language] ?? 'text';

export const normalizeLanguageTag = (value: string): string => {
  const firstToken = String(value ?? '').trim().split(/\s+/u, 1)[0] ?? '';
  return firstToken.split(':')[0].trim().toLowerCase();
};

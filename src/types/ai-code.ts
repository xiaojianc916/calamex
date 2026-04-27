export const EAiSupportedLang = {
  Bash: 'bash',
  Sh: 'sh',
  Zsh: 'zsh',
  Fish: 'fish',
  Ts: 'ts',
  Js: 'js',
  Tsx: 'tsx',
  Jsx: 'jsx',
  Vue: 'vue',
  Rust: 'rust',
  Go: 'go',
  Python: 'python',
  Ruby: 'ruby',
  Java: 'java',
  Kotlin: 'kotlin',
  Swift: 'swift',
  C: 'c',
  Cpp: 'cpp',
  Csharp: 'csharp',
  Php: 'php',
  Json: 'json',
  Yaml: 'yaml',
  Toml: 'toml',
  Ini: 'ini',
  Xml: 'xml',
  Html: 'html',
  Css: 'css',
  Scss: 'scss',
  Markdown: 'markdown',
  Sql: 'sql',
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  Diff: 'diff',
  Patch: 'patch',
  Plaintext: 'plaintext',
} as const;

export type TAiSupportedLang = typeof EAiSupportedLang[keyof typeof EAiSupportedLang];
export type TAiLanguageDetectionSource =
  | 'fence'
  | 'context'
  | 'shebang'
  | 'keyword'
  | 'auto'
  | 'fallback';

export interface IFenceInfo {
  rawInfo: string;
  lang: TAiSupportedLang;
  meta: {
    filePath?: string;
    startLine?: number;
    endLine?: number;
    isDiff?: boolean;
    isApplyCandidate?: boolean;
  };
  detection: {
    source: TAiLanguageDetectionSource;
    confidence: number;
  };
}

export type TAiCodeBlockStreamState = 'open' | 'closed' | 'cancelled';

export interface IAiCodeBlock {
  id: string;
  messageId: string;
  index: number;
  fence: IFenceInfo;
  content: string;
  closed: boolean;
  streamState: TAiCodeBlockStreamState;
  byteLength: number;
  truncated: boolean;
}

export interface IAiCodePathTarget {
  path: string;
  startLine: number | null;
  endLine: number | null;
}

export type TAiMarkdownSegment =
  | {
      id: string;
      kind: 'html';
      html: string;
    }
  | {
      id: string;
      kind: 'code';
      block: IAiCodeBlock;
    };

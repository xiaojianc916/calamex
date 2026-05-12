import { buildMonacoThemeForVariant, getThemeManager, onThemeChanged } from '@/themes';
import type { TThemeMode } from '@/types/app';

import 'monaco-editor/esm/nls.messages.zh-cn.js';
import {
  conf as cppConfig,
  language as cppLanguage,
} from 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js';
import {
  conf as cssConfig,
  language as cssLanguage,
} from 'monaco-editor/esm/vs/basic-languages/css/css.js';
import {
  conf as dockerfileConfig,
  language as dockerfileLanguage,
} from 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.js';
import {
  conf as goConfig,
  language as goLanguage,
} from 'monaco-editor/esm/vs/basic-languages/go/go.js';
import {
  conf as htmlConfig,
  language as htmlLanguage,
} from 'monaco-editor/esm/vs/basic-languages/html/html.js';
import {
  conf as iniConfig,
  language as iniLanguage,
} from 'monaco-editor/esm/vs/basic-languages/ini/ini.js';
import {
  conf as javaConfig,
  language as javaLanguage,
} from 'monaco-editor/esm/vs/basic-languages/java/java.js';
import {
  conf as jsConfig,
  language as jsLanguage,
} from 'monaco-editor/esm/vs/basic-languages/javascript/javascript.js';
import {
  conf as lessConfig,
  language as lessLanguage,
} from 'monaco-editor/esm/vs/basic-languages/less/less.js';
import {
  conf as markdownConfig,
  language as markdownLanguage,
} from 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js';
import {
  conf as powershellConfig,
  language as powershellLanguage,
} from 'monaco-editor/esm/vs/basic-languages/powershell/powershell.js';
import {
  conf as pythonConfig,
  language as pythonLanguage,
} from 'monaco-editor/esm/vs/basic-languages/python/python.js';
import {
  conf as rubyConfig,
  language as rubyLanguage,
} from 'monaco-editor/esm/vs/basic-languages/ruby/ruby.js';
import {
  conf as rustConfig,
  language as rustLanguage,
} from 'monaco-editor/esm/vs/basic-languages/rust/rust.js';
import {
  conf as scssConfig,
  language as scssLanguage,
} from 'monaco-editor/esm/vs/basic-languages/scss/scss.js';
import {
  conf as shellLanguageConfig,
  language as shellLanguageDefinition,
} from 'monaco-editor/esm/vs/basic-languages/shell/shell.js';
import {
  conf as sqlConfig,
  language as sqlLanguage,
} from 'monaco-editor/esm/vs/basic-languages/sql/sql.js';
import {
  conf as tsConfig,
  language as tsLanguage,
} from 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js';
import {
  conf as xmlConfig,
  language as xmlLanguage,
} from 'monaco-editor/esm/vs/basic-languages/xml/xml.js';
import {
  conf as yamlConfig,
  language as yamlLanguage,
} from 'monaco-editor/esm/vs/basic-languages/yaml/yaml.js';
import { Range } from 'monaco-editor/esm/vs/editor/common/core/range.js';
import { Selection } from 'monaco-editor/esm/vs/editor/common/core/selection.js';
import {
  EditorOption,
  MarkerSeverity,
  ScrollType,
} from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';
import 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/esm/vs/editor/contrib/comment/browser/comment';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController';
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js';
// 走顶层包入口拿类型,避开 monaco-editor exports map 不开放 editor.api 子路径的问题。
import type * as MonacoApi from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess';
import 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess';
import {
  createDiffEditor as createStandaloneDiffEditor,
  create as createStandaloneEditor,
  createModel as createStandaloneModel,
  defineTheme as defineStandaloneTheme,
  setModelLanguage as setStandaloneModelLanguage,
  setModelMarkers as setStandaloneModelMarkers,
  setTheme as setStandaloneTheme,
} from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneEditor.js';
import { createMonacoLanguagesAPI } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneLanguages.js';
import 'monaco-editor/min/vs/editor/editor.main.css';

// ---------------------------------------------------------------------------
// Local types & constants
// ---------------------------------------------------------------------------

type TMonacoEnvironment = {
  getWorker: () => Worker;
};

type TMonacoThemeName = 'sh-dark' | 'sh-light';

const MONACO_THEME_NAME_DARK: TMonacoThemeName = 'sh-dark';
const MONACO_THEME_NAME_LIGHT: TMonacoThemeName = 'sh-light';

const SHELL_LANGUAGE_ID = 'shell';
const SHELL_FILE_EXTENSIONS = ['.sh', '.bash'];
const SHELL_LANGUAGE_ALIASES = ['Shell', 'sh'];

const READY_FLAG_KEY = '__SH_EDITOR_MONACO_READY__' as const;
const SHELL_READY_FLAG_KEY = '__SH_EDITOR_MONACO_SHELL_READY__' as const;
let suggestContributionPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Monaco facade
// ---------------------------------------------------------------------------

const languages = createMonacoLanguagesAPI();

/**
 * 拼装一个最小可用的 monaco namespace,只暴露本工程实际用到的 API。
 * cast 成 typeof MonacoApi 是为了让消费方按 monaco-editor 公共类型来用,
 * 但只有下面这些字段是真的被赋了值——访问其他字段会得到 undefined。
 */
const monaco = {
  editor: {
    create: createStandaloneEditor,
    createDiffEditor: createStandaloneDiffEditor,
    createModel: createStandaloneModel,
    defineTheme: defineStandaloneTheme,
    setModelLanguage: setStandaloneModelLanguage,
    setModelMarkers: setStandaloneModelMarkers,
    setTheme: setStandaloneTheme,
    EditorOption,
    ScrollType,
  },
  languages,
  MarkerSeverity,
  Range,
  Selection,
} as unknown as typeof MonacoApi;

// ---------------------------------------------------------------------------
// Global scope guards
// ---------------------------------------------------------------------------

const globalScope = self as typeof self & {
  MonacoEnvironment?: TMonacoEnvironment;
  [READY_FLAG_KEY]?: boolean;
  [SHELL_READY_FLAG_KEY]?: boolean;
};

// ---------------------------------------------------------------------------
// Theme name mapping
// ---------------------------------------------------------------------------

const resolveMonacoThemeName = (theme: TThemeMode): TMonacoThemeName =>
  theme === 'light' ? MONACO_THEME_NAME_LIGHT : MONACO_THEME_NAME_DARK;

// ---------------------------------------------------------------------------
// Language registration
// ---------------------------------------------------------------------------

const registerShellLanguage = (): void => {
  if (globalScope[SHELL_READY_FLAG_KEY]) {
    return;
  }
  globalScope[SHELL_READY_FLAG_KEY] = true;

  monaco.languages.register({
    id: SHELL_LANGUAGE_ID,
    extensions: SHELL_FILE_EXTENSIONS,
    aliases: SHELL_LANGUAGE_ALIASES,
  });
  monaco.languages.setMonarchTokensProvider(SHELL_LANGUAGE_ID, shellLanguageDefinition);
  monaco.languages.setLanguageConfiguration(SHELL_LANGUAGE_ID, shellLanguageConfig);

  // ---------------------------------------------------------------------------
  // Extra basic-language Monarch tokenizers (syntax highlight only, no worker)
  // ---------------------------------------------------------------------------
  type TLangSpec = {
    id: string;
    extensions: string[];
    aliases: string[];
    conf: unknown;
    language: unknown;
  };

  const EXTRA_LANGS: TLangSpec[] = [
    { id: 'python', extensions: ['.py', '.pyw', '.pyi'], aliases: ['Python'], conf: pythonConfig, language: pythonLanguage },
    { id: 'javascript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], aliases: ['JavaScript'], conf: jsConfig, language: jsLanguage },
    { id: 'typescript', extensions: ['.ts', '.mts', '.cts', '.tsx'], aliases: ['TypeScript'], conf: tsConfig, language: tsLanguage },
    { id: 'ruby', extensions: ['.rb', '.rbw', '.rake', '.gemspec'], aliases: ['Ruby'], conf: rubyConfig, language: rubyLanguage },
    { id: 'c', extensions: ['.c', '.h'], aliases: ['C'], conf: cppConfig, language: cppLanguage },
    { id: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh'], aliases: ['C++', 'CPP'], conf: cppConfig, language: cppLanguage },
    { id: 'java', extensions: ['.java'], aliases: ['Java'], conf: javaConfig, language: javaLanguage },
    { id: 'rust', extensions: ['.rs'], aliases: ['Rust'], conf: rustConfig, language: rustLanguage },
    { id: 'go', extensions: ['.go'], aliases: ['Go'], conf: goConfig, language: goLanguage },
    { id: 'css', extensions: ['.css'], aliases: ['CSS'], conf: cssConfig, language: cssLanguage },
    { id: 'less', extensions: ['.less'], aliases: ['Less'], conf: lessConfig, language: lessLanguage },
    { id: 'scss', extensions: ['.scss'], aliases: ['SCSS'], conf: scssConfig, language: scssLanguage },
    { id: 'html', extensions: ['.html', '.htm'], aliases: ['HTML'], conf: htmlConfig, language: htmlLanguage },
    { id: 'xml', extensions: ['.xml', '.xsd', '.xsl', '.svg'], aliases: ['XML'], conf: xmlConfig, language: xmlLanguage },
    { id: 'yaml', extensions: ['.yaml', '.yml'], aliases: ['YAML'], conf: yamlConfig, language: yamlLanguage },
    { id: 'markdown', extensions: ['.md', '.markdown'], aliases: ['Markdown'], conf: markdownConfig, language: markdownLanguage },
    { id: 'sql', extensions: ['.sql'], aliases: ['SQL'], conf: sqlConfig, language: sqlLanguage },
    { id: 'dockerfile', extensions: ['.dockerfile'], aliases: ['Dockerfile'], conf: dockerfileConfig, language: dockerfileLanguage },
    { id: 'powershell', extensions: ['.ps1', '.psm1', '.psd1'], aliases: ['PowerShell'], conf: powershellConfig, language: powershellLanguage },
    { id: 'ini', extensions: ['.ini', '.conf', '.toml', '.env'], aliases: ['INI', 'TOML'], conf: iniConfig, language: iniLanguage },
  ];

  for (const spec of EXTRA_LANGS) {
    monaco.languages.register({ id: spec.id, extensions: spec.extensions, aliases: spec.aliases });
    monaco.languages.setMonarchTokensProvider(
      spec.id,
      spec.language as MonacoApi.languages.IMonarchLanguage,
    );
    monaco.languages.setLanguageConfiguration(
      spec.id,
      spec.conf as MonacoApi.languages.LanguageConfiguration,
    );
  }
};

// ---------------------------------------------------------------------------
// Theme registration
// ---------------------------------------------------------------------------

/**
 * 使用主题管理器中的 L2 Roles 为 Monaco 注册(或刷新)所有变体的主题定义。
 * 颜色逻辑统一由 src/themes/derive/monaco.ts 维护,此处只调用注册 API。
 */
const registerMonacoThemesFromManager = (): void => {
  const manager = getThemeManager();
  for (const variant of manager.list()) {
    const themeData = buildMonacoThemeForVariant(variant);
    monaco.editor.defineTheme(
      resolveMonacoThemeName(variant.mode),
      themeData as MonacoApi.editor.IStandaloneThemeData,
    );
  }
};

// ---------------------------------------------------------------------------
// One-shot bootstrap (module evaluation side-effects)
// ---------------------------------------------------------------------------

if (!globalScope.MonacoEnvironment) {
  globalScope.MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  };
}

if (!globalScope[READY_FLAG_KEY]) {
  registerShellLanguage();
  registerMonacoThemesFromManager();
  globalScope[READY_FLAG_KEY] = true;

  onThemeChanged(() => {
    registerMonacoThemesFromManager();
    monaco.editor.setTheme(resolveMonacoThemeName(getThemeManager().getMode()));
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 根据文件路径（或文件名）推断 Monaco 语言 ID。
 * 未能识别时回退到 `'shell'`（主编辑器默认语言）。
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  bash: 'shell',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  conf: 'ini',
  cpp: 'cpp',
  css: 'css',
  cts: 'typescript',
  cxx: 'cpp',
  dockerfile: 'dockerfile',
  env: 'ini',
  gemspec: 'ruby',
  go: 'go',
  h: 'c',
  hh: 'cpp',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  ksh: 'shell',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  ps1: 'powershell',
  psd1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  rake: 'ruby',
  rb: 'ruby',
  rbw: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  svg: 'xml',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'html',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
} as const;

const resolveLanguageForPath = (filePath: string | null | undefined): string => {
  if (!filePath) {
    return 'shell';
  }
  const lower = filePath.toLowerCase().split(/[?#]/)[0] ?? '';
  const fileName = lower.split('/').at(-1) ?? lower.split('\\').at(-1) ?? '';

  if (fileName === 'dockerfile' || fileName.endsWith('.dockerfile')) {
    return 'dockerfile';
  }
  if (fileName === 'makefile' || fileName === 'gnumakefile') {
    return 'ini'; // no makefile grammar; ini tokenizer is close enough for highlighting
  }

  const ext = fileName.includes('.') ? fileName.split('.').at(-1) : undefined;
  return ext ? (LANGUAGE_BY_EXTENSION[ext] ?? 'shell') : 'shell';
};

const applyMonacoTheme = (theme: TThemeMode): void => {
  monaco.editor.setTheme(resolveMonacoThemeName(theme));
};

const ensureMonacoSuggestContribution = async (): Promise<void> => {
  if (!suggestContributionPromise) {
    suggestContributionPromise = import(
      'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js'
    )
      .then(() => undefined)
      .catch((error) => {
        suggestContributionPromise = null;
        throw error;
      });
  }

  return suggestContributionPromise;
};

export { applyMonacoTheme, ensureMonacoSuggestContribution, monaco, resolveLanguageForPath };

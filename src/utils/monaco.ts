import { SHIKI_THEME } from '@/constants/editor/shiki';
import type { TThemeMode } from '@/types/app';
import { resolveLanguageForPath } from '@/utils/editor-language';

import 'monaco-editor/esm/nls.messages.zh-cn.js';
import 'monaco-editor/min/vs/editor/editor.main.css';
import * as MonacoApi from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestMemory.js';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

type TMonacoEnvironment = {
  getWorker: () => Worker;
};

const READY_FLAG_KEY = '__SH_EDITOR_MONACO_READY__' as const;
let suggestContributionPromise: Promise<void> | null = null;

const monaco = MonacoApi;

const globalScope = self as typeof self & {
  MonacoEnvironment?: TMonacoEnvironment;
  [READY_FLAG_KEY]?: boolean;
};

if (!globalScope.MonacoEnvironment) {
  globalScope.MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  };
}

if (!globalScope[READY_FLAG_KEY]) {
  globalScope[READY_FLAG_KEY] = true;
}

const applyMonacoTheme = (theme: TThemeMode): void => {
  void theme;
  monaco.editor.setTheme(SHIKI_THEME);
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

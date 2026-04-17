import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/min/vs/editor/editor.main.css';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

type TMonacoEnvironment = {
  getWorker: () => Worker;
};

const globalScope = self as typeof self & {
  MonacoEnvironment?: TMonacoEnvironment;
  __SH_EDITOR_MONACO_READY__?: boolean;
};

if (!globalScope.MonacoEnvironment) {
  globalScope.MonacoEnvironment = {
    getWorker() {
      return new editorWorker();
    },
  };
}

if (!globalScope.__SH_EDITOR_MONACO_READY__) {
  monaco.editor.defineTheme('sh-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8a8f98' },
      { token: 'keyword', foreground: '7170ff' },
      { token: 'string', foreground: '96d483' },
      { token: 'number', foreground: 'f4bf75' },
      { token: 'delimiter', foreground: 'd0d6e0' },
    ],
    colors: {
      'editor.background': '#0f1011',
      'editor.foreground': '#f7f8f8',
      'editor.lineHighlightBackground': '#ffffff08',
      'editorLineNumber.foreground': '#62666d',
      'editorLineNumber.activeForeground': '#d0d6e0',
      'editorCursor.foreground': '#7170ff',
      'editor.selectionBackground': '#7170ff33',
      'editor.inactiveSelectionBackground': '#7170ff1f',
      'editorIndentGuide.background1': '#ffffff0f',
      'editorIndentGuide.activeBackground1': '#ffffff1f',
      'editor.foldBackground': '#7170ff14',
      'editorGutter.background': '#0f1011',
      'scrollbarSlider.background': '#ffffff1f',
      'scrollbarSlider.hoverBackground': '#ffffff2d',
      'scrollbarSlider.activeBackground': '#ffffff38',
    },
  });

  monaco.editor.defineTheme('sh-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '79808a' },
      { token: 'keyword', foreground: '5e6ad2' },
      { token: 'string', foreground: '1b7f4f' },
      { token: 'number', foreground: 'b06c00' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#111215',
      'editor.lineHighlightBackground': '#0f101105',
      'editorLineNumber.foreground': '#a0a6b0',
      'editorLineNumber.activeForeground': '#4d5461',
      'editorCursor.foreground': '#5e6ad2',
      'editor.selectionBackground': '#5e6ad222',
      'editor.inactiveSelectionBackground': '#5e6ad214',
      'editorIndentGuide.background1': '#0f101111',
      'editorIndentGuide.activeBackground1': '#0f101122',
      'editor.foldBackground': '#5e6ad214',
      'editorGutter.background': '#ffffff',
      'scrollbarSlider.background': '#0f10111f',
      'scrollbarSlider.hoverBackground': '#0f101129',
      'scrollbarSlider.activeBackground': '#0f101136',
    },
  });

  globalScope.__SH_EDITOR_MONACO_READY__ = true;
}

export { monaco };

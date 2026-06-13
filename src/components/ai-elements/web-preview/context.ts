import type { InjectionKey, Ref } from 'vue';

export type TWebPreviewLogLevel = 'log' | 'warn' | 'error';

// Where a console entry came from:
// - 'app': diagnostics emitted by our own shell (e.g. a failed webview command).
// - 'page': forwarded from the inspected page's console / browser Log domain
//   (its console.log calls, CSP report-only warnings, etc.).
// Defaults to 'app' when omitted.
export type TWebPreviewLogSource = 'app' | 'page';

export interface IWebPreviewConsoleLog {
  level: TWebPreviewLogLevel;
  message: string;
  timestamp: Date | string | number;
  source?: TWebPreviewLogSource;
}

export interface IWebPreviewContext {
  currentUrl: Ref<string>;
  setUrl: (url: string) => void;
}

export const WebPreviewKey: InjectionKey<IWebPreviewContext> = Symbol('WebPreview');

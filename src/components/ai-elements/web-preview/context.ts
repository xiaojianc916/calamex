import type { InjectionKey, Ref } from 'vue';

export type TWebPreviewLogLevel = 'log' | 'warn' | 'error';

export interface IWebPreviewConsoleLog {
  level: TWebPreviewLogLevel;
  message: string;
  timestamp: Date | string | number;
}

export interface IWebPreviewContext {
  currentUrl: Ref<string>;
  setUrl: (url: string) => void;
}

export const WebPreviewKey: InjectionKey<IWebPreviewContext> = Symbol('WebPreview');

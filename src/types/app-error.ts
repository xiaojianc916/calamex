export type TAppErrorScope = 'http' | 'ipc' | 'validation' | 'unknown';

export type TErrorPresentation = 'field' | 'toast' | 'inline' | 'dialog' | 'page' | 'fatal';

export type TErrorSeverity = 'info' | 'warning' | 'error' | 'fatal';

export type TErrorActionVariant = 'default' | 'outline' | 'ghost';

export interface IErrorPresentationAction {
  id: string;
  label: string;
  variant?: TErrorActionVariant;
  onSelect: () => void;
}

export interface IResolvedErrorPresentation {
  code?: string;
  title: string;
  message: string;
  presentation: TErrorPresentation;
  severity: TErrorSeverity;
  traceId?: string;
  technicalDetails?: string;
  actions: IErrorPresentationAction[];
}

export interface IAppError extends Error {
  code: string;
  scope: TAppErrorScope;
  traceId: string;
  cause?: unknown;
  timestamp: string;
}

export interface IAppErrorOptions {
  code: string;
  message: string;
  scope: TAppErrorScope;
  traceId: string;
  cause?: unknown;
  timestamp?: string;
}

/**
 * 应用层统一错误模型。
 *
 * 该类型同时满足 `Error` 语义与结构化错误字段要求，便于 services/store/UI
 * 在不丢失堆栈信息的前提下传递 `code / scope / traceId / timestamp`。
 */
export class AppError extends Error implements IAppError {
  code: string;
  scope: TAppErrorScope;
  traceId: string;
  override cause?: unknown;
  timestamp: string;

  constructor(options: IAppErrorOptions) {
    super(options.message);
    this.name = 'AppError';
    this.code = options.code;
    this.scope = options.scope;
    this.traceId = options.traceId;
    this.cause = options.cause;
    this.timestamp = options.timestamp ?? new Date().toISOString();
  }
}

export const isAppError = (value: unknown): value is AppError => value instanceof AppError;

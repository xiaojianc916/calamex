import {
  isAppError,
  type AppError,
  type IErrorPresentationAction,
  type IResolvedErrorPresentation,
  type TErrorPresentation,
  type TErrorSeverity,
} from '@/types/app-error';
import { toErrorMessage } from '@/utils/error';

export interface IResolveErrorPresentationOptions {
  title?: string;
  fallbackMessage?: string;
  presentation?: TErrorPresentation;
  severity?: TErrorSeverity;
  technicalDetails?: string;
  actions?: IErrorPresentationAction[];
}

const DEFAULT_ERROR_MESSAGE = '操作失败，请稍后重试。';

const PRESENTATION_TITLE_TABLE: Record<TErrorPresentation, string> = {
  field: '输入内容有误',
  toast: '操作失败',
  inline: '无法加载内容',
  dialog: '无法继续操作',
  page: '页面暂时不可用',
  fatal: '应用遇到严重错误',
};

const DEFAULT_PRESENTATION_BY_SCOPE: Record<AppError['scope'], TErrorPresentation> = {
  http: 'toast',
  ipc: 'toast',
  validation: 'field',
  unknown: 'inline',
};

const DEFAULT_SEVERITY_BY_PRESENTATION: Record<TErrorPresentation, TErrorSeverity> = {
  field: 'warning',
  toast: 'error',
  inline: 'error',
  dialog: 'error',
  page: 'error',
  fatal: 'fatal',
};

const stringifyUnknown = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Error) {
    return value.stack ?? value.message;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const resolveErrorTechnicalDetails = (error: unknown): string | undefined => {
  if (isAppError(error)) {
    const causeDetail = stringifyUnknown(error.cause);
    const stackDetail = error.stack;
    return [stackDetail, causeDetail].filter(Boolean).join('\n\nCaused by:\n') || undefined;
  }

  return stringifyUnknown(error) ?? undefined;
};

export const resolveErrorPresentation = (
  error: unknown,
  options: IResolveErrorPresentationOptions = {},
): IResolvedErrorPresentation => {
  const presentation =
    options.presentation ??
    (isAppError(error) ? DEFAULT_PRESENTATION_BY_SCOPE[error.scope] : 'inline');
  const severity =
    options.severity ??
    (isAppError(error) && error.code === 'ipc.canceled'
      ? 'info'
      : DEFAULT_SEVERITY_BY_PRESENTATION[presentation]);
  const message = toErrorMessage(error, options.fallbackMessage ?? DEFAULT_ERROR_MESSAGE);

  return {
    code: isAppError(error) ? error.code : undefined,
    title: options.title ?? PRESENTATION_TITLE_TABLE[presentation],
    message,
    presentation,
    severity,
    traceId: isAppError(error) ? error.traceId : undefined,
    technicalDetails: options.technicalDetails ?? resolveErrorTechnicalDetails(error),
    actions: options.actions ?? [],
  };
};

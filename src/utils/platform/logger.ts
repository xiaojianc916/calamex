import { type ConsolaInstance, createConsola } from 'consola/browser';

export interface ILoggerPayload {
  event: string;
  traceId?: string;
  code?: string;
  err?: unknown;
  [key: string]: unknown;
}

/**
 * 由环境变量决定日志级别；生产默认 info 可见，开发期默认 debug 可见。
 * - 0 fatal/error  1 warn  2 log  3 info  4 debug  5 trace
 */
const resolveLevel = (): number => {
  const env = import.meta.env as ImportMetaEnv & {
    VITE_LOG_LEVEL?: string;
  };
  const raw = env.VITE_LOG_LEVEL;
  const parsed = raw !== undefined ? Number(raw) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  return env.DEV ? 4 : 3;
};

const consola: ConsolaInstance = createConsola({
  level: resolveLevel(),
  formatOptions: {
    date: true,
    colors: false,
  },
});

/** 非 Error 值规整为 Error，确保 stack/打印行为可预期。 */
const normalizeErr = (err: unknown): Error => {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(String(err));
  }
};

/** 把 err 作为独立参数传给 consola，让 stack/染色等内置行为生效。 */
const emit = (
  instance: ConsolaInstance,
  method: 'warn' | 'info' | 'error' | 'debug',
  payload: ILoggerPayload,
): void => {
  const { err, event, ...extra } = payload;
  if (err !== undefined) {
    instance[method](event, normalizeErr(err), extra);
  } else {
    instance[method](event, extra);
  }
};

export interface ILogger {
  warn(payload: ILoggerPayload): void;
  info(payload: ILoggerPayload): void;
  error(payload: ILoggerPayload): void;
  /** 新增：debug 通道，由 LOG_LEVEL>=4 控制可见性。 */
  debug(payload: ILoggerPayload): void;
  /**
   * 新增：派生一个带固定字段的子 logger（如 traceId / module），
   * 子 logger 的所有日志都会自动合并这些字段，调用方不必每次重复传。
   */
  child(bindings: Omit<ILoggerPayload, 'event'>): ILogger;
}

const createLogger = (
  instance: ConsolaInstance,
  bindings: Omit<ILoggerPayload, 'event'> = {},
): ILogger => {
  const merge = (payload: ILoggerPayload): ILoggerPayload =>
    Object.keys(bindings).length === 0 ? payload : { ...bindings, ...payload };

  return {
    warn(payload) {
      emit(instance, 'warn', merge(payload));
    },
    info(payload) {
      emit(instance, 'info', merge(payload));
    },
    error(payload) {
      emit(instance, 'error', merge(payload));
    },
    debug(payload) {
      emit(instance, 'debug', merge(payload));
    },
    child(extraBindings) {
      return createLogger(instance, { ...bindings, ...extraBindings });
    },
  };
};

export const logger: ILogger = createLogger(consola);

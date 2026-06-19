import type { z } from 'zod';

export type TIpcAuditLevel = 'none' | 'info' | 'sensitive';

export interface IIpcCallOptions {
  signal?: AbortSignal;
}

export interface IIpcErrorMapping {
  code: string;
  message: string;
}

export type TErrorMap = Readonly<Record<string, IIpcErrorMapping>>;

export interface IIpcLogRecord {
  timestamp: string;
  level: 'info' | 'error';
  scope: 'ipc';
  event: 'tauri.invoke';
  traceId: string;
  command: string;
  audit: TIpcAuditLevel;
  idempotent: boolean;
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
  outcome: 'ok' | 'error';
  errorCode?: string;
}

export interface IPayloadMetrics {
  bytes: number;
}

export interface IDefineIpcOptions<TInSchema extends z.ZodType, TOutSchema extends z.ZodType> {
  name: string;
  guardHint: string;
  inSchema: TInSchema;
  outSchema: TOutSchema;
  timeoutMs?: number;
  idempotent?: boolean;
  audit?: TIpcAuditLevel;
  errorMap?: TErrorMap;
  measureInput?: (input: z.output<TInSchema>) => IPayloadMetrics;
  measureOutput?: (output: z.output<TOutSchema>) => IPayloadMetrics;
  mapArgs?: (
    input: z.output<TInSchema>,
    context: { traceId: string },
  ) => Record<string, unknown> | undefined;
}

export interface IIpcContract<TInSchema extends z.ZodType, TOutSchema extends z.ZodType> {
  inSchema: TInSchema;
  outSchema: TOutSchema;
}

export type TIpcFactoryOptions<TInSchema extends z.ZodType, TOutSchema extends z.ZodType> = Omit<
  IDefineIpcOptions<TInSchema, TOutSchema>,
  'name' | 'guardHint' | 'inSchema' | 'outSchema'
>;

export interface ISpectaCommandOptions {
  command: string;
  guardHint: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  idempotent?: boolean;
  audit?: TIpcAuditLevel;
  input?: unknown;
  measureInput?: (input: Record<string, unknown>) => IPayloadMetrics;
  measureOutput?: (output: unknown) => IPayloadMetrics;
  errorMap?: TErrorMap;
}

export interface IIpcInstrumentationOptions {
  command: string;
  audit: TIpcAuditLevel;
  idempotent: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  errorMap: TErrorMap;
}

export interface IIpcInstrumentationContext {
  traceId: string;
  timeoutMs: number;
  shouldAudit: boolean;
  reportInputBytes: (bytes: number) => void;
  reportOutputBytes: (bytes: number) => void;
}

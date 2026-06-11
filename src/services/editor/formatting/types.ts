/**
 * 多语言格式化管线类型定义（P0 纯函数骨架）。
 *
 * 设计见 ADR-0008：统一管线 + 按语言解析 formatter + 单事务应用。
 * 本层为纯函数，不依赖 store / EditorView / Tauri，便于单测与复用。
 */

/** 触发来源：手动命令或保存时格式化。 */
export type TFormatTrigger = 'manual' | 'save';

export interface IFormatterInput {
  text: string;
  path: string | null;
  languageId: string;
}

/** 单个 formatter 的统一接口。P0 仅 shfmt 实现；后续可扩展 External / LSP。 */
export interface IFormatter {
  /** 稳定标识，用于日志与配置。 */
  readonly id: string;
  /** 是否支持给定 languageId（来自 resolveLanguageForPath）。 */
  supports(languageId: string): boolean;
  /** 返回格式化后的全文；失败时抛错，由管线做失败容忍处理。 */
  format(input: IFormatterInput): Promise<string>;
}

/**
 * 保存约定（whitespace 归一）。与现有 normalizeDocumentContentForSave 行为等价：
 * 始终 CRLF→LF；trimTrailingWhitespace / insertFinalNewline 按设置开关。
 * 传 null 表示跳过整个 whitespace 步骤（手动格式化路径）。
 */
export interface IWhitespaceConventions {
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
}

export interface IRunFormatPipelineArgs {
  text: string;
  path: string | null;
  languageId: string;
  trigger: TFormatTrigger;
  /** 已解析的 formatter；为 null 时退化为 whitespace 兜底。 */
  formatter: IFormatter | null;
  /** whitespace 归一约定；为 null 时跳过该步骤。 */
  whitespace: IWhitespaceConventions | null;
}

export type TFormatPipelineResult =
  | { kind: 'changed'; text: string; formatterFailed: boolean; formatterError?: string }
  | { kind: 'unchanged'; formatterFailed: boolean; formatterError?: string };

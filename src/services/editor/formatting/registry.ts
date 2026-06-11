import { externalFormatter } from './external-formatter';
import { shfmtFormatter } from './shfmt-formatter';
import type { IFormatter } from './types';

/**
 * 按语言解析 formatter（命中即返回，优先级即数组顺序）。
 * - shell → shfmt（WASM，离线可用、无需外部二进制，排在最前）。
 * - 其余已登记语言 → External 子进程 formatter（prettier / biome / rustfmt …）。
 * - 均未命中 → null（管线退化为 whitespace 兜底）。
 * 后续 P2 可在数组末尾追加 LSP formatter，作为 External 的兜底。
 */
const FORMATTERS: readonly IFormatter[] = [shfmtFormatter, externalFormatter];

export const resolveFormatter = (languageId: string): IFormatter | null =>
  FORMATTERS.find((formatter) => formatter.supports(languageId)) ?? null;

import { shfmtFormatter } from './shfmt-formatter';
import type { IFormatter } from './types';

/**
 * 按语言解析 formatter。
 * P0 仅 shell→shfmt；未命中返回 null（管线退化为 whitespace 兜底）。
 * 后续 P1 在此注册 External 命令 formatter（prettier / biome / rustfmt …），P2 接入 LSP。
 */
const FORMATTERS: readonly IFormatter[] = [shfmtFormatter];

export const resolveFormatter = (languageId: string): IFormatter | null =>
  FORMATTERS.find((formatter) => formatter.supports(languageId)) ?? null;

import {
  createRawTokens,
  highlightCodeAsync,
  highlightCodeSync,
  type ITokenizedCode,
  isBold,
  isItalic,
  isUnderline,
} from "@/services/editor/codemirror-static-highlight";

export type {
  ICodeMirrorHighlightToken,
  ITokenizedCode,
} from "@/services/editor/codemirror-static-highlight";
export { createRawTokens, isBold, isItalic, isUnderline };

/**
 * 代码块高亮(按需加载):
 * - 同步部分:命中缓存/已加载语法时立即返回高亮结果,否则返回 null(调用方用原始文本兜底)。
 * - 异步部分:若传入 callback,按需加载语法后再回调升级为高亮结果。
 */
export const highlightCode = (
  code: string,
  language: string,
  callback?: (result: ITokenizedCode) => void,
): ITokenizedCode | null => {
  const result = highlightCodeSync(code, language);

  if (callback) {
    void highlightCodeAsync(code, language).then((upgraded) => {
      if (upgraded) {
        callback(upgraded);
      }
    });
  }

  return result;
};

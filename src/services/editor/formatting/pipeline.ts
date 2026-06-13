import type { IRunFormatPipelineArgs, TFormatPipelineResult } from './types';
import { applyWhitespaceConventions } from './whitespace';

/**
 * 运行格式化管线（纯函数编排）：
 *   formatter（失败容忍） → whitespace 归一（可选）。
 * 不接触 store / EditorView；formatter 作为依赖注入，便于单测。
 *
 * 失败容忍：formatter 抛错不阻断，标记 formatterFailed 后仍执行 whitespace 步骤，
 * 与 Zed 的「formatter 失败仍做 whitespace、不阻断保存」一致。
 */
export const runFormatPipeline = async ({
  text,
  path,
  languageId,
  formatter,
  whitespace,
}: IRunFormatPipelineArgs): Promise<TFormatPipelineResult> => {
  let working = text;
  let formatterFailed = false;
  let formatterError: string | undefined;

  if (formatter?.supports(languageId)) {
    try {
      working = await formatter.format({ text: working, path, languageId });
    } catch (error) {
      formatterFailed = true;
      formatterError = error instanceof Error ? error.message : String(error);
    }
  }

  if (whitespace) {
    working = applyWhitespaceConventions(working, whitespace);
  }

  if (working === text) {
    return { kind: 'unchanged', formatterFailed, formatterError };
  }
  return { kind: 'changed', text: working, formatterFailed, formatterError };
};

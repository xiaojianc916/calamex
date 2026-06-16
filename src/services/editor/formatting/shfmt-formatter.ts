import { formatShellScript } from '@/utils/terminal/shfmt';
import type { IFormatter } from './types';

/**
 * shell / bash 的 formatter，封装现有 shfmt。
 * shfmt 已在 Web Worker 中执行（含主线程回退，见 utils/terminal/shfmt.ts），不阻塞主线程。
 * 遇脚本语法错误会抛错，交由管线做失败容忍处理。
 */
export const shfmtFormatter: IFormatter = {
  id: 'shfmt',
  supports: (languageId) => languageId === 'shell',
  format: ({ text, path }) => formatShellScript(text, path),
};

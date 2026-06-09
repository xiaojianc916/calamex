// time 工具拆分后的公共入口（barrel）。
// 原生时间工具 get_current_time / convert_time 各自独立成文件，
// 共享逻辑（时区解析 / 快照 / 解析校验）集中在 ./time/shared.js，
// 本文件只负责编排，并保持对外导入路径与导出符号不变。
import { createConvertTimeTool } from './time/convert-time.js';
import { createGetCurrentTimeTool } from './time/get-current-time.js';
import { createTimeToolContext, type IMastraTimeToolOptions } from './time/shared.js';

export { DEFAULT_LOCAL_TIMEZONE, type IMastraTimeToolOptions } from './time/shared.js';

export const createMastraTimeTools = (
  options: IMastraTimeToolOptions = {},
): Record<'get_current_time' | 'convert_time', ReturnType<typeof createGetCurrentTimeTool>> => {
  const context = createTimeToolContext(options);
  return {
    get_current_time: createGetCurrentTimeTool(context),
    convert_time: createConvertTimeTool(context),
  };
};

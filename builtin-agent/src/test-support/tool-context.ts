import type { ToolExecutionContext } from '@mastra/core/tools';

/**
 * 测试用 ToolExecutionContext 桩。
 *
 * mastra 1.37 起，ToolExecutionContext 要求 `observe` 字段；当单测直接调用
 * `tool.execute(input, context)` 时，必须传入一个满足类型的上下文。
 * 生产环境由 mastra runtime 注入完整上下文，这里只为单测提供最小桩：
 * 一个空实现的 `observe`，其余字段在被调用到时再按需补充。
 */
export const makeToolExecutionContext = (): ToolExecutionContext<any, any, unknown> =>
    ({
        observe: () => undefined,
    } as unknown as ToolExecutionContext<any, any, unknown>);

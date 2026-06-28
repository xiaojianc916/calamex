import { Eta } from 'eta';

/**
 * 提示词模板引擎（基于 eta，替代原先的 Handlebars 实现）。
 * 渲染行为对齐 Zed `agent::Templates` 的 strict_mode：
 *
 * - **严格模式**：模板引用了上下文未提供的字段时直接抛错，而非静默渲染成空串——
 *   用 Proxy 包裹上下文实现，复刻 Handlebars `strict: true` 的语义。
 * - **原样输出**：提示词是 Markdown 纯文本而非 HTML，统一用 eta 的 `<%~` 原始标签并
 *   关闭 autoEscape，等价于 Handlebars 的 `noEscape: true`。
 *
 * 使用独立的 eta 实例，避免与进程内其他用途的配置互相污染。
 */

export interface ICompiledPromptTemplate<TContext> {
    render: (context: TContext) => string;
}

const eta = new Eta({
    autoEscape: false,
    autoTrim: false,
});

/**
 * 用 Proxy 复刻 Handlebars strict 行为：访问上下文上不存在的字符串字段即抛错；
 * Symbol 及已存在的字段照常返回。
 */
const createStrictContext = <TContext extends object>(context: TContext): TContext =>
    new Proxy(context, {
        get(target, property, receiver) {
            if (typeof property === 'string' && !Reflect.has(target, property)) {
                throw new Error(`提示词模板引用了未提供的字段：${property}`);
            }
            return Reflect.get(target, property, receiver);
        },
    });

export const compilePromptTemplate = <TContext extends object>(
    source: string,
): ICompiledPromptTemplate<TContext> => ({
    render: (context: TContext): string =>
        eta.renderString(source, createStrictContext(context)) as string,
});

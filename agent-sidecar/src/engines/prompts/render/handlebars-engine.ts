import * as Handlebars from 'handlebars';

/**
 * 一个已编译、可复用的提示词模板。渲染输入受 TContext 静态约束，
 * 渲染行为对齐 Zed `agent::Templates` 的 Handlebars strict_mode：
 * 模板中引用了 TContext 未提供的字段时直接抛错，而不是静默渲染为空串，
 * 从而避免提示词段落被悄悄改残却无人察觉。
 */
export interface IPromptTemplate<TContext> {
    render(context: TContext): string;
}

// 使用隔离的 Handlebars 环境，避免污染全局注册表、也不被全局注册表污染——
// 对齐 Zed 为 agent 模板单独建一个 registry 的做法。
const environment = Handlebars.create();

/**
 * 编译一个严格模式的提示词模板。
 *
 * - `strict`：缺字段即抛错（strict_mode 对齐）。
 * - `noEscape`：提示词是 Markdown 纯文本而非 HTML，关闭 Handlebars 默认的
 *   HTML 转义；不可信内容的防注入处理交由 `render/escape.ts` 在装配阶段完成。
 */
export const compilePromptTemplate = <TContext>(source: string): IPromptTemplate<TContext> => {
    const delegate = environment.compile<TContext>(source, {
        strict: true,
        noEscape: true,
    });

    return {
        render: (context: TContext): string => delegate(context),
    };
};

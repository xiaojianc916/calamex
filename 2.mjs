// fix-ai-review-batch-18.mjs
// 统一 prompts 渲染管线到 eta（取代 batch-17）。
//   1) eta-engine.ts：renderString（每次重解析）-> compile 预编译一次 + render 执行。
//   2) system-prompt.template.ts：3 个小模板 + 手写 render* 函数 -> 单个 eta 模板（分支/循环用
//      原生 if/forEach），TS 侧只装配强类型数据；删除并存的手写渲染，去掉新旧杂糅。
// 证据：eta v4 src/{render,compile,parse,utils}.ts —— renderString=compile+render（字符串模板不缓存）；
//      compile 返回可复用 TemplateFunction；显式 -%> 凌驾 autoTrim:false 且裁一个换行。
// 静态长文本常量（SHARED_PRINCIPLES/TOOL_POLICY_SHARED/PLAN/AGENT）原样保留。幂等。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cwd = process.cwd();
const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');

// ---------------------------------------------------------------------------
// 1) eta-engine.ts：真正预编译
// ---------------------------------------------------------------------------
const ENGINE = resolve(cwd, 'builtin-agent/src/engines/prompts/render/eta-engine.ts');

const ENGINE_OLD = [
    'export const compilePromptTemplate = <TContext extends object>(',
    '    source: string,',
    '): ICompiledPromptTemplate<TContext> => ({',
    '    render: (context: TContext): string =>',
    '        eta.renderString(source, createStrictContext(context)) as string,',
    '});',
].join('\n');

const ENGINE_NEW = [
    'export const compilePromptTemplate = <TContext extends object>(',
    '    source: string,',
    '): ICompiledPromptTemplate<TContext> => {',
    '    // 预编译一次：eta 的核心能力是 compile（模板 -> 可复用函数），渲染时仅执行。',
    '    // 旧实现用 renderString 会在每次渲染时重新解析模板，等于关掉了 eta 的预编译优势。',
    '    const templateFn = eta.compile(source);',
    '    return {',
    '        render: (context: TContext): string =>',
    '            eta.render(templateFn, createStrictContext(context)),',
    '    };',
    '};',
].join('\n');

{
    const raw = readFileSync(ENGINE, 'utf8');
    const eol = eolOf(raw);
    const lf = raw.replace(/\r\n/g, '\n');
    if (lf.includes('const templateFn = eta.compile(source);')) {
        console.log('[eta-engine] 已是预编译实现，跳过。');
    } else if (!lf.includes(ENGINE_OLD)) {
        throw new Error('[eta-engine] 未找到预期的旧 compilePromptTemplate，已中止。');
    } else {
        writeFileSync(ENGINE, lf.replace(ENGINE_OLD, ENGINE_NEW).replace(/\n/g, eol), 'utf8');
        console.log('[eta-engine] 已改为 eta.compile 预编译 + eta.render 执行。');
    }
}

// ---------------------------------------------------------------------------
// 2) system-prompt.template.ts：统一为单个 eta 模板
// ---------------------------------------------------------------------------
const TMPL = resolve(cwd, 'builtin-agent/src/engines/prompts/templates/system-prompt.template.ts');

const IMPORT_OLD = [
    'import type {',
    '    ISystemPromptContext,',
    '    ISystemPromptContextReferenceView,',
    "} from '../domain/system-prompt-context.js';",
].join('\n');
const IMPORT_NEW =
    "import type { ISystemPromptContext } from '../domain/system-prompt-context.js';";

// 从 banner 注释到文件末尾，整体替换为统一渲染实现。
const NEW_BLOCK = `// -----------------------------------------------------------------------------
// 统一渲染：整份系统提示词由单个 eta 模板（预编译一次）驱动。静态段作为数据注入，
// 分支与迭代用 eta 原生 if/forEach 表达；TS 侧只负责装配强类型数据，不再手写拼接渲染。
// -----------------------------------------------------------------------------

interface ISystemPromptRenderModel extends ISystemPromptContext {
    readonly sharedPrinciples: string;
    readonly toolPolicy: string;
    readonly modeSection: string;
    readonly extraSystemMessagesText: string;
}

const systemPromptTemplate = compilePromptTemplate<ISystemPromptRenderModel>([
    '## 身份',
    '你是 Calamex 桌面应用内置的 AI 助手',
    '当前运行模型：<%~ it.modelLabel %>（<%~ it.providerLabel %>）。',
    '你的目标：用最少的工具调用与最简洁的输出，把用户当前的问题或任务解决到位',
    '',
    '<%~ it.sharedPrinciples %>',
    '',
    '<%~ it.modeSection %>',
    '',
    '<%~ it.toolPolicy %>',
    '<% if (it.hasWorkspace) { -%>',
    '',
    '## 工作区',
    '- 根路径：\`<%~ it.workspaceRootPath %>\`',
    '<% } -%>',
    '<% if (it.hasContext) { -%>',
    '',
    '## UI 提供的上下文',
    '以下内容由用户当前界面提供，可能与本次问题相关。要不要利用、利用多少由你判断；不代表必须读取完整文件。',
    '<% it.contextReferences.forEach(function (ref) { -%>',
    '<% if (ref.isSkill) { -%>',
    '',
    '### 技能调用 #<%~ ref.index %> — <%~ ref.label %>',
    '- 用户已显式调用此技能<% if (ref.skillSlug) { %>（slug：<%~ ref.skillSlug %>）<% } %>。',
    '- 请先调用 skill_read 工具按上述 slug 读取该技能的完整内容，再据此执行用户的任务。',
    '- 不要凭名称臆测技能内容；以 skill_read 返回的正文为准。',
    '<% } else { -%>',
    '',
    '### 引用 #<%~ ref.index %> — <%~ ref.label %>',
    '- 类型：<%~ ref.kind %>',
    '- 路径：<%~ ref.pathLabel %>',
    '- 范围：<%~ ref.rangeLabel %>',
    '- 已脱敏：<%~ ref.redactedLabel %>',
    '<% if (ref.truncated) { -%>',
    '- 备注：内容已截断，仅展示前若干字符',
    '<% } -%>',
    '<%~ ref.fence %>text',
    '<%~ ref.previewText %>',
    '<%~ ref.fence %>',
    '<% } -%>',
    '<% }) -%>',
    '<% } -%>',
    '<% if (it.hasGoal) { -%>',
    '',
    '## 用户目标',
    '<%~ it.goal %>',
    '<% } -%>',
    '<% if (it.hasExtraSystemMessages) { -%>',
    '',
    '## 额外系统消息',
    '<%~ it.extraSystemMessagesText %>',
    '<% } -%>',
].join('\\n'));

const NEWLINE_COLLAPSE_PATTERN = /\\n{3,}/gu;

/** 把强类型上下文渲染为最终系统提示词：单模板渲染 + 一次空白归一化。 */
export const renderSystemPrompt = (context: ISystemPromptContext): string => {
    const rendered = systemPromptTemplate.render({
        ...context,
        sharedPrinciples: SHARED_PRINCIPLES,
        toolPolicy: TOOL_POLICY_SHARED,
        modeSection: context.isPlanMode ? PLAN_MODE_SECTION : AGENT_MODE_SECTION,
        extraSystemMessagesText: context.extraSystemMessages.join('\\n'),
    });
    return rendered.replace(NEWLINE_COLLAPSE_PATTERN, '\\n\\n').trim();
};
`;

{
    const raw = readFileSync(TMPL, 'utf8');
    const eol = eolOf(raw);
    let lf = raw.replace(/\r\n/g, '\n');

    if (lf.includes('ISystemPromptRenderModel')) {
        console.log('[template] 已是统一 eta 模板，跳过。');
    } else {
        if (!lf.includes(IMPORT_OLD)) {
            throw new Error('[template] 未找到预期的旧 import 块，已中止。');
        }
        lf = lf.replace(IMPORT_OLD, IMPORT_NEW);

        const marker = '// Dynamic sections（eta 插值用于纯变量段';
        const mIdx = lf.indexOf(marker);
        if (mIdx < 0) throw new Error('[template] 未找到 Dynamic sections 注释锚点，已中止。');
        const bannerStart = lf.lastIndexOf('// ---', mIdx);
        if (bannerStart < 0) throw new Error('[template] 未找到 banner 起点，已中止。');

        lf = lf.slice(0, bannerStart) + NEW_BLOCK;
        writeFileSync(TMPL, lf.replace(/\n/g, eol), 'utf8');
        console.log('[template] 已统一为单个 eta 模板，删除手写 render* 函数。');
    }
}

console.log('batch-18 完成。');
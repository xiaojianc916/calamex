// fix-ai-review-batch-17.mjs
// M1（修正版）：让 prompts 的 eta 包装真正使用官方预编译能力。
// compilePromptTemplate 从「每次 renderString 重新解析」改为「compile 预编译一次 + render 执行」。
// 证据：eta v4 src/render.ts 中 renderString = compile + render（每次重编，字符串模板不缓存）；
//       src/compile.ts 中 compile(str) 返回可复用的 TemplateFunction。
// 幂等、单文件、与其它 batch 无依赖。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = resolve(
    process.cwd(),
    'builtin-agent/src/engines/prompts/render/eta-engine.ts',
);

const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');

const OLD = [
    'export const compilePromptTemplate = <TContext extends object>(',
    '    source: string,',
    '): ICompiledPromptTemplate<TContext> => ({',
    '    render: (context: TContext): string =>',
    '        eta.renderString(source, createStrictContext(context)) as string,',
    '});',
].join('\n');

const NEW = [
    'export const compilePromptTemplate = <TContext extends object>(',
    '    source: string,',
    '): ICompiledPromptTemplate<TContext> => {',
    '    // 预编译一次：eta 的核心能力是 compile（模板 -> 可复用函数），渲染时仅执行。',
    '    // 旧实现用 renderString 会在每次渲染时重新解析模板字符串，等于关掉了 eta 的预编译优势。',
    '    const templateFn = eta.compile(source);',
    '    return {',
    '        render: (context: TContext): string =>',
    '            eta.render(templateFn, createStrictContext(context)),',
    '    };',
    '};',
].join('\n');

const raw = readFileSync(FILE, 'utf8');
const eol = eolOf(raw);
const lf = raw.replace(/\r\n/g, '\n');

if (lf.includes('const templateFn = eta.compile(source);')) {
    console.log('已是预编译实现，跳过。');
    process.exit(0);
}
if (!lf.includes(OLD)) {
    throw new Error('未找到预期的 compilePromptTemplate 旧实现，已中止（请核对文件是否已改动）。');
}

const out = lf.replace(OLD, NEW).replace(/\n/g, eol);
writeFileSync(FILE, out, 'utf8');
console.log('已将 compilePromptTemplate 改为 eta.compile 预编译 + eta.render 执行。');
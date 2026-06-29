// fix-ai-review-batch-14.mjs
// 批次 14：plan 族错误码一致性收尾 —— plan.ts / validation.ts / replanPlan 的
//   provider 错误点统一回传 errorCode（对齐 batch-12 在 execution.ts 的做法）。
// 依赖：建立在 fix-ai-review-batch-13.mjs 之上（需要 summary.streamErrorCode）。
// 运行顺序：…→ batch-13 → batch-14。
// 运行后：pnpm -C builtin-agent typecheck && pnpm -C builtin-agent test && pnpm lint:all
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'builtin-agent/src/engines/modes';
const F_PLAN = `${ROOT}/plan.ts`;
const F_VALIDATION = `${ROOT}/validation.ts`;

const eolOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n');
const load = (file) => {
    const raw = readFileSync(file, 'utf8');
    const eol = eolOf(raw);
    const hadFinal = raw.endsWith(eol);
    const body = hadFinal ? raw.slice(0, -eol.length) : raw;
    return { file, lines: body.split(eol), eol, hadFinal };
};
const save = (doc) => {
    let out = doc.lines.join(doc.eol);
    if (doc.hadFinal) out += doc.eol;
    writeFileSync(doc.file, out, 'utf8');
};
const findSeq = (lines, seq) => {
    const hits = [];
    for (let i = 0; i + seq.length <= lines.length; i++) {
        let ok = true;
        for (let j = 0; j < seq.length; j++) if (lines[i + j] !== seq[j]) { ok = false; break; }
        if (ok) hits.push(i);
    }
    return hits;
};
const replaceLine = (doc, oldLine, newLine, label) => {
    if (doc.lines.includes(newLine) && !doc.lines.includes(oldLine)) { console.log(`  · ${label}: 已是目标态，跳过`); return; }
    const a = findSeq(doc.lines, [oldLine]);
    if (a.length !== 1) throw new Error(`${label}: 原始行应唯一(1)，实际 ${a.length}`);
    doc.lines[a[0]] = newLine;
    console.log(`  ✓ ${label}`);
};
const replaceBlock = (doc, oldLines, newLines, label) => {
    const newAt = findSeq(doc.lines, newLines);
    const oldAt = findSeq(doc.lines, oldLines);
    if (newAt.length >= 1 && oldAt.length === 0) { console.log(`  · ${label}: 已是目标态，跳过`); return; }
    if (oldAt.length === 0) throw new Error(`${label}: 未找到原始块`);
    if (oldAt.length > 1) throw new Error(`${label}: 原始块不唯一(${oldAt.length})`);
    doc.lines.splice(oldAt[0], oldLines.length, ...newLines);
    console.log(`  ✓ ${label}`);
};

// ---- plan.ts ----
console.log(F_PLAN);
{
    const doc = load(F_PLAN);
    // 1) 导入 classifyProviderErrorCode
    replaceLine(doc,
        "import { normalizeMastraError } from '../shared/errors.js';",
        "import { classifyProviderErrorCode, normalizeMastraError } from '../shared/errors.js';",
        'plan import classifyProviderErrorCode');
    // 2) TStreamStructuredPlanResult error 变体增加可选 errorCode
    replaceLine(doc,
        "    | { status: 'error'; message: string; releaseResources: boolean };",
        "    | { status: 'error'; message: string; errorCode?: string; releaseResources: boolean };",
        'plan TStreamStructuredPlanResult.errorCode');
    // 3) streamStructuredPlanObject error 返回透传 errorCode
    replaceBlock(doc, [
        '        if (summary.streamErrorMessage) {',
        '            return { status: \'error\', message: summary.streamErrorMessage, releaseResources: summary.releaseResources };',
        '        }',
    ], [
        '        if (summary.streamErrorMessage) {',
        '            return {',
        "                status: 'error',",
        '                message: summary.streamErrorMessage,',
        '                ...(summary.streamErrorCode ? { errorCode: summary.streamErrorCode } : {}),',
        '                releaseResources: summary.releaseResources,',
        '            };',
        '        }',
    ], 'plan streamStructuredPlanObject 透传 errorCode');
    // 4) plan() stream-error 分支回传 errorCode（缩进 20/24）
    replaceBlock(doc, [
        '                    return createErrorResponse(',
        '                        sessionId,',
        '                        `Mastra Plan 执行失败：${streamed.message}`,',
        '                        events,',
        '                        options,',
        '                    );',
    ], [
        '                    return createErrorResponse(',
        '                        sessionId,',
        '                        `Mastra Plan 执行失败：${streamed.message}`,',
        '                        events,',
        '                        options,',
        '                        streamed.errorCode ?? classifyProviderErrorCode(streamed.message),',
        '                    );',
    ], 'plan stream-error errorCode');
    // 5) plan() catch 回传 errorCode（缩进 12/16）
    replaceBlock(doc, [
        '            return createErrorResponse(',
        '                sessionId,',
        '                `Mastra Plan 执行失败：${normalizeMastraError(error)}`,',
        '                events,',
        '                options,',
        '            );',
    ], [
        '            return createErrorResponse(',
        '                sessionId,',
        '                `Mastra Plan 执行失败：${normalizeMastraError(error)}`,',
        '                events,',
        '                options,',
        '                classifyProviderErrorCode(error),',
        '            );',
    ], 'plan catch errorCode');
    save(doc);
}

// ---- validation.ts ----
console.log(F_VALIDATION);
{
    const doc = load(F_VALIDATION);
    // 1) 导入 classifyProviderErrorCode
    replaceLine(doc,
        "import { normalizeMastraError } from '../shared/errors.js';",
        "import { classifyProviderErrorCode, normalizeMastraError } from '../shared/errors.js';",
        'validation import classifyProviderErrorCode');
    // 2) validatePlan stream-error（缩进 16/20）
    replaceBlock(doc, [
        '                return createErrorResponse(',
        '                    sessionId,',
        '                    `Validator 执行失败：${streamed.message}`,',
        '                    events,',
        '                    options,',
        '                );',
    ], [
        '                return createErrorResponse(',
        '                    sessionId,',
        '                    `Validator 执行失败：${streamed.message}`,',
        '                    events,',
        '                    options,',
        '                    streamed.errorCode ?? classifyProviderErrorCode(streamed.message),',
        '                );',
    ], 'validatePlan stream-error errorCode');
    // 3) validatePlan catch（缩进 12/16）
    replaceBlock(doc, [
        '            return createErrorResponse(',
        '                sessionId,',
        '                `Validator 执行失败：${normalizeMastraError(error)}`,',
        '                events,',
        '                options,',
        '            );',
    ], [
        '            return createErrorResponse(',
        '                sessionId,',
        '                `Validator 执行失败：${normalizeMastraError(error)}`,',
        '                events,',
        '                options,',
        '                classifyProviderErrorCode(error),',
        '            );',
    ], 'validatePlan catch errorCode');
    // 4) replanPlan stream-error（缩进 16/20）
    replaceBlock(doc, [
        '                return createErrorResponse(',
        '                    sessionId,',
        '                    `Replanner 执行失败：${streamed.message}`,',
        '                    events,',
        '                    options,',
        '                );',
    ], [
        '                return createErrorResponse(',
        '                    sessionId,',
        '                    `Replanner 执行失败：${streamed.message}`,',
        '                    events,',
        '                    options,',
        '                    streamed.errorCode ?? classifyProviderErrorCode(streamed.message),',
        '                );',
    ], 'replanPlan stream-error errorCode');
    // 5) replanPlan catch（缩进 12/16）
    replaceBlock(doc, [
        '            return createErrorResponse(',
        '                sessionId,',
        '                `Replanner 执行失败：${normalizeMastraError(error)}`,',
        '                events,',
        '                options,',
        '            );',
    ], [
        '            return createErrorResponse(',
        '                sessionId,',
        '                `Replanner 执行失败：${normalizeMastraError(error)}`,',
        '                events,',
        '                options,',
        '                classifyProviderErrorCode(error),',
        '            );',
    ], 'replanPlan catch errorCode');
    save(doc);
}

console.log('batch-14 完成。');
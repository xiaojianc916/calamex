// fix-ai-review-batch-12.mjs
// 批次 12（J5）：把 errorCode / retryable 接到既有 provider 错误分类器
//   - shared/errors.ts：新增 isRetryableProviderError（2 空格缩进）
//   - modes/execution.ts：两处失败点接 classifyProviderErrorCode + isRetryableProviderError（4 空格缩进）
// 幂等：可重复运行；锚点不唯一/不匹配则中止，绝不写坏文件。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ERRORS_REL = 'builtin-agent/src/engines/shared/errors.ts';
const EXEC_REL = 'builtin-agent/src/engines/modes/execution.ts';

// ---------- 基础设施 ----------
function eolOf(text) {
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/(?<!\r)\n/g) || []).length;
    return crlf > lf ? '\r\n' : '\n';
}
function load(file) {
    const raw = readFileSync(file, 'utf8');
    const eol = eolOf(raw);
    const hadFinalNewline = /\n$/.test(raw);
    const lines = raw.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    return { lines, eol, hadFinalNewline };
}
function save(file, doc) {
    let out = doc.lines.join(doc.eol);
    if (doc.hadFinalNewline) out += doc.eol;
    writeFileSync(file, out, 'utf8');
}
function countLine(lines, target) {
    let n = 0;
    for (const l of lines) if (l === target) n++;
    return n;
}
function indexOfUnique(lines, target, label) {
    const n = countLine(lines, target);
    if (n > 1) throw new Error(`锚点不唯一(${n}处)，已中止: ${label} -> ${JSON.stringify(target)}`);
    return lines.indexOf(target);
}
// 在 lines 中查找连续块 seq，返回 { index, count }
function findSeq(lines, seq) {
    let index = -1;
    let count = 0;
    for (let i = 0; i + seq.length <= lines.length; i++) {
        let ok = true;
        for (let j = 0; j < seq.length; j++) {
            if (lines[i + j] !== seq[j]) { ok = false; break; }
        }
        if (ok) { if (index < 0) index = i; count++; }
    }
    return { index, count };
}

function replaceLine(doc, label, oldLine, newLine) {
    if (countLine(doc.lines, newLine) >= 1) { console.log(`= 跳过(已替换): ${label}`); return; }
    const idx = indexOfUnique(doc.lines, oldLine, label);
    if (idx < 0) throw new Error(`未找到待替换行，已中止: ${label} -> ${JSON.stringify(oldLine)}`);
    doc.lines[idx] = newLine;
    console.log(`✓ 替换行: ${label}`);
}

// 用 newLines 替换唯一出现的 oldLines 块；若 newLines 已存在则跳过（幂等）
function replaceBlock(doc, label, oldLines, newLines) {
    const newFound = findSeq(doc.lines, newLines);
    if (newFound.count >= 1 && findSeq(doc.lines, oldLines).count === 0) {
        console.log(`= 跳过(已替换): ${label}`); return;
    }
    const { index, count } = findSeq(doc.lines, oldLines);
    if (count === 0) throw new Error(`未找到待替换块，已中止: ${label}`);
    if (count > 1) throw new Error(`待替换块不唯一(${count}处)，已中止: ${label}`);
    doc.lines.splice(index, oldLines.length, ...newLines);
    console.log(`✓ 替换块: ${label}（${oldLines.length} → ${newLines.length} 行）`);
}

// 在文件末尾追加块（幂等：signatureLine 已存在则跳过）
function appendBlock(doc, label, blockLines, signatureLine) {
    if (countLine(doc.lines, signatureLine) >= 1) { console.log(`= 跳过(已追加): ${label}`); return; }
    doc.lines.push(...blockLines);
    console.log(`✓ 追加块: ${label}（${blockLines.length} 行）`);
}

// ---------- 1) shared/errors.ts（2 空格缩进）----------
{
    const file = resolve(process.cwd(), ERRORS_REL);
    const doc = load(file);
    console.log(`处理: ${ERRORS_REL}（EOL=${doc.eol === '\r\n' ? 'CRLF' : 'LF'}）`);

    appendBlock(
        doc,
        'J5-a 新增 isRetryableProviderError',
        [
            '',
            '/**',
            ' * 由 provider 错误分类码推导步骤失败是否值得重试。',
            ' * - 鉴权失败 / 未配置属确定性错误，重试无意义 → false。',
            ' * - 限流与未知错误按瞬时处理 → true（与既有“一律可重试”兼容，宁可多试一次）。',
            ' */',
            'export const isRetryableProviderError = (errorCode: string | undefined): boolean =>',
            "  errorCode !== 'AI_PROVIDER_AUTH_FAILED' && errorCode !== 'AI_PROVIDER_NOT_CONFIGURED';",
        ],
        'export const isRetryableProviderError = (errorCode: string | undefined): boolean =>',
    );

    save(file, doc);
}

// ---------- 2) modes/execution.ts（4 空格缩进）----------
{
    const file = resolve(process.cwd(), EXEC_REL);
    const doc = load(file);
    console.log(`处理: ${EXEC_REL}（EOL=${doc.eol === '\r\n' ? 'CRLF' : 'LF'}）`);

    // J5-b 扩展 errors.js 导入
    replaceLine(
        doc,
        'J5-b 导入分类器',
        "import { normalizeMastraError } from '../shared/errors.js';",
        "import { classifyProviderErrorCode, isRetryableProviderError, normalizeMastraError } from '../shared/errors.js';",
    );

    // J5-c stream 错误分支：接 errorCode + retryable
    replaceBlock(
        doc,
        'J5-c stream 失败点接线',
        [
            '                await this.planWorkflowStore.failStep({',
            '                    planId,',
            '                    version: Number(planVersion),',
            '                    stepId: planStepId,',
            '                    error: streamSummary.streamErrorMessage,',
            '                    retryable: true,',
            '                });',
            '                return createErrorResponse(',
            '                    sessionId,',
            '                    `Mastra Agent 执行失败：${streamSummary.streamErrorMessage}`,',
            '                    events,',
            '                    options,',
            '                );',
        ],
        [
            '                const streamErrorCode = classifyProviderErrorCode(streamSummary.streamErrorMessage);',
            '                await this.planWorkflowStore.failStep({',
            '                    planId,',
            '                    version: Number(planVersion),',
            '                    stepId: planStepId,',
            '                    error: streamSummary.streamErrorMessage,',
            '                    retryable: isRetryableProviderError(streamErrorCode),',
            '                });',
            '                return createErrorResponse(',
            '                    sessionId,',
            '                    `Mastra Agent 执行失败：${streamSummary.streamErrorMessage}`,',
            '                    events,',
            '                    options,',
            '                    streamErrorCode,',
            '                );',
        ],
    );

    // J5-d catch 分支：声明 errorCode + retryable 接线
    replaceBlock(
        doc,
        'J5-d catch 失败点接线',
        [
            '            const errorMessage = normalizeMastraError(error);',
            '            executionSession.failTurn(executionTurn.id, { errorMessage });',
            '            await this.planWorkflowStore.failStep({',
            '                planId,',
            '                version: Number(planVersion),',
            '                stepId: planStepId,',
            '                error: errorMessage,',
            '                retryable: true,',
            '            }).catch(() => undefined);',
        ],
        [
            '            const errorMessage = normalizeMastraError(error);',
            '            const errorCode = classifyProviderErrorCode(error);',
            '            executionSession.failTurn(executionTurn.id, { errorMessage });',
            '            await this.planWorkflowStore.failStep({',
            '                planId,',
            '                version: Number(planVersion),',
            '                stepId: planStepId,',
            '                error: errorMessage,',
            '                retryable: isRetryableProviderError(errorCode),',
            '            }).catch(() => undefined);',
        ],
    );

    // J5-e catch 分支 createErrorResponse 回传 errorCode
    replaceBlock(
        doc,
        'J5-e catch createErrorResponse 回传 errorCode',
        [
            '            return createErrorResponse(',
            '                sessionId,',
            '                `Mastra Agent 执行失败：${errorMessage}`,',
            '                events,',
            '                options,',
            '            );',
        ],
        [
            '            return createErrorResponse(',
            '                sessionId,',
            '                `Mastra Agent 执行失败：${errorMessage}`,',
            '                events,',
            '                options,',
            '                errorCode,',
            '            );',
        ],
    );

    save(file, doc);
}

console.log('完成：fix-ai-review-batch-12.mjs');
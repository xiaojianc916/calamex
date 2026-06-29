// fix-ai-review-batch-13.mjs
// 批次 13：J6（stream 结构化错误码透传，落实 J5 闭环）+ J7（ask_user 注释去重）
// 依赖：J6 的 execution.ts 改动建立在 fix-ai-review-batch-12.mjs 之上 —— 必须先运行 batch-12。
// 独立提交，运行后：pnpm -C builtin-agent typecheck && pnpm -C builtin-agent test && pnpm lint:all
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'builtin-agent/src/engines';
const F_TYPES = `${ROOT}/shared/types.ts`;
const F_BASE = `${ROOT}/runtime/base.ts`;
const F_EXEC = `${ROOT}/modes/execution.ts`;

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
const insertAfter = (doc, anchor, newLines, label) => {
    const a = findSeq(doc.lines, [anchor]);
    if (a.length !== 1) throw new Error(`${label}: 锚点应唯一(1)，实际 ${a.length}: ${JSON.stringify(anchor)}`);
    if (doc.lines[a[0] + 1] === newLines[0]) { console.log(`  · ${label}: 已插入，跳过`); return; }
    doc.lines.splice(a[0] + 1, 0, ...newLines);
    console.log(`  ✓ ${label}`);
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
// execution.ts J6-d：把 batch-12 那行 streamErrorCode 声明升级为"优先结构化码、回退消息子串"。
const upgradeStreamErrorCode = (doc, label) => {
    if (doc.lines.some((l) => l.includes('streamSummary.streamErrorCode ??'))) { console.log(`  · ${label}: 已升级，跳过`); return; }
    const src = 'const streamErrorCode = classifyProviderErrorCode(streamSummary.streamErrorMessage);';
    const idxs = [];
    doc.lines.forEach((l, i) => { if (l.trimStart() === src) idxs.push(i); });
    if (idxs.length === 0) throw new Error(`${label}: 未找到 batch-12 生成的 streamErrorCode 声明——请先运行 fix-ai-review-batch-12.mjs`);
    if (idxs.length > 1) throw new Error(`${label}: streamErrorCode 声明不唯一(${idxs.length})`);
    const i = idxs[0];
    const indent = doc.lines[i].slice(0, doc.lines[i].length - doc.lines[i].trimStart().length);
    doc.lines.splice(i, 1,
        `${indent}const streamErrorCode = streamSummary.streamErrorCode`,
        `${indent}    ?? classifyProviderErrorCode(streamSummary.streamErrorMessage);`,
    );
    console.log(`  ✓ ${label}`);
};

// ---- File 1: shared/types.ts (CRLF / 4-space) — J6-a：summary 增加可选 streamErrorCode ----
console.log(F_TYPES);
{
    const doc = load(F_TYPES);
    insertAfter(doc, '    streamErrorMessage: string | null;', ['    streamErrorCode?: string;'], 'J6-a IMastraTextStreamSummary.streamErrorCode');
    save(doc);
}

// ---- File 2: runtime/base.ts (LF / 4-space) — J6-b/c + J7 ----
console.log(F_BASE);
{
    const doc = load(F_BASE);
    // J6-b 导入 classifyProviderErrorCode
    replaceLine(doc,
        "import { normalizeMastraError } from '../shared/errors.js';",
        "import { classifyProviderErrorCode, normalizeMastraError } from '../shared/errors.js';",
        'J6-b import classifyProviderErrorCode');
    // J6-c1 局部声明
    insertAfter(doc, '        let streamErrorMessage: string | null = null;',
        ['        let streamErrorCode: string | undefined;'],
        'J6-c1 streamErrorCode 局部变量');
    // J6-c2 error chunk 分支：用原始 error 对象出精确码
    replaceBlock(doc, [
        '            if (isErrorChunk(chunk)) {',
        '                streamErrorMessage = normalizeMastraError(chunk.payload.error);',
        '                continue;',
        '            }',
    ], [
        '            if (isErrorChunk(chunk)) {',
        '                streamErrorMessage = normalizeMastraError(chunk.payload.error);',
        '                streamErrorCode = classifyProviderErrorCode(chunk.payload.error);',
        '                continue;',
        '            }',
    ], 'J6-c2 isErrorChunk 分类');
    // J6-c3 return summary 透传
    insertAfter(doc, '            streamErrorMessage,',
        ['            ...(streamErrorCode ? { streamErrorCode } : {}),'],
        'J6-c3 summary 回传 streamErrorCode');
    // J7 合并重复的 ask_user 注释（16 空格缩进）
    replaceBlock(doc, [
        '                // ask_user：反向提问工具挂起时，surface 为结构化 ask_user_required（带外承载，',
        '                // 镜像 approval_required），而非降级成单一 approve/reject 气泡；恢复经专用 ext',
        '                // 方法回传富答案续跑（见 acp/ext-methods 的 ask-user resume，2c 落地）。其余挂起',
        '                // 工具仍走下方通用 approval_required 兜底。',
        '                // ask_user：反向提问工具挂起 —— 始终 surface 结构化 ask_user_required，绝不降级到旧的',
        '                // approve/reject 审批气泡（杜绝新旧杂糅）。挂起负载由本工具按 suspendSchema 自构造；权威的跨进程',
        '                // 校验在 sidecar→renderer 边界（前端 extractPendingAskUser 再行 zod 解析），此处 safeParse 仅作',
        '                // 进程内类型收窄。万一（按契约不可达）失败：既不回灌审批链、也不终结回合，仅跳过本次 surface，',
        '                // 挂起句柄交由 TTL 回收。',
    ], [
        '                // ask_user：反向提问工具挂起 —— 始终 surface 结构化 ask_user_required（带外承载，镜像',
        '                // approval_required），绝不降级到旧的 approve/reject 审批气泡（杜绝新旧杂糅）；恢复经专用',
        '                // ext 方法回传富答案续跑（见 acp/ext-methods 的 ask-user resume，2c 落地）。其余挂起工具',
        '                // 仍走下方通用 approval_required 兜底。挂起负载由本工具按 suspendSchema 自构造；权威的跨',
        '                // 进程校验在 sidecar→renderer 边界（前端 extractPendingAskUser 再行 zod 解析），此处',
        '                // safeParse 仅作进程内类型收窄。万一（按契约不可达）失败：既不回灌审批链、也不终结回合，',
        '                // 仅跳过本次 surface，挂起句柄交由 TTL 回收。',
    ], 'J7 合并重复 ask_user 注释');
    save(doc);
}

// ---- File 3: modes/execution.ts (LF / 4-space) — J6-d：消费结构化码（依赖 batch-12）----
console.log(F_EXEC);
{
    const doc = load(F_EXEC);
    upgradeStreamErrorCode(doc, 'J6-d execution.ts 优先结构化码');
    save(doc);
}

console.log('batch-13 完成。');
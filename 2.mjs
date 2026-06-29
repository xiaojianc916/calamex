// fix-ai-review-batch-16.mjs
// 批次 16（L1）：移除 budget.ts 的 text-metrics 再导出兼容层。
//
// 安全策略：先遍历 builtin-agent/src 全部 .ts，扫描是否有文件从 budget 模块
// 引入/再导出 countJsonChars / countTextChars / estimateInputTokensByChars /
// stringifyForBudget（含 import{} / export{}from / import * as 三态）。
//   · 发现任何外部 importer → 立即中止、不动任何文件，打印清单（交后续精确 repoint）。
//   · 零 importer（预期：随 deepseek 转官方原生，该消费者已删，再导出为死代码）
//     → 删 budget.ts 再导出块 + 把内部 2 处 stringifyForBudget 改回 stringifyForJson。
// 幂等。独立改动，不依赖其它批次。
// 运行后：pnpm -C builtin-agent typecheck && pnpm -C builtin-agent test && pnpm lint:all
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const SRC = 'builtin-agent/src';
const BUDGET_TS = resolve(SRC, 'engines/budget/budget.ts');
const TARGET_SET = new Set([
    'countJsonChars',
    'countTextChars',
    'estimateInputTokensByChars',
    'stringifyForBudget',
]);

// ----------------------------------------------------------- 扫描 importer
const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
        const p = resolve(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
};
const specResolvesToBudget = (file, spec) => {
    if (!spec.startsWith('.')) return false; // 第三方包不可能是 budget
    return resolve(dirname(file), spec.replace(/\.js$/, '.ts')) === BUDGET_TS;
};
const namesFromBraces = (inner) =>
    inner.split(',').map((s) => s.trim()).filter(Boolean)
        .map((b) => (b.match(/^(?:type\s+)?([A-Za-z0-9_$]+)/) || [])[1])
        .filter(Boolean);
const BRACE_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g;
const EXPORT_FROM_RE = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g;
const NS_IMPORT_RE = /import\s+\*\s+as\s+[A-Za-z0-9_$]+\s+from\s*(['"])([^'"]+)\1/g;

const scanFile = (file) => {
    const raw = readFileSync(file, 'utf8');
    const hits = [];
    for (const re of [BRACE_IMPORT_RE, EXPORT_FROM_RE]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(raw)) !== null) {
            if (!specResolvesToBudget(file, m[3])) continue;
            const used = namesFromBraces(m[1]).filter((n) => TARGET_SET.has(n));
            if (used.length) hits.push(`${used.join(', ')}  «${m[0].split('\n')[0].trim()} …»`);
        }
    }
    NS_IMPORT_RE.lastIndex = 0;
    let n;
    while ((n = NS_IMPORT_RE.exec(raw)) !== null) {
        if (specResolvesToBudget(file, n[2])) hits.push(`命名空间导入(需人工核查): ${n[0].trim()}`);
    }
    return hits;
};

console.log('扫描 budget 再导出 importer …');
const allTs = walk(resolve(SRC));
const importers = [];
for (const f of allTs) {
    if (resolve(f) === BUDGET_TS) continue;
    const hits = scanFile(f);
    if (hits.length) importers.push({ file: f, hits });
}
console.log(`  已扫描 ${allTs.length} 个 .ts 文件。`);

if (importers.length > 0) {
    console.error('\n发现外部 importer，已中止（未改动任何文件）。请先对以下文件精确 repoint 再重试：');
    for (const { file, hits } of importers) {
        console.error(`  - ${file}`);
        for (const h of hits) console.error(`      · ${h}`);
    }
    throw new Error(`L1 中止：存在 ${importers.length} 个 budget 再导出 importer，需先 repoint。`);
}
console.log('  ✓ 零外部 importer —— 再导出确为死代码，安全移除。');

// ----------------------------------------------------------- 清理 budget.ts
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
const removeBlock = (doc, seq, label) => {
    const at = findSeq(doc.lines, seq);
    if (at.length === 0) { console.log(`  · ${label}: 已移除，跳过`); return; }
    if (at.length > 1) throw new Error(`${label}: 待删块不唯一(${at.length})`);
    doc.lines.splice(at[0], seq.length);
    console.log(`  ✓ ${label}`);
};
const replaceLine = (doc, oldLine, newLine, label) => {
    if (doc.lines.includes(newLine) && !doc.lines.includes(oldLine)) { console.log(`  · ${label}: 已是目标态，跳过`); return; }
    const at = findSeq(doc.lines, [oldLine]);
    if (at.length !== 1) throw new Error(`${label}: 原始行应唯一(1)，实际 ${at.length}`);
    doc.lines[at[0]] = newLine;
    console.log(`  ✓ ${label}`);
};

console.log('清理 budget.ts …');
{
    const doc = load(BUDGET_TS);
    removeBlock(doc, [
        '// Char/token helpers now live in ../../text-metrics.js. Re-exported here so the',
        '// existing import surface of this module is preserved.',
        'export { countJsonChars, countTextChars, estimateInputTokensByChars };',
        'export const stringifyForBudget = stringifyForJson;',
        '',
    ], 'budget.ts 移除再导出兼容层');
    replaceLine(doc,
        '    const messagesText = stringifyForBudget(input.messages);',
        '    const messagesText = stringifyForJson(input.messages);',
        'budget.ts messagesText → stringifyForJson');
    replaceLine(doc,
        '    const toolsText = stringifyForBudget(Object.entries(input.tools).map(([name, tool]) =>',
        '    const toolsText = stringifyForJson(Object.entries(input.tools).map(([name, tool]) =>',
        'budget.ts toolsText → stringifyForJson');
    save(doc);
}
console.log('batch-16 完成。');
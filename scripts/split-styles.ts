// scripts/split-styles.ts —— 一次性脚本：按编号区块拆分 src/styles.css
// 用完即删。安全网为 git（运行前确保工作区干净）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'styles.css');
const OUT_DIR = join(ROOT, 'src', 'styles');

const raw = readFileSync(SRC, 'utf8');

// 匹配区块标记：/* ===\n * N. 标题\n * === */（=== 与 /* 同行）
const SECTION_RE =
    /\/\*\s*=+\s*\r?\n\s*\*\s*(\d+)\.\s*([^\r\n]+?)\s*\r?\n\s*\*\s*=+\s*\*\//g;

type Mark = { num: number; title: string; start: number };
const marks: Mark[] = [];
for (let m: RegExpExecArray | null; (m = SECTION_RE.exec(raw));) {
    marks.push({ num: Number(m[1]), title: m[2].trim(), start: m.index });
}
if (marks.length === 0) {
    console.error('未找到任何编号区块标记，终止（请检查 styles.css 是否仍是带 /* === N. === */ 注释的原文件）。');
    process.exit(1);
}
if (existsSync(OUT_DIR)) {
    console.error(`目录已存在：${OUT_DIR}\n为避免覆盖，请先删除该目录或确认后重跑（git 可回退）。`);
    process.exit(1);
}

// head = 第 1 个区块标记之前的内容（vendor @import + @plugin/@custom-variant + 头注释）
const head = raw.slice(0, marks[0].start);

// 每个区块内容（含自身标记注释），按起点切分
const sections = marks.map((mk, i) => ({
    ...mk,
    body: raw
        .slice(mk.start, i + 1 < marks.length ? marks[i + 1].start : raw.length)
        .trimEnd(),
}));

// head 内：vendor @import 行留在入口；其余（@plugin/@custom-variant/注释）进 theme.css
const vendorImports: string[] = [];
const themeHeadLines: string[] = [];
for (const line of head.split(/\r?\n/)) {
    if (/^\s*@import\b/.test(line)) vendorImports.push(line.trim());
    else themeHeadLines.push(line);
}
const themeHead = themeHeadLines.join('\n').trim();

const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// 安全检查：区块体内不应再出现 @import；相对 url() 移动后需补 ../
const warnings: string[] = [];
for (const s of sections) {
    if (/^\s*@import\b/m.test(s.body))
        warnings.push(`区块 ${s.num}.${s.title} 内含 @import（需人工确认顺序）`);
    const urls = s.body.match(/url\(\s*['"]?(?!data:|https?:|#|\/)[^)'"]+['"]?\s*\)/g);
    if (urls) warnings.push(`区块 ${s.num}.${s.title} 含相对 url()：${urls.join(', ')} —— 移动到 src/styles/ 后路径需改为 ../`);
}

mkdirSync(OUT_DIR, { recursive: true });
const importLines: string[] = [];

// 第 1 区块（设计令牌 @theme inline）与 @plugin/@custom-variant 同归 theme.css
writeFileSync(
    join(OUT_DIR, 'theme.css'),
    [themeHead, '', sections[0].body, ''].join('\n'),
);
importLines.push(`@import './styles/theme.css';`);

// 其余区块各自成文件，命名 NN-标题.css
for (const s of sections.slice(1)) {
    const name = `${String(s.num).padStart(2, '0')}-${slug(s.title)}.css`;
    writeFileSync(join(OUT_DIR, name), s.body + '\n');
    importLines.push(`@import './styles/${name}';`);
}

// 重写入口：仅 vendor @import + 分片清单（全部 @import 置顶，满足 Tailwind v4 约束）
writeFileSync(
    SRC,
    [
        '/* 入口：仅保留 vendor @import 与分片清单；具体样式见 src/styles/。 */',
        ...vendorImports,
        '',
        ...importLines,
        '',
    ].join('\n'),
);

console.log(`✅ 完成：theme.css + ${sections.length - 1} 个区块文件 → src/styles/`);
console.log(`   入口现为 ${vendorImports.length} 条 vendor @import + ${importLines.length} 条分片 @import`);
if (warnings.length) {
    console.log('\n⚠️ 需人工确认（否则可能影响渲染）：');
    for (const w of warnings) console.log('  - ' + w);
} else {
    console.log('   无相对 url() / 内联 @import 风险项。');
}
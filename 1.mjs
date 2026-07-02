// scripts/inline-critical-font.mjs  （EOL 无关版）
// 首帧即最终字体：woff2 → public/（稳定 URL）；@font-face + preload 内联进 index.html；
// 删除 main.ts 的 JS import 与 inter.css（单一源）。CRLF/LF 工作树均可运行。
// 用法：node scripts/inline-critical-font.mjs           (dry-run)
//       node scripts/inline-critical-font.mjs --apply   (写盘)
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, rmdirSync,
} from 'node:fs';
import { resolve } from 'node:path';

const APPLY = process.argv.includes('--apply');
const R = (p) => resolve(process.cwd(), p);
const MARKER = 'FONT_INLINE_PRELOAD_MARKER';

// —— EOL 无关读写：匹配用 LF，写回按原文件 EOL 还原 ——
const readText = (p) => {
  const raw = readFileSync(p, 'utf8');
  return { nl: raw.includes('\r\n') ? '\r\n' : '\n', text: raw.replace(/\r\n/g, '\n') };
};
const toEol = (text, nl) => (nl === '\r\n' ? text.replace(/\n/g, '\r\n') : text);

const SRC_WOFF2 = R('src/assets/fonts/inter/InterVariable.woff2');
const DST_DIR = R('public/fonts');
const DST_WOFF2 = R('public/fonts/InterVariable.woff2');
const INTER_CSS = R('src/assets/fonts/inter/inter.css');
const MAIN_TS = R('src/app/main.ts');
const INDEX_HTML = R('index.html');

const MAIN_IMPORT = `import '@/assets/fonts/inter/inter.css';\n`;

const HTML_ANCHOR = `  <title>Calamex</title>\n  <style>\n`;
const HTML_REPLACEMENT =
  `  <title>Calamex</title>\n` +
  `  <!-- ${MARKER}: 关键字体在 HTML 解析时即被发现并并行 preload，首帧直接以最终字体渲染，\n` +
  `       消除 FOUT/字体 swap。字体置于 public/（稳定 URL，Tauri 按 dist 根提供服务）。\n` +
  `       唯一字体源：不再经 main.ts 的 JS import inter.css。 -->\n` +
  `  <link rel="preload" href="/fonts/InterVariable.woff2" as="font" type="font/woff2" crossorigin />\n` +
  `  <style>\n` +
  `    @font-face {\n` +
  `      font-family: 'Inter';\n` +
  `      font-weight: 100 900;\n` +
  `      font-style: normal;\n` +
  `      font-display: swap;\n` +
  `      src: url('/fonts/InterVariable.woff2') format('woff2-variations');\n` +
  `    }\n` +
  `    @font-face {\n` +
  `      font-family: 'Inter Variable';\n` +
  `      font-weight: 100 900;\n` +
  `      font-style: normal;\n` +
  `      font-display: swap;\n` +
  `      src: url('/fonts/InterVariable.woff2') format('woff2-variations');\n` +
  `    }\n`;

const planned = [];

// 幂等总判据：index.html 已含 marker 视为整体已迁移。
const html = readText(INDEX_HTML);
if (html.text.includes(MARKER)) {
  console.log('✓ 已是内联字体 + preload 范式（含 marker），跳过。');
  process.exit(0);
}

// 1. 移动 woff2 → public/fonts/
if (existsSync(DST_WOFF2)) {
  console.log('· public/fonts/InterVariable.woff2 已存在，跳过移动。');
} else if (existsSync(SRC_WOFF2)) {
  planned.push(() => {
    mkdirSync(DST_DIR, { recursive: true });
    copyFileSync(SRC_WOFF2, DST_WOFF2);
    rmSync(SRC_WOFF2);
  });
} else {
  console.error('✗ 找不到 src/assets/fonts/inter/InterVariable.woff2，且 public 下也没有，中止。');
  process.exit(1);
}

// 2. 删除 inter.css（@font-face 已内联进 index.html）
if (existsSync(INTER_CSS)) {
  planned.push(() => {
    rmSync(INTER_CSS);
    try {
      const dir = R('src/assets/fonts/inter');
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch { /* 忽略：非空或已删 */ }
  });
}

// 3. 移除 main.ts 的 JS import
const main = readText(MAIN_TS);
if (main.text.includes(MAIN_IMPORT)) {
  const n = main.text.split(MAIN_IMPORT).length - 1;
  if (n !== 1) {
    console.error(`✗ main.ts 中 inter.css import 命中 ${n} 次（应为 1），中止。`);
    process.exit(1);
  }
  planned.push(() => writeFileSync(MAIN_TS, toEol(main.text.replace(MAIN_IMPORT, ''), main.nl), 'utf8'));
} else {
  console.log('· main.ts 已无 inter.css import，跳过。');
}

// 4. index.html：注入 preload + 内联 @font-face
{
  const n = html.text.split(HTML_ANCHOR).length - 1;
  if (n !== 1) {
    console.error(`✗ index.html 锚点命中 ${n} 次（应为 1），中止：\n---\n${HTML_ANCHOR}\n---`);
    process.exit(1);
  }
  planned.push(() =>
    writeFileSync(INDEX_HTML, toEol(html.text.replace(HTML_ANCHOR, HTML_REPLACEMENT), html.nl), 'utf8'),
  );
}

if (planned.length === 0) {
  console.log('✓ 无需改动。');
  process.exit(0);
}
if (!APPLY) {
  console.log(`（dry-run）将执行 ${planned.length} 步：移动 woff2 → public/fonts、删除 inter.css、移除 main.ts import、内联 index.html。加 --apply 落盘。`);
  process.exit(0);
}
for (const step of planned) step();
console.log('✓ 已切换为内联关键字体 + preload（单一源，EOL 已保留）。');
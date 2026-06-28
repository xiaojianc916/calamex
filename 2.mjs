// 修复 read-excel-file@9.x 在 vite/rolldown 生产构建下 `"." is not exported`。
// 整段替换 extractSpreadsheetText（对 CRLF / 缩进 / 格式不敏感）。
// 用法：node 2.mjs [可选:目标文件] [--dry] [--show]

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const showOnly = args.includes('--show');
const targetArg = args.find((a) => !a.startsWith('--'));
const target = resolve(
  process.cwd(),
  targetArg ?? 'src/composables/ai/attachment-document-text.ts',
);

// 整个函数：从签名开始，惰性匹配到行首的 "};"
const FN_RE =
  /const extractSpreadsheetText = async \(buffer: ArrayBuffer\): Promise<string> => \{[\s\S]*?\r?\n\};/;

let src;
try {
  src = readFileSync(target, 'utf8');
} catch (err) {
  console.error(`✗ 读不到文件：${target}\n  ${err.message}`);
  process.exit(1);
}

const eol = src.includes('\r\n') ? '\r\n' : '\n';

const NEW = [
  'const extractSpreadsheetText = async (buffer: ArrayBuffer): Promise<string> => {',
  "  const { default: readExcelFile } = await import('read-excel-file/browser');",
  '  const blob = new Blob([buffer]);',
  '  const sheets = await readExcelFile(blob);',
  '',
  '  return sheets',
  '    .map(({ sheet, data }) => {',
  "      const csv = data.map((row) => row.map(toCsvCell).join(',')).join('\\n');",
  '      return `# ${sheet}\\n${csv}`;',
  '    })',
  "    .join('\\n\\n');",
  '};',
].join(eol);

const match = src.match(FN_RE);

if (showOnly) {
  console.log(match ? match[0] : '（未匹配到 extractSpreadsheetText 函数）');
  process.exit(0);
}

if (src.includes("await import('read-excel-file/browser')")) {
  console.log('• 已经是修复后的状态，无需改动：' + target);
  process.exit(0);
}

if (!match) {
  console.error('✗ 没匹配到 extractSpreadsheetText 函数。把下面这段贴给我核对：\n');
  for (const line of src.split(/\r?\n/)) {
    if (/extractSpreadsheetText|read-excel-file|getSheets|readXlsxFile/.test(line)) {
      console.error('  | ' + line);
    }
  }
  process.exit(1);
}

const next = src.replace(FN_RE, () => NEW); // 函数式替换，避免 $ 被特殊解释

if (dryRun) {
  console.log('— DRY RUN，仅预览，未写盘 —\n');
  console.log(NEW);
  process.exit(0);
}

writeFileSync(target, next, 'utf8');
console.log('✓ 已修复：' + target);
console.log('  下一步：pnpm build 验证');
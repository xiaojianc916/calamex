// fix-search-ignore-venv.mjs
// 幂等修复 F2：为 SKIPPED_SEARCH_DIR_NAMES 补齐 .venv 与 __pycache__，
// 与 workspace_watcher.rs 的兜底忽略清单对齐。不触碰 .git 策略。
import { readFile, writeFile } from 'node:fs/promises';

const DRY = process.argv.includes('--dry');
const FILE = 'src-tauri/src/commands/search/scan.rs';

// EOL 无关：定位 const 声明与其后第一个 `];`，在其前按文件实际行尾插入两项。
// （上次失败根因：本地 Windows 检出为 CRLF，而字面多行锚点用的是 \n → 0 匹配。）
const src = await readFile(FILE, 'utf8');

if (src.includes('"__pycache__"')) {
  console.log('[skip] 已包含 __pycache__，无需修改（幂等）。');
  process.exit(0);
}

const EOL = src.includes('\r\n') ? '\r\n' : '\n';
const DECL = 'const SKIPPED_SEARCH_DIR_NAMES: &[&str] = &[';
const declStart = src.indexOf(DECL);
if (declStart === -1) {
  console.error('[fail] 未找到 SKIPPED_SEARCH_DIR_NAMES 声明。中止，未写入。');
  process.exit(1);
}
// 声明到其后第一个 `];` 之间只有字符串项，不含其它 `]`，故首个 `];` 即数组结束。
const closeIdx = src.indexOf('];', declStart);
if (closeIdx === -1) {
  console.error('[fail] 未找到数组结束符 ];。中止，未写入。');
  process.exit(1);
}

const insertion = `    ".venv",${EOL}    "__pycache__",${EOL}`;
const next = src.slice(0, closeIdx) + insertion + src.slice(closeIdx);
if (DRY) {
  console.log('[dry] 将向 SKIPPED_SEARCH_DIR_NAMES 追加 ".venv" 与 "__pycache__"。');
  process.exit(0);
}
await writeFile(FILE, next);
console.log('[ok] 已补齐 .venv / __pycache__。请运行 cargo test -p calamex 验证。');
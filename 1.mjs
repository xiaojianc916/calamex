#!/usr/bin/env node
// scan-storage-name-readers.mjs
// 用途：只读扫描——列出仓库里所有引用「不专业落盘名」的位置，
//       作为重命名（ai.json→settings.json、auth.token→keychain 等）时必须同步修改的精确清单。
//       重命名会牵动读取方，必须改代码 + 编译验证，故本脚本只报告、不改动。
// 用法：node scripts/scan-storage-name-readers.mjs [repoRoot]
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const SCAN_DIRS = ['src', 'src-tauri/src', 'builtin-agent/src', 'scripts'];
const EXTS = new Set(['.rs', '.ts', '.tsx', '.js', '.mjs', '.json', '.toml']);
const SKIP = new Set(['target', 'node_modules', '.git', 'dist']);

// 待重命名的落盘名 → 说明（对应报告 Before→After 表）
const TARGETS = [
  ['ai.json', 'AI 配置文件名含糊 → settings.json'],
  ['auth.token', '明文令牌落盘 → OS keychain'],
  ['service.log', '日志名 + 应移入 logs/ 日期轮转'],
  ['ai-service', 'feature 目录混装 secret/log/cache'],
  ['ai-edits', 'feature 目录，历史数据 → data/'],
  ['node-compile-cache', '缓存 → cache/node-compile'],
  ['.storage-schema', '迁移标记 → schema.json（脚本 1 已处理）'],
  ['.calamex', 'home dotfolder 根 → ProjectDirs 分类别（P1）'],
];

const files = [];
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (EXTS.has(extname(p))) files.push(p);
  }
};
SCAN_DIRS.forEach((d) => walk(join(ROOT, d)));

let total = 0;
for (const [needle, note] of TARGETS) {
  const hits = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (line.includes(needle)) hits.push(`   ${f.replace(ROOT + '/', '')}:${i + 1}  ${line.trim()}`);
    });
  }
  console.log(`\n▶ "${needle}"  —  ${note}`);
  console.log(`  引用处 ${hits.length} 个${hits.length ? ':' : '（无外部读取方，可安全在单处修改）'}`);
  hits.forEach((h) => console.log(h));
  total += hits.length;
}
console.log(`\n合计 ${total} 处引用。逐一同步修改并 cargo build / pnpm typecheck 验证。`);
console.log('建议先做 P1：把散落的 join("config").join("ai.json") 等收敛成集中 path accessor，再单处改名。');
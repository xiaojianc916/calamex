#!/usr/bin/env node
// remove-dead-session-migration.mjs — 删除疑似死路的 session.json 迁移（带全仓读取方守卫）
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const rel = 'src-tauri/src/storage_paths.rs';
const abs = join(ROOT, rel);
if (!existsSync(abs)) { console.error(`✗ 找不到 ${rel}`); process.exit(1); }

// 守卫：全仓（.rs）搜索是否有人读取 config/session.json（read/open/exists 该路径）
const hits = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'target' || name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (extname(p) === '.rs') {
      const t = readFileSync(p, 'utf8');
      // 读取信号：出现 session.json 且不在我们要删的迁移写入语境（粗筛，人工复核）
      if (t.includes('session.json') && p !== abs) hits.push(p);
    }
  }
};
walk(join(ROOT, 'src-tauri/src'));
if (hits.length) {
  console.log('⚠ 发现其他文件引用 session.json，可能有读取方，拒删。请人工复核：');
  hits.forEach((h) => console.log('   ' + h));
  process.exit(0);
}

let src = readFileSync(abs, 'utf8');
const block = `        migrate_path(
            &identifier_dir.join("session.json"),
            &root.join("config").join("session.json"),
        );\n`;
if (!src.includes(block)) { console.log('· 未匹配到迁移块（可能已移除），未改动。'); process.exit(0); }
src = src.replace(block, '');
writeFileSync(abs, src, 'utf8');
console.log('✓ 已移除死迁移目标 config/session.json。');
console.log('必做自检：cd src-tauri && cargo build && cargo test storage_paths');
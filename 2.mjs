#!/usr/bin/env node
// fix-workspace-sort.mjs —— 性能修复：目录排序 sort_by → sort_by_cached_key
// 把每次比较都重算的 name.to_lowercase() 降为每条目仅算一次。
// 非破坏：锚点不匹配/自检不过则不写入并退出 1。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILE = path.join(process.cwd(), 'src-tauri', 'src', 'commands', 'workspace_fs.rs');

const main = async () => {
  console.log('== calamex 性能修复：workspace 目录排序 ==');

  let src;
  try {
    src = await readFile(FILE, 'utf8');
  } catch (e) {
    console.error(`✗ 读不到文件：${FILE}`);
    console.error('  请在仓库根目录(含 src-tauri/)运行。', e.message);
    process.exit(1);
  }

  if (src.includes('sort_by_cached_key')) {
    console.log('• 已是最新：已使用 sort_by_cached_key，无需修改。');
    return;
  }

  const anchor = 'entries.sort_by(';
  const startIdx = src.indexOf(anchor);
  if (startIdx === -1) {
    console.error('✗ 锚点未匹配：未找到 entries.sort_by( 。');
    console.error('  本地排序段可能已改动，请粘贴 read_workspace_entries 的排序部分以便适配。');
    process.exit(1);
  }
  // sort_by(...) 调用以唯一的 "});" 结束（闭包体内不含该三字符序列）。
  const endRel = src.indexOf('});', startIdx);
  if (endRel === -1) {
    console.error('✗ 锚点未匹配：未找到 sort_by 调用结束的 "});"。');
    process.exit(1);
  }
  const endIdx = endRel + 3;

  const lineStart = src.lastIndexOf('\n', startIdx) + 1;
  const indent = (src.slice(lineStart, startIdx).match(/^[ \t]*/) ?? [''])[0];
  const eol = src.includes('\r\n') ? '\r\n' : '\n';

  const block = [
    `${indent}entries.sort_by_cached_key(|entry| {`,
    `${indent}    // 目录在前：!is_dir(false) 排在文件(true)之前。`,
    `${indent}    // 同类：先按 lowercase，再按原始 name 兜底（区分仅大小写不同的名字）。`,
    `${indent}    // sort_by_cached_key：每条目仅算一次 lowercase，避免比较器里 O(n log n) 次重复分配。`,
    `${indent}    let is_dir = entry.kind.as_str() == "directory";`,
    `${indent}    (!is_dir, entry.name.to_lowercase(), entry.name.clone())`,
    `${indent}});`,
  ].join(eol);

  const next = src.slice(0, lineStart) + block + src.slice(endIdx);

  if (next.includes('entries.sort_by(') || !next.includes('sort_by_cached_key')) {
    console.error('✗ 替换后自检失败，未写入（文件保持原样）。');
    process.exit(1);
  }

  await writeFile(FILE, next, 'utf8');
  console.log('✓ 已应用：sort_by → sort_by_cached_key。');
  console.log('  验证：');
  console.log('    cargo build  -p calamex --quiet');
  console.log('    cargo test   -p calamex read_workspace_entries --quiet');
  console.log('    cargo clippy -p calamex -- -D warnings');
};

main().catch((e) => { console.error('✗ 异常：', e); process.exit(1); });
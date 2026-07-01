// fix-fjall-batch.mjs —— fjall 3.1.4: 批次类型 Batch 已更名为 WriteBatch（db.batch() -> WriteBatch）
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EDITS = [
  {
    file: 'src-tauri/src/ai/edit/history/blob_store.rs',
    replacements: [
      {
        from: 'use fjall::{Batch, Database, Keyspace, KeyspaceCreateOptions};',
        to: 'use fjall::{Database, Keyspace, KeyspaceCreateOptions, WriteBatch};',
      },
      {
        from: 'pub fn store_blob(batch: &mut Batch, blobs: &Keyspace, content: &[u8]) -> String {',
        to: 'pub fn store_blob(batch: &mut WriteBatch, blobs: &Keyspace, content: &[u8]) -> String {',
      },
      {
        from: 'pub fn remove_blob(blobs: &Keyspace, batch: &mut Batch, blob_key: &str) -> Result<u64, String> {',
        to: 'pub fn remove_blob(blobs: &Keyspace, batch: &mut WriteBatch, blob_key: &str) -> Result<u64, String> {',
      },
      // 顶部文档注释里的一处说明，改了更准确；缺失不报错
      { from: 'fjall::Batch', to: 'fjall::WriteBatch', optional: true },
    ],
  },
  {
    file: 'src-tauri/src/ai/edit/history/snapshot.rs',
    replacements: [
      {
        from: 'use fjall::{Batch, Database, Keyspace, KeyspaceCreateOptions, PersistMode};',
        to: 'use fjall::{Database, Keyspace, KeyspaceCreateOptions, PersistMode, WriteBatch};',
      },
      {
        from: 'batch: &mut Batch,',
        to: 'batch: &mut WriteBatch,',
      },
    ],
  },
];

let hadError = false;

for (const edit of EDITS) {
  const target = resolve(edit.file);
  if (!existsSync(target)) {
    console.error('[fix-fjall-batch] 找不到文件:', target);
    hadError = true;
    continue;
  }

  const original = readFileSync(target, 'utf8');
  if (!original.includes('fjall')) {
    console.error('[fix-fjall-batch] 缺少 fjall 锚点，跳过（未改动）:', edit.file);
    hadError = true;
    continue;
  }

  let content = original;
  let applied = 0;
  let skipped = 0;
  let aborted = false;

  for (const { from, to, optional } of edit.replacements) {
    if (content.includes(from)) {
      content = content.split(from).join(to);
      applied += 1;
    } else if (content.includes(to)) {
      skipped += 1; // 已是目标态，幂等跳过
    } else if (!optional) {
      console.error(
        `[fix-fjall-batch] ${edit.file} 未找到预期片段、且目标也不存在，已中止该文件：\n    ${from}`,
      );
      hadError = true;
      aborted = true;
      break;
    }
  }

  if (aborted || content === original) {
    if (!aborted) console.log(`[fix-fjall-batch] ${edit.file}: 无需改动（幂等跳过 ${skipped} 处）`);
    continue;
  }

  const bak = target + '.bak';
  if (!existsSync(bak)) {
    copyFileSync(target, bak);
    console.log('[fix-fjall-batch] 已备份 ->', bak);
  }
  writeFileSync(target, content, 'utf8');
  console.log(`[fix-fjall-batch] ${edit.file}: 已改 ${applied} 处 Batch -> WriteBatch`);
}

process.exit(hadError ? 1 : 0);
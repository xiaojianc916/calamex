// fix-fjall-batch-path.mjs
// 修正 fjall 3.x 批次类型的导入路径：WriteBatch 不在 crate root，
// 而在 fjall::batch 模块。把它从 fjall::{...} 组里拆出来单独 use。
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'

const EDITS = [
  {
    file: 'src-tauri/src/ai/edit/history/blob_store.rs',
    old: 'use fjall::{Database, Keyspace, KeyspaceCreateOptions, WriteBatch};',
    new: 'use fjall::batch::WriteBatch;\nuse fjall::{Database, Keyspace, KeyspaceCreateOptions};',
  },
  {
    file: 'src-tauri/src/ai/edit/history/snapshot.rs',
    old: 'use fjall::{Database, Keyspace, KeyspaceCreateOptions, PersistMode, WriteBatch};',
    new: 'use fjall::batch::WriteBatch;\nuse fjall::{Database, Keyspace, KeyspaceCreateOptions, PersistMode};',
  },
]

let changed = 0
for (const { file, old, new: replacement } of EDITS) {
  if (!existsSync(file)) {
    console.error(`[skip] 文件不存在：${file}`)
    continue
  }
  const src = readFileSync(file, 'utf8')

  // 幂等：已经拆分过就跳过
  if (src.includes('use fjall::batch::WriteBatch;')) {
    console.log(`[ok] 已是正确路径，跳过：${file}`)
    continue
  }

  // 锚点检查：必须能找到旧的 root 组导入
  if (!src.includes(old)) {
    console.error(`[abort] 未找到预期的导入行，请人工检查：${file}`)
    console.error(`        期望：${old}`)
    continue
  }

  copyFileSync(file, `${file}.bak`)
  writeFileSync(file, src.replace(old, replacement), 'utf8')
  console.log(`[done] 已修正：${file}`)
  changed++
}

console.log(changed > 0 ? `\n完成，修改了 ${changed} 个文件。` : '\n无需修改。')
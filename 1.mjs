// fix-fjall-batch-owned.mjs
// fjall 3.1.5：batch 模块私有，WriteBatch 在 crate root 以 OwnedWriteBatch 之名重导出。
//   lib.rs:  pub use { batch::WriteBatch as OwnedWriteBatch, ... }
// 正确的公共类型是 fjall::OwnedWriteBatch。
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'

const BATCH_LINE = 'use fjall::batch::WriteBatch;'

const EDITS = [
  {
    file: 'src-tauri/src/ai/edit/history/blob_store.rs',
    rootOld: 'use fjall::{Database, Keyspace, KeyspaceCreateOptions};',
    rootNew: 'use fjall::{Database, Keyspace, KeyspaceCreateOptions, OwnedWriteBatch};',
  },
  {
    file: 'src-tauri/src/ai/edit/history/snapshot.rs',
    rootOld: 'use fjall::{Database, Keyspace, KeyspaceCreateOptions, PersistMode};',
    rootNew: 'use fjall::{Database, Keyspace, KeyspaceCreateOptions, OwnedWriteBatch, PersistMode};',
  },
]

let changed = 0
for (const { file, rootOld, rootNew } of EDITS) {
  if (!existsSync(file)) { console.error(`[skip] 不存在：${file}`); continue }
  let src = readFileSync(file, 'utf8')

  // 幂等：私有路径行已删且已含 OwnedWriteBatch
  if (!src.includes(BATCH_LINE) && src.includes('OwnedWriteBatch')) {
    console.log(`[ok] 已是 OwnedWriteBatch，跳过：${file}`)
    continue
  }
  if (!src.includes(BATCH_LINE)) {
    console.error(`[abort] 未找到 "${BATCH_LINE}"，请人工检查：${file}`)
    continue
  }
  if (!src.includes(rootOld)) {
    console.error(`[abort] 未找到预期的 root 导入行，请人工检查：${file}`)
    continue
  }

  copyFileSync(file, `${file}.bak`)

  // 1) 删掉私有路径那行（连同换行）
  src = src.replace(`${BATCH_LINE}\n`, '')
  // 2) 把 OwnedWriteBatch 并入 root use 组
  src = src.replace(rootOld, rootNew)
  // 3) 剩余的类型引用 WriteBatch -> OwnedWriteBatch
  //    负向后顾避免把刚加的 OwnedWriteBatch 二次前缀
  src = src.replace(/(?<!Owned)\bWriteBatch\b/g, 'OwnedWriteBatch')

  writeFileSync(file, src, 'utf8')
  console.log(`[done] 已修正：${file}`)
  changed++
}
console.log(changed ? `\n完成，修改 ${changed} 个文件。` : '\n无需修改。')
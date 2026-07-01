// fix-snapshot-unused-storage-root.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const FILE = 'src-tauri/src/ai/edit/history/snapshot.rs';
const src = readFileSync(FILE, 'utf8');
const EOL = src.includes('\r\n') ? '\r\n' : '\n';
const OLD = `fn store_snapshot_with_store(${EOL}    storage_root: &Path,`;
const NEW = `fn store_snapshot_with_store(${EOL}    _storage_root: &Path,`;
if (src.includes(NEW)) { console.log('[skip] 已处理'); process.exit(0); }
const n = src.split(OLD).length - 1;
if (n !== 1) throw new Error(`[校验失败] 锚点命中 ${n} 次（应为 1）`);
writeFileSync(FILE, src.replace(OLD, () => NEW));
console.log('[ok] 未用参数已标记为 _storage_root');
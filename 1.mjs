#!/usr/bin/env node
// 🟠 存储迁移水位：migrate_legacy_storage() 加 schema 版本短路 + 完成标记
// 目标：src-tauri/src/storage_paths.rs ；幂等；锚点缺失即中止
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const target = path.join(process.cwd(), 'src-tauri/src/storage_paths.rs');

const HEAD_ANCHOR = `pub fn migrate_legacy_storage() {
    let Some(root) = storage_root() else {
        return;
    };
`;
const HEAD_INJECT = `pub fn migrate_legacy_storage() {
    let Some(root) = storage_root() else {
        return;
    };

    // 迁移水位：已到当前 schema 版本则整体短路，省去每次启动的多次磁盘探测。
    const STORAGE_SCHEMA_VERSION: u32 = 1;
    let marker = root.join(".storage-schema");
    if fs::read_to_string(&marker)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok())
        .is_some_and(|version| version >= STORAGE_SCHEMA_VERSION)
    {
        return;
    }
`;

const TAIL_ANCHOR = `        rename_within(&new_service, ".node-compile-cache", "node-compile-cache");
    }
}`;
const TAIL_INJECT = `        rename_within(&new_service, ".node-compile-cache", "node-compile-cache");
    }

    // 迁移完成：落 schema 水位标记，下次启动直接短路。
    if let Err(error) = fs::create_dir_all(&root)
        .and_then(|_| fs::write(&marker, STORAGE_SCHEMA_VERSION.to_string()))
    {
        log_migration_warn("schema-marker-write-failed", &marker, &error.to_string());
    }
}`;

let src = await readFile(target, 'utf8');
if (src.includes('STORAGE_SCHEMA_VERSION')) { console.log('✓ 已应用过，跳过。'); process.exit(0); }
if (!src.includes(HEAD_ANCHOR) || !src.includes(TAIL_ANCHOR)) {
  console.error('✗ 未找到函数头/尾锚点，文件已变化，中止未修改。'); process.exit(1);
}
src = src.replace(HEAD_ANCHOR, HEAD_INJECT).replace(TAIL_ANCHOR, TAIL_INJECT);
await writeFile(target, src, 'utf8');
console.log('✓ migrate_legacy_storage() 已加水位短路 + 完成标记。');
console.log('  验证：cargo check && cargo test（storage_paths 现有单测不触及 migrate_legacy_storage，不受影响）。');
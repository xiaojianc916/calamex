#!/usr/bin/env node
// fix-aed-commit-single-handle.mjs  (Stage 1 / 统一共享句柄) — v2：兼容 CRLF/LF 混合行尾
// 目标：file_transaction::commit 一次提交内 ~5 次「开 fjall 库 + 抢 journal.lock」→ 1 把写锁 + 1 个 Database 句柄。
//      edit_journal 暴露 lock-free 的 append_operations_with_db，供 commit 复用同一句柄。
// 不变量：句柄生命周期严格 ⊆ 写锁临界区；同项目多实例（try_lock 失败回退）行为不变。
//
// 用法：node fix-aed-commit-single-handle.mjs
// 验证：cargo build -p calamex --features desktop --quiet
//      cargo test -p calamex ai::edit::io::file_transaction --quiet
//      cargo test -p calamex ai::edit::history::edit_journal --quiet
//
// 安全：仅精确锚点替换；任一锚点缺失/不唯一 → 整体放弃（exit 1），不写任何文件。
//      读入归一化为 LF 做匹配，写回时还原文件原本的 EOL（CRLF 文件保持 CRLF）。

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

function loadState(rel) {
  const path = resolve(ROOT, rel);
  const raw = readFileSync(path, "utf8");
  const usesCRLF = raw.includes("\r\n");
  return {
    rel,
    path,
    usesCRLF,
    text: raw.replace(/\r\n/g, "\n"), // 归一化为 LF 做匹配
    applied: [],
    skipped: [],
    errors: [],
  };
}

/** 精确替换；幂等：marker 已存在则跳过；oldStr 缺失或不唯一则记录错误。 */
function edit(state, oldStr, newStr, label, marker) {
  if (marker && state.text.includes(marker)) {
    state.skipped.push(label);
    return;
  }
  const first = state.text.indexOf(oldStr);
  if (first === -1) {
    state.errors.push(`${label}：锚点未匹配`);
    return;
  }
  if (state.text.indexOf(oldStr, first + oldStr.length) !== -1) {
    state.errors.push(`${label}：锚点不唯一`);
    return;
  }
  state.text = state.text.slice(0, first) + newStr + state.text.slice(first + oldStr.length);
  state.applied.push(label);
}

// ============================================================================
// 1) edit_journal.rs
// ============================================================================
const journal = loadState("src-tauri/src/ai/edit/history/edit_journal.rs");

// 1a. 新增 lock-free 的 append_operations_with_db（复用调用方已打开的句柄）
edit(
  journal,
  `pub fn append_operations(
    storage_root: &Path,
    operations: &[AiEditOperationPayload],
) -> Result<(), String> {
    storage_lock::with_storage_write_lock(storage_root, "追加 AED 操作日志", || {
        append_operations_locked(storage_root, operations)
    })
}`,
  `pub fn append_operations(
    storage_root: &Path,
    operations: &[AiEditOperationPayload],
) -> Result<(), String> {
    storage_lock::with_storage_write_lock(storage_root, "追加 AED 操作日志", || {
        append_operations_locked(storage_root, operations)
    })
}

/// 复用调用方已打开的 fjall 句柄写入操作日志（lock-free 变体）。
///
/// 不变量：调用方必须已持有 \`journal.lock\` 写锁，且 \`db\` 是同一存储目录上
/// 唯一存活的句柄；本函数不再获取锁或重新打开 \`Database\`，以便与
/// \`file_transaction::commit\` 共享单一句柄、消除一次提交内的重复开库。
pub fn append_operations_with_db(
    db: &Database,
    operations: &[AiEditOperationPayload],
) -> Result<(), String> {
    if operations.is_empty() {
        return Ok(());
    }

    let operations_keyspace = db
        .keyspace(OPERATIONS_KEYSPACE, KeyspaceCreateOptions::default)
        .map_err(|error| {
            errors::journal_failed(format!("打开 operations keyspace 失败：{error}"))
        })?;
    let mut batch = db.batch();

    for operation in operations {
        let key = operation_key(operation);
        let value = serde_json::to_vec(operation)
            .map_err(|error| errors::journal_failed(format!("序列化操作日志失败：{error}")))?;
        batch.insert(&operations_keyspace, key, value);
    }

    batch
        .commit()
        .map_err(|error| errors::journal_failed(format!("写入 fjall 操作日志失败：{error}")))?;
    persist(db)
}`,
  "新增 edit_journal::append_operations_with_db",
  "pub fn append_operations_with_db(",
);

// 1b. append_operations_locked 改为委托 append_operations_with_db
edit(
  journal,
  `fn append_operations_locked(
    storage_root: &Path,
    operations: &[AiEditOperationPayload],
) -> Result<(), String> {
    if operations.is_empty() {
        return Ok(());
    }

    let store = open_store(storage_root)?;
    let mut batch = store.db.batch();

    for operation in operations {
        let key = operation_key(operation);
        let value = serde_json::to_vec(operation)
            .map_err(|error| errors::journal_failed(format!("序列化操作日志失败：{error}")))?;
        batch.insert(&store.operations, key, value);
    }

    batch
        .commit()
        .map_err(|error| errors::journal_failed(format!("写入 fjall 操作日志失败：{error}")))?;
    persist(&store.db)
}`,
  `fn append_operations_locked(
    storage_root: &Path,
    operations: &[AiEditOperationPayload],
) -> Result<(), String> {
    let store = open_store(storage_root)?;
    append_operations_with_db(&store.db, operations)
}`,
  "append_operations_locked 委托 with_db",
  "    let store = open_store(storage_root)?;\n    append_operations_with_db(&store.db, operations)\n}",
);

// ============================================================================
// 2) file_transaction.rs
// ============================================================================
const tx = loadState("src-tauri/src/ai/edit/io/file_transaction.rs");

// 2a. commit：整段提交收敛为 1 把写锁 + 1 个句柄
edit(
  tx,
  `pub fn commit(storage_root: &Path, plan: FileTransactionPlan) -> Result<(), String> {
    if plan.actions.is_empty() {
        return Ok(());
    }

    recover_pending(storage_root)?;

    let transaction = PreparedFileTransaction::new(storage_root, plan)?;
    transaction.write_staging_files()?;
    update_status(
        storage_root,
        &transaction.manifest.id,
        TransactionStatus::Committed,
    )?;
    apply_manifest(storage_root, &transaction.manifest)?;
    edit_journal::append_operations(storage_root, &transaction.manifest.operations)?;
    update_status(
        storage_root,
        &transaction.manifest.id,
        TransactionStatus::Done,
    )?;
    remove_staging_dir(storage_root, &transaction.manifest.id)?;

    Ok(())
}`,
  `pub fn commit(storage_root: &Path, plan: FileTransactionPlan) -> Result<(), String> {
    if plan.actions.is_empty() {
        return Ok(());
    }

    // 单一临界区 + 单一 fjall 句柄：整段提交（恢复未决事务、写 manifest、追加
    // 操作日志、状态流转）共享同一把 journal.lock 写锁与同一个 Database 句柄，
    // 把原先一次提交内 ~5 次「开库 + 加锁」收敛为 1 次。
    //
    // 不变量保持：句柄生命周期严格 ⊆ 写锁临界区，提交结束即释放；同项目多实例
    // （依赖 try_lock 失败回退）行为不受影响。
    storage_lock::with_storage_write_lock(storage_root, "提交 AED 文件事务", || {
        let store = open_store(storage_root)?;
        recover_pending_with_store(&store, storage_root)?;

        let transaction = PreparedFileTransaction::prepare(&store, storage_root, plan)?;
        transaction.write_staging_files()?;
        update_status_with_store(
            &store,
            &transaction.manifest.id,
            TransactionStatus::Committed,
        )?;
        apply_manifest(storage_root, &transaction.manifest)?;
        edit_journal::append_operations_with_db(&store.db, &transaction.manifest.operations)?;
        update_status_with_store(&store, &transaction.manifest.id, TransactionStatus::Done)?;
        remove_staging_dir(storage_root, &transaction.manifest.id)?;

        Ok(())
    })
}`,
  "commit 收敛为单锁单句柄",
  `with_storage_write_lock(storage_root, "提交 AED 文件事务"`,
);

// 2b. recover_pending：拆出 lock-free 的 recover_pending_with_store
edit(
  tx,
  `pub fn recover_pending(storage_root: &Path) -> Result<(), String> {
    let manifests = list_manifests(storage_root)?;

    for manifest in manifests {
        match manifest.status {
            TransactionStatus::Prepared => {
                remove_staging_dir(storage_root, &manifest.id)?;
                update_status(storage_root, &manifest.id, TransactionStatus::Done)?;
            }
            TransactionStatus::Committed => {
                apply_manifest(storage_root, &manifest)?;
                edit_journal::append_operations(storage_root, &manifest.operations)?;
                update_status(storage_root, &manifest.id, TransactionStatus::Done)?;
                remove_staging_dir(storage_root, &manifest.id)?;
            }
            TransactionStatus::Done => {}
        }
    }

    Ok(())
}`,
  `pub fn recover_pending(storage_root: &Path) -> Result<(), String> {
    storage_lock::with_storage_write_lock(storage_root, "恢复 AED 文件事务", || {
        let store = open_store(storage_root)?;
        recover_pending_with_store(&store, storage_root)
    })
}

/// 复用调用方已打开的句柄恢复未决事务（lock-free 变体）。
///
/// 不变量：调用方必须已持有 \`journal.lock\` 写锁；本函数不再加锁或重新开库。
fn recover_pending_with_store(
    store: &TransactionStore,
    storage_root: &Path,
) -> Result<(), String> {
    let manifests = list_manifests_with_store(store)?;

    for manifest in manifests {
        match manifest.status {
            TransactionStatus::Prepared => {
                remove_staging_dir(storage_root, &manifest.id)?;
                update_status_with_store(store, &manifest.id, TransactionStatus::Done)?;
            }
            TransactionStatus::Committed => {
                apply_manifest(storage_root, &manifest)?;
                edit_journal::append_operations_with_db(&store.db, &manifest.operations)?;
                update_status_with_store(store, &manifest.id, TransactionStatus::Done)?;
                remove_staging_dir(storage_root, &manifest.id)?;
            }
            TransactionStatus::Done => {}
        }
    }

    Ok(())
}`,
  "recover_pending 拆 lock-free 变体",
  "fn recover_pending_with_store(",
);

// 2c. PreparedFileTransaction::new → prepare(lock-free) + new(#[cfg(test)] 包装)
edit(
  tx,
  `    fn new(storage_root: &Path, plan: FileTransactionPlan) -> Result<Self, String> {
        let now = Timestamp::now();
        let id = format!("ai-edit-tx-{}", now.as_nanosecond());
        let entries = plan
            .actions
            .into_iter()
            .enumerate()
            .map(|(index, action)| FileTransactionEntry::from_action(&id, index, action))
            .collect::<Result<Vec<_>, String>>()?;
        let manifest = FileTransactionManifest {
            version: MANIFEST_VERSION,
            id,
            status: TransactionStatus::Prepared,
            created_at: now.to_string(),
            entries,
            operations: plan.operations,
        };

        upsert_manifest(storage_root, &manifest)?;
        Ok(Self {
            storage_root: storage_root.to_path_buf(),
            manifest,
        })
    }`,
  `    /// 在调用方已持有写锁 + 已打开句柄的前提下准备事务（lock-free）。
    fn prepare(
        store: &TransactionStore,
        storage_root: &Path,
        plan: FileTransactionPlan,
    ) -> Result<Self, String> {
        let now = Timestamp::now();
        let id = format!("ai-edit-tx-{}", now.as_nanosecond());
        let entries = plan
            .actions
            .into_iter()
            .enumerate()
            .map(|(index, action)| FileTransactionEntry::from_action(&id, index, action))
            .collect::<Result<Vec<_>, String>>()?;
        let manifest = FileTransactionManifest {
            version: MANIFEST_VERSION,
            id,
            status: TransactionStatus::Prepared,
            created_at: now.to_string(),
            entries,
            operations: plan.operations,
        };

        upsert_manifest_with_store(store, &manifest)?;
        Ok(Self {
            storage_root: storage_root.to_path_buf(),
            manifest,
        })
    }

    /// 测试辅助：自获取写锁并打开句柄后委托给 [\`PreparedFileTransaction::prepare\`]。
    #[cfg(test)]
    fn new(storage_root: &Path, plan: FileTransactionPlan) -> Result<Self, String> {
        storage_lock::with_storage_write_lock(storage_root, "写入 AED 文件事务", || {
            let store = open_store(storage_root)?;
            Self::prepare(&store, storage_root, plan)
        })
    }`,
  "new 拆 prepare + cfg(test) 包装",
  "    fn prepare(",
);

// 2d. upsert_manifest（锁版，已无生产调用）→ upsert_manifest_with_store（lock-free）
edit(
  tx,
  `fn upsert_manifest(storage_root: &Path, manifest: &FileTransactionManifest) -> Result<(), String> {
    storage_lock::with_storage_write_lock(storage_root, "写入 AED 文件事务", || {
        let store = open_store(storage_root)?;
        let value = serde_json::to_vec(manifest)
            .map_err(|error| errors::transaction_failed(format!("序列化文件事务失败：{error}")))?;
        store
            .transactions
            .insert(manifest.id.as_bytes(), value)
            .map_err(|error| errors::transaction_failed(format!("写入文件事务失败：{error}")))?;
        persist(&store.db)
    })
}`,
  `fn upsert_manifest_with_store(
    store: &TransactionStore,
    manifest: &FileTransactionManifest,
) -> Result<(), String> {
    let value = serde_json::to_vec(manifest)
        .map_err(|error| errors::transaction_failed(format!("序列化文件事务失败：{error}")))?;
    store
        .transactions
        .insert(manifest.id.as_bytes(), value)
        .map_err(|error| errors::transaction_failed(format!("写入文件事务失败：{error}")))?;
    persist(&store.db)
}`,
  "upsert_manifest → with_store",
  "fn upsert_manifest_with_store(",
);

// 2e. update_status（锁版）→ update_status_with_store（lock-free）+ update_status（#[cfg(test)] 包装）
edit(
  tx,
  `fn update_status(
    storage_root: &Path,
    transaction_id: &str,
    status: TransactionStatus,
) -> Result<(), String> {
    storage_lock::with_storage_write_lock(storage_root, "更新 AED 文件事务状态", || {
        let store = open_store(storage_root)?;
        let mut manifest = load_manifest(&store.transactions, transaction_id)?
            .ok_or_else(|| errors::transaction_failed("文件事务不存在。"))?;
        manifest.status = status;
        let value = serde_json::to_vec(&manifest)
            .map_err(|error| errors::transaction_failed(format!("序列化文件事务失败：{error}")))?;
        store
            .transactions
            .insert(transaction_id.as_bytes(), value)
            .map_err(|error| errors::transaction_failed(format!("写入文件事务失败：{error}")))?;
        persist(&store.db)
    })
}`,
  `fn update_status_with_store(
    store: &TransactionStore,
    transaction_id: &str,
    status: TransactionStatus,
) -> Result<(), String> {
    let mut manifest = load_manifest(&store.transactions, transaction_id)?
        .ok_or_else(|| errors::transaction_failed("文件事务不存在。"))?;
    manifest.status = status;
    let value = serde_json::to_vec(&manifest)
        .map_err(|error| errors::transaction_failed(format!("序列化文件事务失败：{error}")))?;
    store
        .transactions
        .insert(transaction_id.as_bytes(), value)
        .map_err(|error| errors::transaction_failed(format!("写入文件事务失败：{error}")))?;
    persist(&store.db)
}

/// 测试辅助：自获取写锁并打开句柄后更新事务状态。
#[cfg(test)]
fn update_status(
    storage_root: &Path,
    transaction_id: &str,
    status: TransactionStatus,
) -> Result<(), String> {
    storage_lock::with_storage_write_lock(storage_root, "更新 AED 文件事务状态", || {
        let store = open_store(storage_root)?;
        update_status_with_store(&store, transaction_id, status)
    })
}`,
  "update_status → with_store + cfg(test) 包装",
  "fn update_status_with_store(",
);

// 2f. list_manifests（锁版，已无生产调用）→ list_manifests_with_store（lock-free）
edit(
  tx,
  `fn list_manifests(storage_root: &Path) -> Result<Vec<FileTransactionManifest>, String> {
    storage_lock::with_storage_read_lock(storage_root, "读取 AED 文件事务", || {
        let store = open_store(storage_root)?;
        let mut manifests = Vec::new();

        for item in store.transactions.iter() {
            let (_key, value) = item.into_inner().map_err(|error| {
                errors::transaction_failed(format!("读取文件事务失败：{error}"))
            })?;
            match serde_json::from_slice::<FileTransactionManifest>(&value) {
                Ok(manifest) => manifests.push(manifest),
                Err(error) => {
                    tracing::warn!(
                        target: "ai.edit",
                        error = %error,
                        "skip invalid AED file transaction manifest"
                    );
                }
            }
        }

        Ok(manifests)
    })
}`,
  `fn list_manifests_with_store(
    store: &TransactionStore,
) -> Result<Vec<FileTransactionManifest>, String> {
    let mut manifests = Vec::new();

    for item in store.transactions.iter() {
        let (_key, value) = item
            .into_inner()
            .map_err(|error| errors::transaction_failed(format!("读取文件事务失败：{error}")))?;
        match serde_json::from_slice::<FileTransactionManifest>(&value) {
            Ok(manifest) => manifests.push(manifest),
            Err(error) => {
                tracing::warn!(
                    target: "ai.edit",
                    error = %error,
                    "skip invalid AED file transaction manifest"
                );
            }
        }
    }

    Ok(manifests)
}`,
  "list_manifests → with_store",
  "fn list_manifests_with_store(",
);

// ============================================================================
// 汇总：任一文件有错误则整体放弃，不写盘；写回时还原各文件原本的 EOL
// ============================================================================
const states = [journal, tx];
const totalErrors = states.flatMap((s) => s.errors.map((e) => `${s.rel} :: ${e}`));

if (totalErrors.length > 0) {
  console.error("✗ 锚点校验失败，未改动任何文件：");
  for (const e of totalErrors) console.error("   - " + e);
  process.exit(1);
}

let wrote = 0;
for (const s of states) {
  if (s.applied.length > 0) {
    const out = s.usesCRLF ? s.text.replace(/\n/g, "\r\n") : s.text;
    writeFileSync(s.path, out, "utf8");
    wrote++;
    console.log(`✓ ${s.rel}  (${s.usesCRLF ? "CRLF" : "LF"})`);
    for (const a of s.applied) console.log(`    应用: ${a}`);
    for (const sk of s.skipped) console.log(`    跳过(已存在): ${sk}`);
  } else {
    console.log(`= ${s.rel}（全部已应用，跳过）`);
  }
}
console.log(`\n完成：写入 ${wrote} 个文件。请运行 cargo build/test 验证。`);
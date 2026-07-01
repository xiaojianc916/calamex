#!/usr/bin/env node
// scripts/aed-blob-store-unify.mjs
//
// 目的：把 AED 快照 blob 内容的物理存储，从"专用裸 git 对象库"
// （blob_store.rs 当前实现：gix::init_bare + write_blob/find_blob，
// SHA-1 key，模块自己承认"从不 git gc/repack"）收敛进项目已经统一
// 使用的同一个 fjall Database 下新增的 blobs keyspace（key 改为
// blake3 摘要，复用 patch::hash_text 已经在用的同一哈希算法）。
//
// 效果：
//   - 存储引擎 2 -> 1（不再有第二个 blobstore.git 仓库）
//   - 哈希算法 2 -> 1（SHA-1 消失，统一 blake3）
//   - remove_blob 从手拼 objects/<前2位>/<后38位> 路径 -> 一次 keyspace 内删除
//   - 一次快照的 N 个 blob 写入 + 1 次 manifest 提交，从 "N 次 git 对象写入
//     + 1 次 fjall 提交" 收敛为 1 次原子 fjall batch 提交
//   - SNAPSHOT_MANIFEST_VERSION 3 -> 4（沿用项目自己 v2->v3 的先例：
//     清一色迁移，不做双读兼容，旧快照 content_available 变为 false，
//     manifest 本身仍可正常列出）
//
// 用法：
//   node scripts/aed-blob-store-unify.mjs --dry-run   # 只校验锚点，不写文件
//   node scripts/aed-blob-store-unify.mjs             # 实际写入
//
// 前置条件：在仓库根目录运行。运行后必须执行：
//   cd src-tauri && cargo build && cargo test
// 回滚：git checkout -- src-tauri/src/ai/edit/history/blob_store.rs \
//                       src-tauri/src/ai/edit/history/snapshot.rs
//
// 已知限制：GitHub code search 未能索引到该仓库（本脚本编写时对
// "blob_repo"/"open_blob_repo"/"blobstore.git" 的全仓库搜索均返回 0
// 命中，不能排除是索引延迟而非真的零引用）。正式合并前请在本地额外跑一次
//   grep -rn "blob_repo\|open_blob_repo\|blobstore\.git" src-tauri/src
// 确认这两个文件之外没有其他调用点依赖旧接口。

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const DRY_RUN = process.argv.includes("--dry-run")
const REPO_ROOT = process.cwd()

function applyReplacements(filePath, replacements) {
	const absolute = path.join(REPO_ROOT, filePath)
	let content = readFileSync(absolute, "utf8")

	for (const { label, oldStr, newStr } of replacements) {
		const occurrences = content.split(oldStr).length - 1
		if (occurrences === 0) {
			throw new Error(
				`[${filePath}] 锚点未找到，文件可能已变化，请人工核对：${label}`,
			)
		}
		if (occurrences > 1) {
			throw new Error(
				`[${filePath}] 锚点出现 ${occurrences} 次，不唯一，无法安全替换：${label}`,
			)
		}
		content = content.replace(oldStr, newStr)
	}

	if (DRY_RUN) {
		console.log(
			`[dry-run] ${filePath}：${replacements.length} 处替换锚点全部匹配成功，未写入。`,
		)
		return
	}

	writeFileSync(absolute, content, "utf8")
	console.log(`[written] ${filePath}：已应用 ${replacements.length} 处替换。`)
}

function overwriteFile(filePath, content) {
	const absolute = path.join(REPO_ROOT, filePath)
	if (DRY_RUN) {
		console.log(`[dry-run] ${filePath}：将整体重写（${content.length} 字节），未写入。`)
		return
	}
	writeFileSync(absolute, content, "utf8")
	console.log(`[written] ${filePath}：已整体重写。`)
}

// ---------------------------------------------------------------------------
// 1) blob_store.rs：从裸 git 对象库整体重写为 fjall blobs keyspace
// ---------------------------------------------------------------------------

const BLOB_STORE_RS = [
	'//! AED 快照文件内容的唯一物理存储层：复用项目级 fjall Database 的一个独立',
	'//! keyspace，而不是自建的裸 git 对象库。',
	'//!',
	'//! # 替代了什么',
	'//! 旧实现（已删除）为快照 blob 内容单独维护一个裸 git 仓库',
	'//! （`gix::init_bare` + `write_blob`/`find_blob`），只是为了借用 git 天生的',
	'//! 「按内容哈希去重」「按哈希前缀分片存储」两个特性。但这个仓库自己承认',
	'//! "本模块从不 git gc/repack"——也就是说每次写入都会在磁盘上留下一个永不',
	'//! 收敛的 loose object 文件，这正是 git 官方文档警告的经典反模式，在',
	'//! Windows/NTFS 上尤其代价高昂。与此同时，项目的其余全部 AED 元数据',
	'//! （journal / pins / snapshot manifest）早已统一收敛到同一个 fjall',
	'//! `Database` 句柄（见 `io::open_aed_database`），blob 内容却单独维护第二套',
	'//! 存储系统，直接违背这个句柄的「唯一入口」设计初衷。',
	'//!',
	'//! 本模块改为把 blob 内容存进同一个 fjall `Database` 下新增的 `blobs`',
	'//! keyspace，key 直接复用调用方已经算好的 BLAKE3 摘要（`patch::hash_text`',
	'//! 采用的同一算法），不再需要 git 对象哈希（SHA-1）这第二套哈希体系，也不',
	'//! 再需要任何裸仓库、任何手写的 loose object 路径拼接、任何 GC 缺失风险。',
	'//!',
	'//! # 有意的不兼容',
	'//! 只认 `"blake3:<64 位十六进制摘要>"` 一种 blob key 格式。旧的',
	'//! `"git:<oid>"` key 不再能被读取或删除——`read_blob`/`remove_blob` 对它们',
	'//! 都是硬报错，本模块不做任何新旧兼容判断。真正过滤迁移前遗留 key 的唯一',
	'//! 位置在上游 `snapshot::SnapshotManifest::has_live_blob`（基于本模块导出的',
	'//! `is_valid_blob_key`）：只有全部文件都持有合法新格式 key 的快照，才会被',
	'//! 认定为"内容仍然存活"。这是一次干净的存储底座替换：旧的临时（未 pin）',
	'//! 快照全文会随之失效，等价于一次保留策略意义上的"提前过期"；快照清单',
	'//! （manifest）本身不受影响，仍可正常列出。',
	'//!',
	'//! # 并发与原子性',
	'//! 本模块不再自行加锁或自行 commit/persist：所有写入（`store_blob`）与删除',
	'//! （`remove_blob`）都通过调用方传入的 `fjall::Batch` 入队，随调用方的批次',
	'//! 一次性 `commit` + `persist`。这比旧实现（每个 blob 一次独立的 git 对象',
	'//! 写入，加上一次独立的 manifest fjall 提交，一次快照 N+1 次落盘）更强：',
	'//! 一次快照的全部 blob 内容与 manifest 更新现在共享同一次原子批量提交。',
	'',
	'use crate::ai::edit::errors;',
	'use fjall::{Batch, Database, Keyspace, KeyspaceCreateOptions};',
	'',
	'const BLOBS_KEYSPACE: &str = "blobs";',
	'const BLOB_KEY_PREFIX: &str = "blake3:";',
	'const BLOB_HASH_HEX_LEN: usize = 64;',
	'',
	'/// 打开（或按需创建）AED blob 内容 keyspace。与 snapshots keyspace 共享同一个',
	'/// `Database` 句柄，因此不需要额外的锁或额外的库初始化路径。',
	'pub fn open_blobs_keyspace(db: &Database) -> Result<Keyspace, String> {',
	'    db.keyspace(BLOBS_KEYSPACE, KeyspaceCreateOptions::default)',
	'        .map_err(|error| errors::snapshot_store_failed(format!("打开 blobs keyspace 失败：{error}")))',
	'}',
	'',
	'/// 把一份文件内容加入批次，返回 `"blake3:<hex>"` 形式的 blob key。',
	'///',
	'/// 相同内容始终产生同一个 key，天然去重——重复写入只是把同一个 key/value',
	'/// 对再次放入批次，`commit` 时是幂等的覆盖写，不需要像旧实现那样调用一次',
	'/// git 对象写入去触发它内部的去重逻辑，也不需要任何显式的“先查是否存在”。',
	'pub fn store_blob(batch: &mut Batch, blobs: &Keyspace, content: &[u8]) -> String {',
	'    let key = format!("{BLOB_KEY_PREFIX}{}", blake3::hash(content).to_hex());',
	'    batch.insert(blobs, key.as_bytes().to_vec(), content.to_vec());',
	'    key',
	'}',
	'',
	'/// 按 blob key 读取内容的原始字节。仅接受本模块写入的 `"blake3:<hex>"` key；',
	'/// 格式不匹配（包括迁移前的 `"git:<oid>"` legacy key）时硬报错。',
	'pub fn read_blob(blobs: &Keyspace, blob_key: &str) -> Result<Vec<u8>, String> {',
	'    validate_blob_key(blob_key)?;',
	'    blobs',
	'        .get(blob_key)',
	'        .map_err(|error| errors::snapshot_store_failed(format!("读取 blob 失败：{error}")))?',
	'        .map(|value| value.to_vec())',
	'        .ok_or_else(|| errors::snapshot_store_failed(format!("blob 内容不存在：{blob_key}")))',
	'}',
	'',
	'/// 把一次 blob 删除加入批次，返回被删除内容的字节数（用于配额统计）。',
	'///',
	'/// 只接受合法的 `"blake3:<hex>"` key。调用方（`snapshot::strip_manifest_blobs`）',
	'/// 在调用本函数之前，已经通过 `is_valid_blob_key`/`has_live_blob` 把所有',
	'/// 迁移前遗留的旧格式 key 过滤在外。',
	'pub fn remove_blob(blobs: &Keyspace, batch: &mut Batch, blob_key: &str) -> Result<u64, String> {',
	'    validate_blob_key(blob_key)?;',
	'    let existing_len = blobs',
	'        .get(blob_key)',
	'        .map_err(|error| errors::snapshot_store_failed(format!("读取 blob 失败：{error}")))?',
	'        .map(|value| value.len() as u64)',
	'        .unwrap_or(0);',
	'    batch.remove(blobs, blob_key.as_bytes().to_vec());',
	'    Ok(existing_len)',
	'}',
	'',
	'/// 是否是本模块当前会写入 / 认可的 blob key 格式。上游（`snapshot.rs`）用它来',
	'/// 判定一个快照清单里的引用是否仍然“存活”。',
	'pub fn is_valid_blob_key(blob_key: &str) -> bool {',
	'    validate_blob_key(blob_key).is_ok()',
	'}',
	'',
	'fn validate_blob_key(blob_key: &str) -> Result<(), String> {',
	'    let hex = blob_key',
	'        .strip_prefix(BLOB_KEY_PREFIX)',
	'        .ok_or_else(|| errors::snapshot_store_failed("快照 blob key 格式无效或已是历史遗留格式。"))?;',
	'    let is_valid_hex =',
	'        hex.len() == BLOB_HASH_HEX_LEN && hex.bytes().all(|byte| byte.is_ascii_hexdigit());',
	'    if is_valid_hex {',
	'        Ok(())',
	'    } else {',
	'        Err(errors::snapshot_store_failed(',
	'            "快照 blob key 格式无效或已是历史遗留格式。",',
	'        ))',
	'    }',
	'}',
	'',
	'#[cfg(test)]',
	'mod tests {',
	'    use super::{is_valid_blob_key, open_blobs_keyspace, read_blob, remove_blob, store_blob};',
	'    use fjall::Database;',
	'    use std::path::PathBuf;',
	'',
	'    fn open_db(temp_dir: &std::path::Path) -> Database {',
	'        Database::builder(temp_dir.join("fjall"))',
	'            .open()',
	'            .expect("fjall database should open")',
	'    }',
	'',
	'    #[test]',
	'    fn store_and_read_blob_roundtrips_and_dedupes_identical_content() {',
	'        let temp_dir = temp_dir("aed-blob-store");',
	'        std::fs::create_dir_all(&temp_dir).expect("temp directory should be created");',
	'        let db = open_db(&temp_dir);',
	'        let blobs = open_blobs_keyspace(&db).expect("blobs keyspace should open");',
	'',
	'        let mut batch = db.batch();',
	'        let key_a = store_blob(&mut batch, &blobs, b"echo shared");',
	'        let key_b = store_blob(&mut batch, &blobs, b"echo shared");',
	'        let key_c = store_blob(&mut batch, &blobs, b"echo different");',
	'        batch.commit().expect("batch should commit");',
	'',
	'        assert_eq!(key_a, key_b, "identical content must dedupe to the same blake3 key");',
	'        assert_ne!(key_a, key_c);',
	'        assert!(key_a.starts_with(super::BLOB_KEY_PREFIX));',
	'',
	'        let restored = read_blob(&blobs, &key_a).expect("blob should read back");',
	'        assert_eq!(restored, b"echo shared");',
	'',
	'        let _ = std::fs::remove_dir_all(&temp_dir);',
	'    }',
	'',
	'    #[test]',
	'    fn remove_blob_deletes_entry_and_reports_freed_bytes() {',
	'        let temp_dir = temp_dir("aed-blob-store-remove");',
	'        std::fs::create_dir_all(&temp_dir).expect("temp directory should be created");',
	'        let db = open_db(&temp_dir);',
	'        let blobs = open_blobs_keyspace(&db).expect("blobs keyspace should open");',
	'',
	'        let mut write_batch = db.batch();',
	'        let key = store_blob(&mut write_batch, &blobs, b"to be removed");',
	'        write_batch.commit().expect("batch should commit");',
	'',
	'        let mut remove_batch = db.batch();',
	'        let freed_bytes =',
	'            remove_blob(&blobs, &mut remove_batch, &key).expect("blob should be removed");',
	'        remove_batch.commit().expect("batch should commit");',
	'        assert!(freed_bytes > 0);',
	'',
	'        let read_result = read_blob(&blobs, &key);',
	'        assert!(read_result.is_err(), "removed blob must no longer be readable");',
	'',
	'        let mut noop_batch = db.batch();',
	'        let freed_again = remove_blob(&blobs, &mut noop_batch, &key)',
	'            .expect("removing an already-missing blob is a no-op");',
	'        assert_eq!(freed_again, 0);',
	'',
	'        let _ = std::fs::remove_dir_all(&temp_dir);',
	'    }',
	'',
	'    #[test]',
	'    fn read_and_remove_reject_malformed_or_legacy_keys() {',
	'        let temp_dir = temp_dir("aed-blob-store-malformed");',
	'        std::fs::create_dir_all(&temp_dir).expect("temp directory should be created");',
	'        let db = open_db(&temp_dir);',
	'        let blobs = open_blobs_keyspace(&db).expect("blobs keyspace should open");',
	'        let mut batch = db.batch();',
	'',
	'        // "git:<oid>" 是迁移前遗留的旧格式，"fjall:legacy-hash" 是更早一代的',
	'        // 遗留格式，"blake3:not-hex-and-wrong-length" 是前缀正确但内容非法',
	'        // 的新格式 key；三类都必须被拒绝。',
	'        for bad_key in [',
	'            "git:af09cf7c1b7e9a4a4e1f9e5f6a0d6a6a4e1f9e5f",',
	'            "fjall:legacy-hash",',
	'            "blake3:not-hex-and-wrong-length",',
	'        ] {',
	'            assert!(read_blob(&blobs, bad_key).is_err());',
	'            assert!(remove_blob(&blobs, &mut batch, bad_key).is_err());',
	'        }',
	'',
	'        let _ = std::fs::remove_dir_all(&temp_dir);',
	'    }',
	'',
	'    #[test]',
	'    fn is_valid_blob_key_only_accepts_current_format() {',
	'        let valid = format!("blake3:{}", blake3::hash(b"x").to_hex());',
	'        assert!(is_valid_blob_key(&valid));',
	'        assert!(!is_valid_blob_key("git:abcd"));',
	'        assert!(!is_valid_blob_key("fjall:abcd"));',
	'        assert!(!is_valid_blob_key("blake3:tooshort"));',
	'    }',
	'',
	'    fn temp_dir(name: &str) -> PathBuf {',
	'        std::env::temp_dir().join(format!(',
	'            "{name}-{}",',
	'            std::time::SystemTime::now()',
	'                .duration_since(std::time::UNIX_EPOCH)',
	'                .expect("time should move forward")',
	'                .as_nanos()',
	'        ))',
	'    }',
	'}',
].join("\n") + "\n"

overwriteFile("src-tauri/src/ai/edit/history/blob_store.rs", BLOB_STORE_RS)

// ---------------------------------------------------------------------------
// 2) snapshot.rs：11 处精确替换
// ---------------------------------------------------------------------------

applyReplacements("src-tauri/src/ai/edit/history/snapshot.rs", [
	{
		label: "顶部 use 引入 Batch",
		oldStr: "use fjall::{Database, Keyspace, KeyspaceCreateOptions, PersistMode};",
		newStr: "use fjall::{Batch, Database, Keyspace, KeyspaceCreateOptions, PersistMode};",
	},
	{
		label: "SNAPSHOT_MANIFEST_VERSION 3 -> 4 + 迁移说明注释",
		oldStr: [
			'/// v2 -> v3：快照文件内容的物理存储从 fjall keyspace + 手写 CAS 目录切换到',
			'/// gix 对象库（见 `history::blob_store`），blob_key 前缀从 `fjall:`/`cas:`',
			'/// 变为唯一的 `git:`。不做双读兼容：v3 之前写入的快照清单里的 blob_key 在新',
			'/// 代码下一律读取失败（清单本身仍可正常列出，`content_available` 会如实',
			'/// 报告为 false，见 `has_live_blob`）。同样，这些旧 key 的字节数也不会计入',
			'/// 保留策略的配额统计——它们从未在新对象库里存在过，见 `live_blob_keys`。',
			'const SNAPSHOT_MANIFEST_VERSION: u32 = 3;',
		].join("\n"),
		newStr: [
			'/// v3 -> v4：快照文件内容的物理存储从独立的裸 git 对象库（`history::blob_store`',
			'/// 曾经维护的 `blobstore.git`，从不 gc/repack，SHA-1 key）收敛进项目统一的',
			'/// fjall `Database` 下新增的 `blobs` keyspace，blob_key 前缀从 `git:` 变为',
			'/// `blake3:`（复用 `patch::hash_text` 已经使用的同一哈希算法，不再是第二套',
			'/// 哈希体系）。不做双读兼容：v4 之前写入的快照清单里的 blob_key 在新代码下',
			'/// 一律读取失败（清单本身仍可正常列出，`content_available` 会如实报告为',
			'/// false，见 `has_live_blob`）。同样，这些旧 key 的字节数也不会计入保留策略',
			'/// 的配额统计——它们从未在新 keyspace 里存在过，见 `live_blob_keys`。',
			'const SNAPSHOT_MANIFEST_VERSION: u32 = 4;',
		].join("\n"),
	},
	{
		label: "apply_snapshot_retention 签名 + 打开 blobs keyspace",
		oldStr: [
			'pub fn apply_snapshot_retention(',
			'    db: &Database,',
			'    storage_root: &Path,',
			'    pin_index: &PinIndex,',
			'    policy: SnapshotRetentionPolicy,',
			') -> Result<SnapshotPruneOutcome, String> {',
			'    let snapshots = db',
			'        .keyspace(SNAPSHOTS_KEYSPACE, KeyspaceCreateOptions::default)',
			'        .map_err(|error| {',
			'            errors::snapshot_store_failed(format!("打开 snapshots keyspace 失败：{error}"))',
			'        })?;',
			'',
			'    let mut manifests = list_manifests(&snapshots)?;',
		].join("\n"),
		newStr: [
			'pub fn apply_snapshot_retention(',
			'    db: &Database,',
			'    _storage_root: &Path,',
			'    pin_index: &PinIndex,',
			'    policy: SnapshotRetentionPolicy,',
			') -> Result<SnapshotPruneOutcome, String> {',
			'    let snapshots = db',
			'        .keyspace(SNAPSHOTS_KEYSPACE, KeyspaceCreateOptions::default)',
			'        .map_err(|error| {',
			'            errors::snapshot_store_failed(format!("打开 snapshots keyspace 失败：{error}"))',
			'        })?;',
			'    let blobs = blob_store::open_blobs_keyspace(db)?;',
			'',
			'    let mut manifests = list_manifests(&snapshots)?;',
		].join("\n"),
	},
	{
		label: "第一处 strip_manifest_blobs 调用（TTL 循环）",
		oldStr: [
			'        strip_manifest_blobs(',
			'            storage_root,',
			'            manifest,',
			'            &mut blob_ref_counts,',
			'            &mut active_blob_bytes,',
			'            &mut outcome,',
			'        )?;',
			'    }',
			'',
			'    if policy.total_blob_quota_bytes > 0 {',
		].join("\n"),
		newStr: [
			'        strip_manifest_blobs(',
			'            &blobs,',
			'            &mut batch,',
			'            manifest,',
			'            &mut blob_ref_counts,',
			'            &mut active_blob_bytes,',
			'            &mut outcome,',
			'        )?;',
			'    }',
			'',
			'    if policy.total_blob_quota_bytes > 0 {',
		].join("\n"),
	},
	{
		label: "第二处 strip_manifest_blobs 调用（配额循环）",
		oldStr: [
			'            let before_total = current_total;',
			'            strip_manifest_blobs(',
			'                storage_root,',
			'                manifest,',
			'                &mut blob_ref_counts,',
			'                &mut active_blob_bytes,',
			'                &mut outcome,',
			'            )?;',
			'            current_total = active_blob_bytes.values().copied().sum::<u64>();',
		].join("\n"),
		newStr: [
			'            let before_total = current_total;',
			'            strip_manifest_blobs(',
			'                &blobs,',
			'                &mut batch,',
			'                manifest,',
			'                &mut blob_ref_counts,',
			'                &mut active_blob_bytes,',
			'                &mut outcome,',
			'            )?;',
			'            current_total = active_blob_bytes.values().copied().sum::<u64>();',
		].join("\n"),
	},
	{
		label: "strip_manifest_blobs 函数签名",
		oldStr: [
			'fn strip_manifest_blobs(',
			'    storage_root: &Path,',
			'    manifest: &mut SnapshotManifest,',
			'    blob_ref_counts: &mut HashMap<String, usize>,',
			'    active_blob_bytes: &mut HashMap<String, u64>,',
			'    outcome: &mut SnapshotPruneOutcome,',
			') -> Result<(), String> {',
		].join("\n"),
		newStr: [
			'fn strip_manifest_blobs(',
			'    blobs: &Keyspace,',
			'    batch: &mut Batch,',
			'    manifest: &mut SnapshotManifest,',
			'    blob_ref_counts: &mut HashMap<String, usize>,',
			'    active_blob_bytes: &mut HashMap<String, u64>,',
			'    outcome: &mut SnapshotPruneOutcome,',
			') -> Result<(), String> {',
		].join("\n"),
	},
	{
		label: "strip_manifest_blobs 内部对 remove_blob 的调用",
		oldStr: [
			'        blob_ref_counts.remove(&blob_key);',
			'        active_blob_bytes.remove(&blob_key);',
			'        let removed_bytes = blob_store::remove_blob(storage_root, &blob_key)?;',
		].join("\n"),
		newStr: [
			'        blob_ref_counts.remove(&blob_key);',
			'        active_blob_bytes.remove(&blob_key);',
			'        let removed_bytes = blob_store::remove_blob(blobs, batch, &blob_key)?;',
		].join("\n"),
	},
	{
		label: "SnapshotStore 结构体字段",
		oldStr: [
			'struct SnapshotStore {',
			'    db: Database,',
			'    snapshots: Keyspace,',
			'    blob_repo: gix::Repository,',
			'}',
		].join("\n"),
		newStr: [
			'struct SnapshotStore {',
			'    db: Database,',
			'    snapshots: Keyspace,',
			'    blobs: Keyspace,',
			'}',
		].join("\n"),
	},
	{
		label: "open_store 构造逻辑",
		oldStr: [
			'    let blob_repo = blob_store::open_blob_repo(storage_root)?;',
			'    Ok(SnapshotStore {',
			'        db,',
			'        snapshots,',
			'        blob_repo,',
			'    })',
			'}',
		].join("\n"),
		newStr: [
			'    let blobs = blob_store::open_blobs_keyspace(&db)?;',
			'    Ok(SnapshotStore {',
			'        db,',
			'        snapshots,',
			'        blobs,',
			'    })',
			'}',
		].join("\n"),
	},
	{
		label: "store_snapshot_with_store 里的 blob 写入调用",
		oldStr:
			'        let blob_key = blob_store::store_blob(&store.blob_repo, file.content.as_bytes())?;',
		newStr:
			'        let blob_key = blob_store::store_blob(&mut batch, &store.blobs, file.content.as_bytes());',
	},
	{
		label: "into_stored_snapshot 对本地 read_blob 辅助函数的调用",
		oldStr: '            let content = read_blob(&store.blob_repo, blob_key)?;',
		newStr: '            let content = read_blob(&store.blobs, blob_key)?;',
	},
	{
		label: "本地 read_blob 辅助函数签名与实现",
		oldStr: [
			'fn read_blob(blob_repo: &gix::Repository, blob_key: &str) -> Result<String, String> {',
			'    let bytes = blob_store::read_blob(blob_repo, blob_key)?;',
			'    String::from_utf8(bytes)',
			'        .map_err(|error| errors::snapshot_store_failed(format!("快照 blob 不是 UTF-8：{error}")))',
			'}',
		].join("\n"),
		newStr: [
			'fn read_blob(blobs: &Keyspace, blob_key: &str) -> Result<String, String> {',
			'    let bytes = blob_store::read_blob(blobs, blob_key)?;',
			'    String::from_utf8(bytes)',
			'        .map_err(|error| errors::snapshot_store_failed(format!("快照 blob 不是 UTF-8：{error}")))',
			'}',
		].join("\n"),
	},
	{
		label: "顺手修复：测试里断言旧 blobstore.git 目录的过时用例",
		oldStr: [
			'    #[test]',
			'    fn large_snapshot_blob_round_trips_via_git_object_store() {',
			'        let temp_dir = temp_dir("aed-large-snapshot");',
			'        fs::create_dir_all(&temp_dir).expect("temp directory should be created");',
			'        // 旧实现按 SMALL_BLOB_MAX_BYTES 阈值在此切到 CAS 目录；gix 对象库不区分',
			'        // 大小，这里只需验证「足够大」的内容依然完整往返。',
			'        let large_content = "x".repeat(512 * 1024);',
			'',
			'        let snapshot = store_manual_snapshot(',
			'            &temp_dir,',
			'            &[SnapshotSourceFile {',
			'                path: "src/large.sh",',
			'                content_hash: "blake3:largeblob",',
			'                content: &large_content,',
			'            }],',
			'            None,',
			'            "large",',
			'        )',
			'        .expect("large snapshot should be written");',
			'',
			'        let stored = load_stored_snapshot(&temp_dir, &snapshot.id).expect("snapshot should load");',
			'        assert_eq!(stored.files[0].content, large_content);',
			'        assert!(temp_dir.join("blobstore.git").is_dir());',
			'',
			'        let _ = fs::remove_dir_all(&temp_dir);',
			'    }',
		].join("\n"),
		newStr: [
			'    #[test]',
			'    fn large_snapshot_blob_round_trips_via_fjall_blobs_keyspace() {',
			'        let temp_dir = temp_dir("aed-large-snapshot");',
			'        fs::create_dir_all(&temp_dir).expect("temp directory should be created");',
			'        // fjall 的 blobs keyspace 不区分大小，这里只需验证「足够大」的内容',
			'        // 依然完整往返，且物理落盘位置是统一的 fjall 目录而不是另一个仓库。',
			'        let large_content = "x".repeat(512 * 1024);',
			'',
			'        let snapshot = store_manual_snapshot(',
			'            &temp_dir,',
			'            &[SnapshotSourceFile {',
			'                path: "src/large.sh",',
			'                content_hash: "blake3:largeblob",',
			'                content: &large_content,',
			'            }],',
			'            None,',
			'            "large",',
			'        )',
			'        .expect("large snapshot should be written");',
			'',
			'        let stored = load_stored_snapshot(&temp_dir, &snapshot.id).expect("snapshot should load");',
			'        assert_eq!(stored.files[0].content, large_content);',
			'        assert!(temp_dir.join("fjall").is_dir());',
			'        assert!(!temp_dir.join("blobstore.git").exists());',
			'',
			'        let _ = fs::remove_dir_all(&temp_dir);',
			'    }',
		].join("\n"),
	},
])

console.log(
	DRY_RUN
		? "\n全部锚点校验通过（dry-run，未写入任何文件）。"
		: "\n全部修改已写入。请执行：cd src-tauri && cargo build && cargo test",
)
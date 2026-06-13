// refactor-dedup.mjs
// 代码质量收敛重构（行为不变）：
//  1) terminal/state.rs —— 抽 lock_active_terminal_runs 消除 4 处重复取锁；
//     remove_interactive_terminal_after_exit 改为复用现成 remove_* 辅助。
//  2) search/find.rs —— FuzzyLinePrefilter 的 may_match / bytes_may_match
//     共用一个 all_required_ascii_present 辅助，消除逐字重复的扫描循环。
//  3) search/scan.rs ↔ workspace_watcher.rs —— 把逐字相同的 relativize / os_str_eq
//     抽到新的共享模块 commands/path_util.rs，两边改为引用。
//
// 特性：两阶段（先全部校验、再统一写入）、CRLF 安全（按原文件 EOL 还原）、不留备份。
// 用法：node refactor-dedup.mjs [仓库根路径，默认当前目录]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(process.argv[2] ?? ".");

function detectEol(text) {
	return text.includes("\r\n") ? "\r\n" : "\n";
}
function toLf(text) {
	return text.replace(/\r\n/g, "\n");
}
function countOccurrences(haystack, needle) {
	if (needle === "") return 0;
	let count = 0;
	let idx = 0;
	while ((idx = haystack.indexOf(needle, idx)) !== -1) {
		count += 1;
		idx += needle.length;
	}
	return count;
}

// ---- 第 1 项：terminal/state.rs ----
const stateEdits = [
	{
		// 插入 active_runs 取锁辅助
		find: `pub(super) fn active_terminal_run_count(state: &TerminalSessionState) -> usize {`,
		replace: `fn lock_active_terminal_runs(
    state: &TerminalSessionState,
) -> Result<std::sync::MutexGuard<'_, HashMap<String, TerminalActiveRun>>, String> {
    state
        .active_runs
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())
}

pub(super) fn active_terminal_run_count(state: &TerminalSessionState) -> usize {`,
		count: 1,
	},
	{
		// 可变取锁 ×2
		find: `    let mut active_runs = state
        .active_runs
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())?;`,
		replace: `    let mut active_runs = lock_active_terminal_runs(state)?;`,
		count: 2,
	},
	{
		// 不可变取锁 ×2
		find: `    let active_runs = state
        .active_runs
        .lock()
        .map_err(|_| "终端运行状态已损坏。".to_string())?;`,
		replace: `    let active_runs = lock_active_terminal_runs(state)?;`,
		count: 2,
	},
	{
		// 退出清理复用 remove_* 辅助
		find: `pub(super) fn remove_interactive_terminal_after_exit(
    state: &TerminalSessionState,
    session_id: &str,
) {
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.remove(session_id);
    }
    if let Ok(mut snapshots) = state.snapshots.lock() {
        snapshots.remove(session_id);
    }
    if let Ok(mut visual_states) = state.interactive_visual.lock() {
        visual_states.remove(session_id);
    }
    if let Ok(mut pending) = state.pending_switch_input.lock() {
        pending.remove(session_id);
    }
}`,
		replace: `pub(super) fn remove_interactive_terminal_after_exit(
    state: &TerminalSessionState,
    session_id: &str,
) {
    // 尽力而为地清理该会话的全部状态，复用各自的 remove_* 辅助；
    // 锁中毒时这些辅助返回 Err，这里一律忽略（与原先 if let Ok 的语义一致）。
    let _ = remove_terminal_session(state, session_id);
    let _ = remove_terminal_snapshot(state, session_id);
    let _ = remove_terminal_interactive_visual_state(state, session_id);
    remove_pending_switch_input(state, session_id);
}`,
		count: 1,
	},
];

// ---- 第 2 项：search/find.rs ----
const findEdits = [
	{
		// 抽出共享扫描辅助 + 精简 may_match
		find: `    fn may_match(&self, line: &str) -> bool {
        if line.chars().count() < self.min_chars {
            return false;
        }
        if self.required_ascii.is_empty() {
            return true;
        }

        let mut missing = self.required_ascii.clone();
        for byte in line.bytes() {
            if !byte.is_ascii() {
                continue;
            }
            let normalized = normalize_prefilter_ascii(byte, self.match_case);
            if let Some(index) = missing
                .iter()
                .position(|candidate| *candidate == normalized)
            {
                missing.swap_remove(index);
                if missing.is_empty() {
                    return true;
                }
            }
        }

        false
    }`,
		replace: `    /// 在给定字节序列中检查 query 要求的全部 ASCII 字符是否都出现（按 match_case 归一大小写）。
    /// 非 ASCII 字节跳过；调用方需保证 required_ascii 非空时调用才有意义。
    fn all_required_ascii_present(&self, bytes: impl Iterator<Item = u8>) -> bool {
        let mut missing = self.required_ascii.clone();
        for byte in bytes {
            if !byte.is_ascii() {
                continue;
            }
            let normalized = normalize_prefilter_ascii(byte, self.match_case);
            if let Some(index) = missing
                .iter()
                .position(|candidate| *candidate == normalized)
            {
                missing.swap_remove(index);
                if missing.is_empty() {
                    return true;
                }
            }
        }
        false
    }

    fn may_match(&self, line: &str) -> bool {
        if line.chars().count() < self.min_chars {
            return false;
        }
        if self.required_ascii.is_empty() {
            return true;
        }
        self.all_required_ascii_present(line.bytes())
    }`,
		count: 1,
	},
	{
		// 精简 bytes_may_match
		find: `    fn bytes_may_match(&self, bytes: &[u8]) -> bool {
        if self.required_ascii.is_empty() {
            return true;
        }

        let mut missing = self.required_ascii.clone();
        for byte in bytes {
            if !byte.is_ascii() {
                continue;
            }
            let normalized = normalize_prefilter_ascii(*byte, self.match_case);
            if let Some(index) = missing
                .iter()
                .position(|candidate| *candidate == normalized)
            {
                missing.swap_remove(index);
                if missing.is_empty() {
                    return true;
                }
            }
        }

        false
    }`,
		replace: `    fn bytes_may_match(&self, bytes: &[u8]) -> bool {
        if self.required_ascii.is_empty() {
            return true;
        }
        self.all_required_ascii_present(bytes.iter().copied())
    }`,
		count: 1,
	},
];

// ---- 第 3 项：共享 path_util + 两处去重 ----
const modRsEdits = [
	{
		find: `pub(crate) mod lsp;
pub(crate) mod script_run;`,
		replace: `pub(crate) mod lsp;
pub(crate) mod path_util;
pub(crate) mod script_run;`,
		count: 1,
	},
];

const scanEdits = [
	{
		find: `use super::super::decode_script_bytes;`,
		replace: `use super::super::decode_script_bytes;
use super::super::path_util::{os_str_eq, relativize};`,
		count: 1,
	},
	{
		// 删除 scan.rs 本地 relativize / os_str_eq（无文档注释版本）
		find: `fn relativize(root: &Path, path: &Path) -> Option<PathBuf> {
    let mut root_components = root.components();
    let mut path_components = path.components();
    loop {
        match root_components.next() {
            None => return Some(path_components.as_path().to_path_buf()),
            Some(root_component) => {
                let path_component = path_components.next()?;
                if !os_str_eq(root_component.as_os_str(), path_component.as_os_str()) {
                    return None;
                }
            }
        }
    }
}

#[cfg(windows)]
fn os_str_eq(left: &OsStr, right: &OsStr) -> bool {
    left.eq_ignore_ascii_case(right)
}

#[cfg(not(windows))]
fn os_str_eq(left: &OsStr, right: &OsStr) -> bool {
    left == right
}

`,
		replace: ``,
		count: 1,
	},
];

const watcherEdits = [
	{
		find: `use super::search::prewarm_workspace_search_index;`,
		replace: `use super::search::prewarm_workspace_search_index;
use super::path_util::{os_str_eq, relativize};`,
		count: 1,
	},
	{
		// 删除 workspace_watcher.rs 本地 relativize / os_str_eq（含文档注释版本）
		find: `/// 按组件逐级剥掉监听根前缀，返回根 *之下* 的相对路径。
///
/// 仅比较相对组件可避免一个隐蔽陷阱：当用户把工作区直接开在名为
/// \`node_modules\`（或 \`target\` 等）的目录里时，不应把整棵树误判为被忽略。
/// 前缀形态不一致（罕见）时返回 \`None\`，调用方据此放行。
fn relativize(root: &Path, path: &Path) -> Option<PathBuf> {
    let mut root_components = root.components();
    let mut path_components = path.components();
    loop {
        match root_components.next() {
            None => return Some(path_components.as_path().to_path_buf()),
            Some(root_component) => {
                let path_component = path_components.next()?;
                if !os_str_eq(root_component.as_os_str(), path_component.as_os_str()) {
                    return None;
                }
            }
        }
    }
}

/// 路径组件相等性：Windows 上大小写不敏感，其它平台精确匹配。
/// 与 \`commands::git\` 中仓库根前缀比较保持一致的跨平台语义。
#[cfg(windows)]
fn os_str_eq(left: &OsStr, right: &OsStr) -> bool {
    left.eq_ignore_ascii_case(right)
}

#[cfg(not(windows))]
fn os_str_eq(left: &OsStr, right: &OsStr) -> bool {
    left == right
}

`,
		replace: ``,
		count: 1,
	},
];

const pathUtilContent = `//! 跨平台路径前缀剥离与组件相等性比较。
//!
//! commands::search::scan 与 commands::workspace_watcher 历史上各自维护了一份逐字
//! 相同的 relativize / os_str_eq（含 Windows 大小写不敏感的 cfg 分支）。二者语义完全
//! 一致，且与 commands::git 中仓库根前缀比较保持一致的跨平台约定，故抽到此共享模块
//! 统一维护，避免两份实现日后漂移。

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// 按组件逐级剥掉 root 前缀，返回 root 之下的相对路径。
///
/// 仅比较相对组件可避免一个隐蔽陷阱：当工作区根自身就在名为 node_modules（或
/// target 等）的目录里时，不应把整棵树误判为被忽略。前缀形态不一致（罕见）时返回
/// None，调用方据此放行。
pub(crate) fn relativize(root: &Path, path: &Path) -> Option<PathBuf> {
    let mut root_components = root.components();
    let mut path_components = path.components();
    loop {
        match root_components.next() {
            None => return Some(path_components.as_path().to_path_buf()),
            Some(root_component) => {
                let path_component = path_components.next()?;
                if !os_str_eq(root_component.as_os_str(), path_component.as_os_str()) {
                    return None;
                }
            }
        }
    }
}

/// 路径组件相等性：Windows 上大小写不敏感，其它平台精确匹配。
/// 与 commands::git 中仓库根前缀比较保持一致的跨平台语义。
#[cfg(windows)]
pub(crate) fn os_str_eq(left: &OsStr, right: &OsStr) -> bool {
    left.eq_ignore_ascii_case(right)
}

#[cfg(not(windows))]
pub(crate) fn os_str_eq(left: &OsStr, right: &OsStr) -> bool {
    left == right
}
`;

const editTargets = [
	{ path: "src-tauri/src/commands/terminal/state.rs", edits: stateEdits },
	{ path: "src-tauri/src/commands/search/find.rs", edits: findEdits },
	{ path: "src-tauri/src/commands/mod.rs", edits: modRsEdits },
	{ path: "src-tauri/src/commands/search/scan.rs", edits: scanEdits },
	{ path: "src-tauri/src/commands/workspace_watcher.rs", edits: watcherEdits },
];

const createTargets = [
	{ path: "src-tauri/src/commands/path_util.rs", content: pathUtilContent },
];

// ---- 第一阶段：全部校验并在内存中计算结果 ----
const writes = [];

for (const { path, content } of createTargets) {
	const abs = join(repoRoot, path);
	if (existsSync(abs)) {
		throw new Error(`目标文件已存在，已中止以免覆盖：${path}`);
	}
	writes.push({ abs, path, body: content, isNew: true });
}

for (const { path, edits } of editTargets) {
	const abs = join(repoRoot, path);
	if (!existsSync(abs)) {
		throw new Error(`找不到文件：${path}`);
	}
	const raw = readFileSync(abs, "utf8");
	const eol = detectEol(raw);
	let body = toLf(raw);
	edits.forEach((edit, i) => {
		const occ = countOccurrences(body, toLf(edit.find));
		if (occ !== edit.count) {
			throw new Error(
				`编辑 #${i + 1}（${path}）期望命中 ${edit.count} 处，实际 ${occ} 处。请确认仓库在 main 且未被改动后重试。`,
			);
		}
		body = body.split(toLf(edit.find)).join(edit.replace);
	});
	const out = eol === "\r\n" ? body.replace(/\n/g, "\r\n") : body;
	writes.push({ abs, path, body: out, isNew: false });
}

// ---- 第二阶段：统一写入 ----
for (const w of writes) {
	if (w.isNew) {
		mkdirSync(dirname(w.abs), { recursive: true });
	}
	writeFileSync(w.abs, w.body, "utf8");
	console.log(`${w.isNew ? "✓ 已创建" : "✓ 已更新"} ${w.path}`);
}

console.log(`\n全部完成，共处理 ${writes.length} 个文件。`);
console.log("建议依次执行：cargo build && cargo clippy && cargo test");
// fix-precompile-blockers.mjs
// 用途：修复 3 处与 B1a(ui_event.rs) 无关、但卡死 src-tauri 编译的既存断裂，
//      使 `cargo test --features acp_client ui_event` 能跑起来。
// 这三处分别是：
//   A) src/ai/edit/mod.rs        —— `use self::io::{self, ...}` 与 `pub mod io;` 重名 (E0255)
//   B) src/tauri_bindings.rs     —— 注册了 builtin_agent 已不存在的 get/set_tavily_api_key (E0433 x6)
//   C) src/ai/edit/patch.rs      —— 测试把 &PathBuf 传给已改签名的 list_operations(&Database) (E0308)
// 仅改这三个文件，不提交。运行：node fix-precompile-blockers.mjs

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()

/** 探测并归一 EOL：返回 { text(LF), eol }，写回时再还原 */
function detectEol(raw) {
	const crlf = (raw.match(/\r\n/g) || []).length
	const lfOnly = (raw.match(/(?<!\r)\n/g) || []).length
	const eol = crlf > lfOnly ? "\r\n" : "\n"
	return { text: raw.replace(/\r\n/g, "\n"), eol }
}

/** 精确一次替换，找不到或多于一次都抛错 */
function replaceOnce(text, oldStr, newStr, label) {
	const idx = text.indexOf(oldStr)
	if (idx === -1) throw new Error(`[${label}] 未找到锚点，文件可能已变化：\n${oldStr}`)
	if (text.indexOf(oldStr, idx + oldStr.length) !== -1)
		throw new Error(`[${label}] 锚点出现多次，拒绝模糊替换：\n${oldStr}`)
	return text.slice(0, idx) + newStr + text.slice(idx + oldStr.length)
}

function patchFile(relPath, mutate, checks) {
	const abs = join(ROOT, relPath)
	const raw = readFileSync(abs, "utf8")
	const { text, eol } = detectEol(raw)
	const next = mutate(text)
	for (const { kind, marker, label } of checks) {
		const present = next.includes(marker)
		if (kind === "present" && !present) throw new Error(`[${relPath}] 自检失败：应存在 ${label}`)
		if (kind === "absent" && present) throw new Error(`[${relPath}] 自检失败：应已移除 ${label}`)
	}
	writeFileSync(abs, next.replace(/\n/g, eol), "utf8")
	console.log(`✓ ${relPath}`)
}

// ── A) ai/edit/mod.rs：去掉与 `pub mod io;` 冲突的 `self` 重导入 ──────────────
patchFile(
	"src-tauri/src/ai/edit/mod.rs",
	(t) =>
		replaceOnce(
			t,
			"use self::io::{self, file_transaction};",
			"use self::io::file_transaction;",
			"mod.rs/io-import",
		),
	[
		{ kind: "present", marker: "use self::io::file_transaction;", label: "归一后的 io 导入" },
		{ kind: "absent", marker: "use self::io::{self, file_transaction};", label: "旧的 self 重导入" },
		// io:: 路径仍被 with_aed_database_read/write 使用，pub mod io 提供该名字，无需再导入
	],
)

// ── B) tauri_bindings.rs：删除 builtin_agent 已不存在的 tavily 命令注册 ─────────
patchFile(
	"src-tauri/src/tauri_bindings.rs",
	(t) =>
		replaceOnce(
			t,
			[
				"            builtin_agent::builtin_agent_restore_checkpoint,",
				"            builtin_agent::get_tavily_api_key,",
				"            builtin_agent::set_tavily_api_key,",
			].join("\n"),
			"            builtin_agent::builtin_agent_restore_checkpoint,",
			"tauri_bindings/tavily-regs",
		),
	[
		{ kind: "absent", marker: "builtin_agent::get_tavily_api_key", label: "get_tavily_api_key 注册" },
		{ kind: "absent", marker: "builtin_agent::set_tavily_api_key", label: "set_tavily_api_key 注册" },
		{ kind: "present", marker: "builtin_agent::builtin_agent_restore_checkpoint,", label: "保留的 restore_checkpoint 注册" },
	],
)

// ── C) ai/edit/patch.rs：测试改用 io::with_aed_database_read 打开 Database ──────
patchFile(
	"src-tauri/src/ai/edit/patch.rs",
	(t) =>
		replaceOnce(
			t,
			'            edit_journal::list_operations(&snapshot_root).expect("operations should be listed"),',
			[
				'            ai_edit::io::with_aed_database_read(&snapshot_root, "测试读取 AED 操作日志", |db| {',
				"                edit_journal::list_operations(db)",
				"            })",
				'            .expect("operations should be listed"),',
			].join("\n"),
			"patch.rs/list_operations-test",
		),
	[
		{ kind: "present", marker: "ai_edit::io::with_aed_database_read(&snapshot_root", label: "包裹后的 DB 读取" },
		{ kind: "absent", marker: "edit_journal::list_operations(&snapshot_root)", label: "旧的 &PathBuf 调用" },
	],
)

console.log("\n全部修复完成。建议：")
console.log("  cargo test --features acp_client --manifest-path src-tauri/Cargo.toml ui_event")
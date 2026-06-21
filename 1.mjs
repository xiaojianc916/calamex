// fix-workspace-profile.mjs
// 将 [profile.release] 从 workspace 成员包 src-tauri/Cargo.toml 移到根 Cargo.toml。
// Cargo 只认根 workspace 的 profile，成员包里的会被忽略（cargo 会 warning）。
// 用法：项目根目录执行 `node fix-workspace-profile.mjs`

import { readFile, writeFile, access } from "node:fs/promises"

const MEMBER = "src-tauri/Cargo.toml"
const ROOT = "Cargo.toml"
const MARKER = "[profile.release]"

function must(cond, msg) {
	if (!cond) {
		console.error(`✗ ${msg}`)
		process.exit(1)
	}
}

async function exists(p) {
	try {
		await access(p)
		return true
	} catch {
		return false
	}
}

async function main() {
	must(await exists(MEMBER), `找不到 ${MEMBER}，请在项目根目录运行本脚本。`)
	must(await exists(ROOT), `找不到 ${ROOT}，请在项目根目录运行本脚本。`)

	const memberSrc = await readFile(MEMBER, "utf8")
	const rootSrc = await readFile(ROOT, "utf8")

	const memberHas = memberSrc.includes(MARKER)
	const rootHas = rootSrc.includes(MARKER)

	// 幂等：已经搬过就直接退出。
	if (!memberHas && rootHas) {
		console.log(`✓ 已迁移：${MARKER} 已在根 ${ROOT}，${MEMBER} 中已无。`)
		return
	}

	must(
		memberHas,
		`${MEMBER} 中找不到 ${MARKER}，可能已被改动，请人工核对后再处理。`,
	)
	must(
		!rootHas,
		`根 ${ROOT} 已存在 ${MARKER}，为避免重复/冲突已中止，请人工核对。`,
	)

	// 定位 profile 块；要求它位于文件末尾（其后不应再有别的 [section]）。
	const idx = memberSrc.indexOf(MARKER)
	const after = memberSrc.slice(idx + MARKER.length)
	must(
		!/\n\s*\[/.test(after),
		`${MARKER} 之后还有其它 section，不在文件末尾，为安全起见已中止，请人工迁移。`,
	)

	// 提取 profile 块（去掉尾部多余空白，规整为单个换行结尾）。
	const block = memberSrc.slice(idx).replace(/\s+$/, "") + "\n"
	must(block.startsWith(MARKER), "提取 profile 块失败，已中止。")

	// 从成员包移除该块，并把它前面的多余空行收敛为单个换行。
	const newMember = memberSrc.slice(0, idx).replace(/\n*$/, "\n")
	must(newMember !== memberSrc, "成员包内容未变化，已中止。")
	must(!newMember.includes(MARKER), "移除后成员包仍含 profile 块，已中止。")

	// 追加到根 Cargo.toml，保留原有 BOM，用一个空行分隔。
	const bom = rootSrc.startsWith("\uFEFF") ? "\uFEFF" : ""
	const rootBody = (bom ? rootSrc.slice(1) : rootSrc).replace(/\n*$/, "\n")
	const newRoot = `${bom}${rootBody}\n${block}`

	await writeFile(MEMBER, newMember, "utf8")
	await writeFile(ROOT, newRoot, "utf8")

	console.log(`✓ 已将 ${MARKER} 从 ${MEMBER} 移动到根 ${ROOT}`)
	console.log(`  （根文件 BOM ${bom ? "已保留" : "无，无需处理"}）`)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
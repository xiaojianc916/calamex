// fix-rxjs-catalog-migration.mjs
// 将 rxjs 的 pnpm overrides 从已弃用的 "$rxjs" 引用语法迁移到 catalog 协议。
// - pnpm-workspace.yaml：新增顶层 catalog（rxjs 单一版本来源）；override 改为 "catalog:"
// - package.json：直接依赖 rxjs 也改用 "catalog:"，与 catalog 共用同一版本
// 用法：项目根目录执行 `node fix-rxjs-catalog-migration.mjs`，随后 `pnpm install`

import { readFile, writeFile, access } from "node:fs/promises"

const WORKSPACE = "pnpm-workspace.yaml"
const PKG = "package.json"
const RXJS_VERSION = "^7.8.2" // 与原 package.json 中的 rxjs 规格保持一致

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

function countOccurrences(text, needle) {
	return text.split(needle).length - 1
}

async function migrateWorkspace() {
	must(await exists(WORKSPACE), `找不到 ${WORKSPACE}，请在项目根目录运行本脚本。`)
	const src = await readFile(WORKSPACE, "utf8")
	let out = src

	// 1) override：把已弃用的 "$rxjs" 改为 catalog: 协议。
	const OLD_OVERRIDE = `"rxjs": "$rxjs"`
	const NEW_OVERRIDE = `rxjs: "catalog:"`
	if (out.includes(OLD_OVERRIDE)) {
		const n = countOccurrences(out, OLD_OVERRIDE)
		must(n === 1, `${WORKSPACE} 中 ${OLD_OVERRIDE} 出现 ${n} 次（预期 1 次），已中止。`)
		out = out.replace(OLD_OVERRIDE, NEW_OVERRIDE)
	} else {
		must(
			/^\s*"?rxjs"?:\s*"catalog:"/m.test(out),
			`${WORKSPACE} 既无 "$rxjs" 也无 catalog 形式的 rxjs override，请人工核对。`,
		)
	}

	// 2) 顶层 catalog（按行首匹配，避免误命中 override 值里的 "catalog:" 字串）。
	if (!/^catalog:/m.test(out)) {
		out = `${out.replace(/\n*$/, "\n")}catalog:\n  rxjs: ${RXJS_VERSION}\n`
	}

	if (out !== src) {
		await writeFile(WORKSPACE, out, "utf8")
		console.log(`✓ 已更新 ${WORKSPACE}（新增 catalog；override 改用 catalog: 协议）`)
	} else {
		console.log(`✓ ${WORKSPACE} 已是 catalog 形式，无需改动`)
	}
}

async function migratePackageJson() {
	must(await exists(PKG), `找不到 ${PKG}，请在项目根目录运行本脚本。`)
	const src = await readFile(PKG, "utf8")
	const NEW = `"rxjs": "catalog:"`
	if (src.includes(NEW)) {
		console.log(`✓ ${PKG} 的 rxjs 已是 catalog:，无需改动`)
		return
	}
	const OLD = `"rxjs": "${RXJS_VERSION}"`
	must(src.includes(OLD), `${PKG} 中找不到 ${OLD}，可能版本规格已变，请人工核对。`)
	const n = countOccurrences(src, OLD)
	must(n === 1, `${PKG} 中 ${OLD} 出现 ${n} 次（预期 1 次），已中止。`)
	await writeFile(PKG, src.replace(OLD, NEW), "utf8")
	console.log(`✓ 已更新 ${PKG}（rxjs 直接依赖改用 catalog:）`)
}

async function main() {
	await migrateWorkspace()
	await migratePackageJson()
	console.log("\n下一步：运行 `pnpm install` 让 catalog 生效，再用 `pnpm why rxjs` 确认仅有单一 7.8.x。")
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
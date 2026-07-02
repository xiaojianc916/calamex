// vue-setup.mjs — 专门处理 Vue：改用 Zed 官方使用的 tree-sitter-grammars/tree-sitter-vue（不是 ikatyang 那个坏掉的仓库）
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const LOCK_PATH = join(ROOT, "grammars.lock.json")
const TMP_DIR = join(ROOT, ".grammar-tmp", "vue-fix")
const WASM_OUT = join(ROOT, "src/services/editor/tree-sitter/wasm")
const QUERIES_OUT = join(ROOT, "src/services/editor/tree-sitter/queries/vue")
const TS_BIN = process.env.TREE_SITTER_BIN || "tree-sitter"

// Zed 官方 Vue 扩展实际使用的仓库 + commit（见 zed-extensions/vue 的 extension.toml）
const REPO = "https://github.com/tree-sitter-grammars/tree-sitter-vue"
const PINNED_COMMIT = "7e48557b903a9db9c38cea3b7839ef7e1f36c693"

function fetchWithRetry(ref, attempts = 4) {
	let lastErr
	for (let i = 0; i < attempts; i++) {
		try {
			rmSync(TMP_DIR, { recursive: true, force: true })
			mkdirSync(TMP_DIR, { recursive: true })
			execFileSync("git", ["init", "-q", TMP_DIR])
			execFileSync("git", ["remote", "add", "origin", REPO], { cwd: TMP_DIR })
			execFileSync("git", ["fetch", "--depth", "1", "origin", ref], { cwd: TMP_DIR, stdio: "inherit" })
			execFileSync("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: TMP_DIR })
			return
		} catch (e) {
			lastErr = e
			console.log(`  重试 ${i + 1}/${attempts} 失败: ${String(e.message).split("\n")[0]}`)
		}
	}
	throw lastErr
}

console.log(`=== vue（改用 ${REPO}#${PINNED_COMMIT}） ===`)

try {
	fetchWithRetry(PINNED_COMMIT)

	const resolvedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: TMP_DIR }).toString().trim()
	console.log(`  已拉取 commit: ${resolvedCommit}`)

	// 1) 编译 wasm
	const destWasm = join(WASM_OUT, "tree-sitter-vue.wasm")
	mkdirSync(WASM_OUT, { recursive: true })
	try {
		execFileSync(TS_BIN, ["generate"], { cwd: TMP_DIR, stdio: "inherit" })
	} catch (genErr) {
		console.log(`  (generate 跳过或失败，可能已有 parser.c: ${String(genErr.message).split("\n")[0]})`)
	}
	execFileSync(TS_BIN, ["build", "--wasm", TMP_DIR, "-o", destWasm], { stdio: "inherit" })
	console.log(`  ✅ wasm 编译成功 -> ${destWasm}`)

	// 2) 复制 queries
	const queriesSrcDir = join(TMP_DIR, "queries")
	mkdirSync(QUERIES_OUT, { recursive: true })
	const queryFiles = ["highlights.scm", "folds.scm", "indents.scm", "injections.scm", "locals.scm", "tags.scm"]
	const copied = []
	for (const qf of queryFiles) {
		const src = join(queriesSrcDir, qf)
		if (existsSync(src)) {
			copyFileSync(src, join(QUERIES_OUT, qf))
			copied.push(qf)
		}
	}
	console.log(`  ✅ queries 复制: ${copied.join(", ") || "(无)"}`)

	// 3) 更新 lock 文件
	const lock = existsSync(LOCK_PATH) ? JSON.parse(readFileSync(LOCK_PATH, "utf8")) : {}
	lock.vue = { repo: REPO, commit: resolvedCommit }
	writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2))
	console.log(`  ✅ grammars.lock.json 已更新 vue 条目`)

	console.log("\n🎉 Vue 修复完成！wasm 和 queries 都已就位。")
} catch (e) {
	console.log(`❌ 失败: ${e.message}`)
} finally {
	rmSync(TMP_DIR, { recursive: true, force: true })
}
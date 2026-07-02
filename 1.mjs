// 6-add-remaining-languages.mjs — scss/less/powershell/sql/xml/r/latex/proto/ini 接入 tree-sitter
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const LOCK_PATH = join(ROOT, "grammars.lock.json")
const TMP_DIR = join(ROOT, ".grammar-tmp")
const WASM_OUT = join(ROOT, "src/services/editor/tree-sitter/wasm")
const QUERIES_OUT = join(ROOT, "src/services/editor/tree-sitter/queries")
const TS_BIN = process.env.TREE_SITTER_BIN || "tree-sitter"

// 官方/主流维护仓库；不指定分支，直接克隆默认 HEAD，避免分支名猜错。
const SOURCES = {
	scss: { repo: "https://github.com/tree-sitter-grammars/tree-sitter-scss" },
	less: { repo: "https://github.com/jimliang/tree-sitter-less" },
	powershell: { repo: "https://github.com/airbus-cert/tree-sitter-powershell" },
	sql: { repo: "https://github.com/DerekStride/tree-sitter-sql" },
	xml: { repo: "https://github.com/tree-sitter-grammars/tree-sitter-xml", subdir: "xml" },
	r: { repo: "https://github.com/r-lib/tree-sitter-r" },
	latex: { repo: "https://github.com/latex-lsp/tree-sitter-latex" },
	proto: { repo: "https://github.com/coder3101/tree-sitter-proto" },
	ini: { repo: "https://github.com/justinmk/tree-sitter-ini" },
}

const QUERY_FILES = ["highlights.scm", "folds.scm", "indents.scm", "injections.scm", "locals.scm", "tags.scm"]
const lock = existsSync(LOCK_PATH) ? JSON.parse(readFileSync(LOCK_PATH, "utf8")) : {}
const only = process.argv.slice(2)

function findQueriesDir(baseDir) {
	const direct = join(baseDir, "queries")
	if (existsSync(direct)) return direct
	try {
		for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				const nested = join(baseDir, entry.name, "queries")
				if (existsSync(nested)) return nested
			}
		}
	} catch {}
	return null
}

function cloneWithRetry(repo, tmpDir, attempts = 4) {
	let lastErr
	for (let i = 0; i < attempts; i++) {
		try {
			rmSync(tmpDir, { recursive: true, force: true })
			mkdirSync(tmpDir, { recursive: true })
			execFileSync("git", ["clone", "--depth", "1", repo, tmpDir], { stdio: "inherit" })
			return
		} catch (e) {
			lastErr = e
			console.log(`  重试 ${i + 1}/${attempts} 失败: ${String(e.message).split("\n")[0]}`)
		}
	}
	throw lastErr
}

const results = []

for (const [name, cfg] of Object.entries(SOURCES)) {
	if (only.length && !only.includes(name)) continue
	const tmpDir = join(TMP_DIR, name)
	console.log(`\n=== ${name} (${cfg.repo}) ===`)

	try {
		cloneWithRetry(cfg.repo, tmpDir)
		const resolvedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir }).toString().trim()

		const grammarDir = cfg.subdir ? join(tmpDir, cfg.subdir) : tmpDir
		const wasmName = `tree-sitter-${name}.wasm`
		const destWasm = join(WASM_OUT, wasmName)
		mkdirSync(WASM_OUT, { recursive: true })

		// 部分仓库不提交生成的 parser.c（如 swift），先尝试 generate，失败/跳过不影响后续 build。
		try {
			execFileSync(TS_BIN, ["generate"], { cwd: grammarDir, stdio: "inherit" })
		} catch (genErr) {
			console.log(`  (generate 跳过或失败: ${String(genErr.message).split("\n")[0]})`)
		}

		execFileSync(TS_BIN, ["build", "--wasm", grammarDir, "-o", destWasm], { stdio: "inherit" })
		console.log(`  ✅ wasm -> ${wasmName} (commit ${resolvedCommit.slice(0, 8)})`)

		const queriesDir = findQueriesDir(grammarDir) || findQueriesDir(tmpDir)
		const found = []
		if (queriesDir) {
			const destDir = join(QUERIES_OUT, name)
			mkdirSync(destDir, { recursive: true })
			for (const qf of QUERY_FILES) {
				const src = join(queriesDir, qf)
				if (existsSync(src)) {
					copyFileSync(src, join(destDir, qf))
					found.push(qf)
				}
			}
		}
		console.log(`  ✅ queries: ${found.join(", ") || "(未找到)"}`)

		lock[name] = { repo: cfg.repo, commit: resolvedCommit }
		results.push({ name, status: "✅", queries: found })
	} catch (e) {
		console.log(`  ❌ 失败: ${e.message}`)
		results.push({ name, status: "❌" })
	}
}

writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2))
rmSync(TMP_DIR, { recursive: true, force: true })

console.log("\n========== 汇总 ==========")
for (const r of results) console.log(`${r.status} ${r.name}${r.queries ? ` (${r.queries.join(", ") || "无 queries"})` : ""}`)
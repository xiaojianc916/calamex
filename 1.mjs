// 2-fetch-queries.mjs — 从各语法仓库拉取官方 queries（highlights/folds/indents/injections.scm），带克隆重试
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const LOCK_PATH = join(ROOT, "grammars.lock.json")
const TMP_DIR = join(ROOT, ".grammar-tmp")
const QUERIES_OUT = join(ROOT, "src/services/editor/tree-sitter/queries")

const SOURCES = {
	bash: { repo: "https://github.com/tree-sitter/tree-sitter-bash" },
	javascript: { repo: "https://github.com/tree-sitter/tree-sitter-javascript" },
	typescript: { repo: "https://github.com/tree-sitter/tree-sitter-typescript", subdir: "typescript" },
	tsx: { repo: "https://github.com/tree-sitter/tree-sitter-typescript", subdir: "tsx" },
	python: { repo: "https://github.com/tree-sitter/tree-sitter-python" },
	rust: { repo: "https://github.com/tree-sitter/tree-sitter-rust" },
	go: { repo: "https://github.com/tree-sitter/tree-sitter-go" },
	c: { repo: "https://github.com/tree-sitter/tree-sitter-c" },
	cpp: { repo: "https://github.com/tree-sitter/tree-sitter-cpp" },
	java: { repo: "https://github.com/tree-sitter/tree-sitter-java" },
	json: { repo: "https://github.com/tree-sitter/tree-sitter-json" },
	html: { repo: "https://github.com/tree-sitter/tree-sitter-html" },
	css: { repo: "https://github.com/tree-sitter/tree-sitter-css" },
	ruby: { repo: "https://github.com/tree-sitter/tree-sitter-ruby" },
	yaml: { repo: "https://github.com/tree-sitter-grammars/tree-sitter-yaml" },
	toml: { repo: "https://github.com/tree-sitter-grammars/tree-sitter-toml" },
	lua: { repo: "https://github.com/tree-sitter-grammars/tree-sitter-lua" },
	"c-sharp": { repo: "https://github.com/tree-sitter/tree-sitter-c-sharp" },
	kotlin: { repo: "https://github.com/fwcd/tree-sitter-kotlin" },
	scala: { repo: "https://github.com/tree-sitter/tree-sitter-scala" },
	swift: { repo: "https://github.com/alex-pinkus/tree-sitter-swift" },
	dart: { repo: "https://github.com/UserNobody14/tree-sitter-dart" },
	diff: { repo: "https://github.com/tree-sitter-grammars/tree-sitter-diff" },
	dockerfile: { repo: "https://github.com/camdencheek/tree-sitter-dockerfile" },
	markdown: { repo: "https://github.com/tree-sitter-grammars/tree-sitter-markdown", subdir: "tree-sitter-markdown" },
}

const QUERY_FILES = ["highlights.scm", "folds.scm", "indents.scm", "injections.scm", "locals.scm", "tags.scm"]
const lock = existsSync(LOCK_PATH) ? JSON.parse(readFileSync(LOCK_PATH, "utf8")) : {}
const only = process.argv.slice(2)

function findQueriesDir(baseDir) {
	const candidates = [join(baseDir, "queries")]
	for (const c of candidates) {
		if (existsSync(c)) return c
	}
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

function cloneWithRetry(repo, tmpDir, ref, attempts = 3) {
	let lastErr
	for (let i = 0; i < attempts; i++) {
		try {
			rmSync(tmpDir, { recursive: true, force: true })
			mkdirSync(tmpDir, { recursive: true })
			if (ref) {
				execFileSync("git", ["clone", repo, tmpDir], { stdio: "inherit" })
				execFileSync("git", ["checkout", ref], { cwd: tmpDir, stdio: "inherit" })
			} else {
				execFileSync("git", ["clone", "--depth", "1", repo, tmpDir], { stdio: "inherit" })
			}
			return
		} catch (e) {
			lastErr = e
			console.log(`  重试 ${i + 1}/${attempts} 失败: ${String(e.message).split("\n")[0]}`)
		}
	}
	throw lastErr
}

const report = []

for (const [name, cfg] of Object.entries(SOURCES)) {
	if (only.length && !only.includes(name)) continue
	const tmpDir = join(TMP_DIR, `q-${name}`)

	const ref = lock[name]?.commit
	console.log(`\n=== ${name} ===`)
	try {
		cloneWithRetry(cfg.repo, tmpDir, ref)

		const grammarDir = cfg.subdir ? join(tmpDir, cfg.subdir) : tmpDir
		const queriesDir = findQueriesDir(grammarDir) || findQueriesDir(tmpDir)

		if (!queriesDir) {
			console.log(`  ⚠️ 未找到 queries 目录`)
			report.push({ name, found: [] })
			continue
		}

		const destDir = join(QUERIES_OUT, name)
		mkdirSync(destDir, { recursive: true })
		const found = []
		for (const qf of QUERY_FILES) {
			const src = join(queriesDir, qf)
			if (existsSync(src)) {
				copyFileSync(src, join(destDir, qf))
				found.push(qf)
			}
		}
		console.log(`  ✅ 复制: ${found.join(", ") || "(无)"}`)
		report.push({ name, found })
	} catch (e) {
		console.log(`  ❌ 失败: ${e.message}`)
		report.push({ name, found: [], error: true })
	}
}

rmSync(TMP_DIR, { recursive: true, force: true })

console.log("\n========== 查询文件汇总 ==========")
for (const r of report) {
	console.log(`${r.error ? "❌" : r.found.length ? "✅" : "⚠️ "} ${r.name}: ${r.found.join(", ") || "无"}`)
}
// 1.mjs — 一体化：内置仓库表 + git clone + tree-sitter build --wasm + 落锁
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const LOCK_PATH = join(ROOT, "grammars.lock.json")
const TMP_DIR = join(ROOT, ".grammar-tmp")
const WASM_OUT = join(ROOT, "src/services/editor/tree-sitter/wasm")
const TS_BIN = process.env.TREE_SITTER_BIN || "tree-sitter"

// ── 仓库来源表（对应 Zed extension.toml 的 [grammars.x] repository + commit）──
const SOURCES = {
	bash: { repo: "https://github.com/tree-sitter/tree-sitter-bash", ref: "master" },
	javascript: { repo: "https://github.com/tree-sitter/tree-sitter-javascript", ref: "master" },
	typescript: { repo: "https://github.com/tree-sitter/tree-sitter-typescript", ref: "master", subdir: "typescript", wasmName: "tree-sitter-typescript.wasm" },
	tsx: { repo: "https://github.com/tree-sitter/tree-sitter-typescript", ref: "master", subdir: "tsx", wasmName: "tree-sitter-tsx.wasm" },
	python: { repo: "https://github.com/tree-sitter/tree-sitter-python", ref: "master" },
	rust: { repo: "https://github.com/tree-sitter/tree-sitter-rust", ref: "master" },
	go: { repo: "https://github.com/tree-sitter/tree-sitter-go", ref: "master" },
	c: { repo: "https://github.com/tree-sitter/tree-sitter-c", ref: "master" },
	cpp: { repo: "https://github.com/tree-sitter/tree-sitter-cpp", ref: "master" },
	java: { repo: "https://github.com/tree-sitter/tree-sitter-java", ref: "master" },
	json: { repo: "https://github.com/tree-sitter/tree-sitter-json", ref: "master" },
	html: { repo: "https://github.com/tree-sitter/tree-sitter-html", ref: "master" },
	css: { repo: "https://github.com/tree-sitter/tree-sitter-css", ref: "master" },
	ruby: { repo: "https://github.com/tree-sitter/tree-sitter-ruby", ref: "master" },
	yaml: { repo: "https://github.com/tree-sitter-grammars/tree-sitter-yaml", ref: "master" },
	toml: { repo: "https://github.com/tree-sitter-grammars/tree-sitter-toml", ref: "master" },
	lua: { repo: "https://github.com/tree-sitter-grammars/tree-sitter-lua", ref: "master" },
	"c-sharp": { repo: "https://github.com/tree-sitter/tree-sitter-c-sharp", ref: "master" },
	kotlin: { repo: "https://github.com/fwcd/tree-sitter-kotlin", ref: "main" },
	scala: { repo: "https://github.com/tree-sitter/tree-sitter-scala", ref: "master" },
	swift: { repo: "https://github.com/alex-pinkus/tree-sitter-swift", ref: "main" },
	vue: { repo: "https://github.com/ikatyang/tree-sitter-vue", ref: "master" },
	dart: { repo: "https://github.com/UserNobody14/tree-sitter-dart", ref: "master" },
	diff: { repo: "https://github.com/tree-sitter-grammars/tree-sitter-diff", ref: "main" },
	dockerfile: { repo: "https://github.com/camdencheek/tree-sitter-dockerfile", ref: "main" },
	markdown: { repo: "https://github.com/tree-sitter-grammars/tree-sitter-markdown", ref: "split_parser", subdir: "tree-sitter-markdown", wasmName: "tree-sitter-markdown.wasm" },
}

// 可选：node 1.mjs javascript python  只跑指定语言；不传参数则跑全部
const only = process.argv.slice(2)

mkdirSync(WASM_OUT, { recursive: true })
const lock = existsSync(LOCK_PATH) ? JSON.parse(readFileSync(LOCK_PATH, "utf8")) : {}

const results = []

for (const [name, cfg] of Object.entries(SOURCES)) {
	if (only.length && !only.includes(name)) continue
	const tmpDir = join(TMP_DIR, name)
	rmSync(tmpDir, { recursive: true, force: true })
	mkdirSync(tmpDir, { recursive: true })

	const ref = lock[name]?.commit || cfg.ref
	console.log(`\n=== ${name} (${cfg.repo}#${ref}) ===`)

	try {
		try {
			execFileSync("git", ["clone", "--depth", "1", "--branch", ref, cfg.repo, tmpDir], { stdio: "inherit" })
		} catch {
			// ref 是 commit sha 而非分支/tag -> 完整克隆再 checkout
			rmSync(tmpDir, { recursive: true, force: true })
			mkdirSync(tmpDir, { recursive: true })
			execFileSync("git", ["clone", cfg.repo, tmpDir], { stdio: "inherit" })
			execFileSync("git", ["checkout", ref], { cwd: tmpDir, stdio: "inherit" })
		}

		const resolvedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir }).toString().trim()
		const grammarDir = cfg.subdir ? join(tmpDir, cfg.subdir) : tmpDir
		const wasmName = cfg.wasmName || `tree-sitter-${name}.wasm`
		const destWasm = join(WASM_OUT, wasmName)

		execFileSync(TS_BIN, ["build", "--wasm", grammarDir, "-o", destWasm], { stdio: "inherit" })

		console.log(`✅ ${name} -> ${wasmName} (commit ${resolvedCommit.slice(0, 8)})`)
		lock[name] = { repo: cfg.repo, commit: resolvedCommit }
		results.push({ name, status: "✅" })
	} catch (e) {
		console.log(`❌ ${name} 失败: ${e.message}`)
		results.push({ name, status: "❌" })
	}
}

writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2))
rmSync(TMP_DIR, { recursive: true, force: true })

console.log("\n========== 汇总 ==========")
for (const r of results) console.log(`${r.status} ${r.name}`)
console.log(`\n锁定文件已写入: ${LOCK_PATH}`)
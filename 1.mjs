// 17-converge-final.mjs — tree-sitter 唯一核心引擎：全部语言统一，删除 bash 专属模块与 legacy 导入
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const EDITOR_DIR = join(ROOT, "src/services/editor")

// ── 1) codemirror-language.ts：全部 36 个语言 → 通用结构引擎；移除 stream/legacy 相关 ──
{
	const PATH = join(EDITOR_DIR, "codemirror-language.ts")
	let content = readFileSync(PATH, "utf8")

	// 1a) import：去掉 StreamLanguage
	content = content.replace(
		`import { LanguageSupport, StreamLanguage } from '@codemirror/language';`,
		`import { LanguageSupport } from '@codemirror/language';`,
	)

	// 1b) 删除 streamLanguageLoader 辅助块（含类型与注释）
	const streamBlock = `// StreamLanguage.define 的参数类型(legacy stream 模式)。
type CodeMirrorStreamParser = Parameters<typeof StreamLanguage.define>[0];

// 把一个"动态 import legacy stream parser"的 loader 包装成返回 LanguageSupport 的懒加载器。
// 语法包只有在该语言首次被用到时才会被动态 import(Vite 代码分割)。
const streamLanguageLoader =
  (loader: () => Promise<CodeMirrorStreamParser>) => async (): Promise<LanguageSupport> =>
    new LanguageSupport(StreamLanguage.define(await loader()));

`
	if (content.includes(streamBlock)) {
		content = content.replace(streamBlock, "")
	} else {
		console.log("⚠️ streamLanguageLoader 块未命中")
	}

	// 1c) 整个 loaders 对象 → 全通用
	const oldLoaders = content.slice(
		content.indexOf("const CODEMIRROR_LANGUAGE_LOADERS"),
		content.indexOf("};", content.indexOf("const CODEMIRROR_LANGUAGE_LOADERS")) + 2,
	)
	const ids = [
		"shell", "javascript", "jsx", "typescript", "tsx", "html", "vue", "css", "scss", "less",
		"json", "markdown", "dockerfile", "diff", "c", "cpp", "csharp", "dart", "go", "java",
		"kotlin", "lua", "powershell", "proto", "python", "r", "ruby", "rust", "scala", "sql",
		"latex", "swift", "toml", "ini", "xml", "yaml",
	]
	const newLoaders =
		`const CODEMIRROR_LANGUAGE_LOADERS: Readonly<Record<string, () => Promise<Extension>>> = {\n` +
		ids.map((id) => `  ${id}: async () => treeSitterStructureExtensions('${id}'),`).join("\n") +
		`\n};`
	if (oldLoaders.startsWith("const CODEMIRROR_LANGUAGE_LOADERS") && oldLoaders.endsWith("};")) {
		content = content.replace(oldLoaders, newLoaders)
		console.log("✅ codemirror-language.ts: 36 个语言全部改为通用结构引擎")
	} else {
		console.log("⚠️ loaders 对象定位失败")
	}

	writeFileSync(PATH, content, "utf8")
}

// ── 2) structure.ts：补全所有语言的行注释 token ──
{
	const PATH = join(EDITOR_DIR, "codemirror-tree-sitter-structure.ts")
	let content = readFileSync(PATH, "utf8")
	const oldBlock = content.slice(
		content.indexOf("const LINE_COMMENT_TOKENS"),
		content.indexOf("};", content.indexOf("const LINE_COMMENT_TOKENS")) + 2,
	)
	const newBlock = `const LINE_COMMENT_TOKENS: Readonly<Record<string, string>> = {
  shell: '#',
  javascript: '//',
  jsx: '//',
  typescript: '//',
  tsx: '//',
  c: '//',
  cpp: '//',
  csharp: '//',
  dart: '//',
  go: '//',
  java: '//',
  kotlin: '//',
  lua: '--',
  powershell: '#',
  proto: '//',
  python: '#',
  r: '#',
  ruby: '#',
  rust: '//',
  scala: '//',
  scss: '//',
  less: '//',
  sql: '--',
  swift: '//',
  toml: '#',
  ini: ';',
  latex: '%',
  yaml: '#',
  dockerfile: '#',
};`
	if (oldBlock.startsWith("const LINE_COMMENT_TOKENS") && oldBlock.endsWith("};")) {
		content = content.replace(oldBlock, newBlock)
		writeFileSync(PATH, content, "utf8")
		console.log("✅ structure.ts: 行注释 token 表已补全")
	} else {
		console.log("⚠️ LINE_COMMENT_TOKENS 定位失败")
	}
}

// ── 3) structural-selection.ts：去掉 bash 专用分支，统一走通用 tree-sitter ──
{
	const PATH = join(EDITOR_DIR, "codemirror-structural-selection.ts")
	let content = readFileSync(PATH, "utf8")
	content = content.replace(
		`import { expandRangeWithBashTree } from './codemirror-bash-language';\nimport { expandRangeWithTreeSitter } from './codemirror-tree-sitter-structure';`,
		`import { expandRangeWithTreeSitter } from './codemirror-tree-sitter-structure';`,
	)
	content = content.replace(
		`      // shell 走 bash 专用树；其余语言走通用 tree-sitter 结构树；两者都命中不了才回退 Lezer。
      const tsRange =
        expandRangeWithBashTree(state, range.from, range.to) ??
        expandRangeWithTreeSitter(state, range.from, range.to);
      if (tsRange) {`,
		`      // 所有语言（含 shell）统一走通用 tree-sitter 结构树。
      const tsRange = expandRangeWithTreeSitter(state, range.from, range.to);
      if (tsRange) {`,
	)
	writeFileSync(PATH, content, "utf8")
	console.log("✅ structural-selection.ts: 已去除 bash 专用分支")
}

// ── 4) 确认无其它引用后，删除 bash 专属模块 ──
{
	const targets = ["codemirror-bash-language.ts", "codemirror-bash-language.spec.ts"]
	const remaining = []
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name)
			if (statSync(full).isDirectory()) {
				walk(full)
			} else if (/\.(ts|tsx|vue|mjs|js)$/.test(name) && !targets.includes(name)) {
				if (readFileSync(full, "utf8").includes("codemirror-bash-language")) {
					remaining.push(full)
				}
			}
		}
	}
	walk(join(ROOT, "src"))

	if (remaining.length > 0) {
		console.log("⚠️ 仍有文件引用 codemirror-bash-language，未删除。请处理这些引用后再删：")
		for (const f of remaining) console.log("   - " + f)
	} else {
		for (const t of targets) {
			const p = join(EDITOR_DIR, t)
			if (existsSync(p)) {
				rmSync(p)
				console.log(`✅ 已删除 ${t}`)
			}
		}
	}
}

console.log("\n完成。重启 dev server，逐个语言测试高亮/折叠/缩进/结构选区（Mod-i）。")
// 4-enable-full-highlighting.mjs — 补齐 capture 映射（markdown/diff/rust 等）+ 修复 vue wasm 引用
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const HIGHLIGHT_TS = join(ROOT, "src/services/editor/codemirror-tree-sitter-highlight.ts")
const REGISTRY_TS = join(ROOT, "src/services/editor/tree-sitter/language-registry.generated.ts")

// ── 1) 修复 vue wasm 引用：从坏掉的 npm 包切到本地自编译产物 ──
{
	let content = readFileSync(REGISTRY_TS, "utf8")
	const before = content
	content = content.replace(
		/\/\/ vue 暂不支持[^\n]*\nimport vue_wasm from 'tree-sitter-wasms\/out\/tree-sitter-vue\.wasm\?url';/,
		"import vue_wasm from './wasm/tree-sitter-vue.wasm?url';",
	)
	if (content === before) {
		console.log("⚠️ 未找到 vue_wasm 旧引用锚点，请人工检查 language-registry.generated.ts 是否已手动改过")
	} else {
		writeFileSync(REGISTRY_TS, content, "utf8")
		console.log("✅ vue_wasm 已切换为本地自编译产物")
	}
}

// ── 2) 扩充 CAPTURE_CLASS 与主题，覆盖 markdown/diff/rust 等官方查询实际用到、但当前未映射的 capture ──
{
	let content = readFileSync(HIGHLIGHT_TS, "utf8")

	const oldCaptureBlock = `const CAPTURE_CLASS: Readonly<Record<string, string>> = {
  comment: 'cm-tsh-comment',
  string: 'cm-tsh-string',
  character: 'cm-tsh-string',
  'string.escape': 'cm-tsh-escape',
  escape: 'cm-tsh-escape',
  number: 'cm-tsh-number',
  float: 'cm-tsh-number',
  boolean: 'cm-tsh-constant',
  constant: 'cm-tsh-constant',
  'variable.builtin': 'cm-tsh-constant',
  function: 'cm-tsh-function',
  'function.builtin': 'cm-tsh-constant',
  method: 'cm-tsh-function',
  constructor: 'cm-tsh-function',
  keyword: 'cm-tsh-keyword',
  conditional: 'cm-tsh-keyword',
  repeat: 'cm-tsh-keyword',
  type: 'cm-tsh-type',
  'type.builtin': 'cm-tsh-constant',
  namespace: 'cm-tsh-type',
  attribute: 'cm-tsh-attribute',
  tag: 'cm-tsh-tag',
  label: 'cm-tsh-label',
};`

	const newCaptureBlock = `const CAPTURE_CLASS: Readonly<Record<string, string>> = {
  comment: 'cm-tsh-comment',
  string: 'cm-tsh-string',
  character: 'cm-tsh-string',
  'string.escape': 'cm-tsh-escape',
  escape: 'cm-tsh-escape',
  number: 'cm-tsh-number',
  float: 'cm-tsh-number',
  boolean: 'cm-tsh-constant',
  constant: 'cm-tsh-constant',
  'variable.builtin': 'cm-tsh-constant',
  function: 'cm-tsh-function',
  'function.builtin': 'cm-tsh-constant',
  method: 'cm-tsh-function',
  constructor: 'cm-tsh-function',
  keyword: 'cm-tsh-keyword',
  conditional: 'cm-tsh-keyword',
  repeat: 'cm-tsh-keyword',
  type: 'cm-tsh-type',
  'type.builtin': 'cm-tsh-constant',
  namespace: 'cm-tsh-type',
  attribute: 'cm-tsh-attribute',
  tag: 'cm-tsh-tag',
  label: 'cm-tsh-label',
  // 字段/属性访问（如 rust 的 field_identifier、多语言的 @property）：与 entity 同色。
  property: 'cm-tsh-attribute',
  // Markdown（官方 highlights.scm 用旧版 nvim-treesitter 的 @text.* 体系）。
  'text.title': 'cm-tsh-heading',
  'text.literal': 'cm-tsh-code',
  'text.uri': 'cm-tsh-link',
  'text.reference': 'cm-tsh-link',
  'text.strong': 'cm-tsh-strong',
  'text.emphasis': 'cm-tsh-emphasis',
  // 同名新版 nvim-treesitter/Zed 的 @markup.* 体系，双路兼容未来切换的查询文件。
  'markup.heading': 'cm-tsh-heading',
  'markup.raw': 'cm-tsh-code',
  'markup.link.url': 'cm-tsh-link',
  'markup.link.label': 'cm-tsh-link',
  'markup.strong': 'cm-tsh-strong',
  'markup.italic': 'cm-tsh-emphasis',
  // Diff：新增/删除行是 diff 视图最核心的视觉信息，必须着色。
  'diff.plus': 'cm-tsh-diff-plus',
  'diff.minus': 'cm-tsh-diff-minus',
  'diff.delta': 'cm-tsh-diff-delta',
};`

	if (!content.includes(oldCaptureBlock)) {
		console.log("⚠️ 未找到 CAPTURE_CLASS 原始块（文件可能已被手动改过），跳过此项，请人工检查")
	} else {
		content = content.replace(oldCaptureBlock, newCaptureBlock)
		console.log("✅ CAPTURE_CLASS 已扩充（markdown/diff/property）")
	}

	const oldThemeTail = `  '.cm-tsh-tag': { color: '#22863a' },
  '.cm-tsh-label': { color: '#6f42c1' },
});`

	const newThemeTail = `  '.cm-tsh-tag': { color: '#22863a' },
  '.cm-tsh-label': { color: '#6f42c1' },
  '.cm-tsh-heading': { color: '#005cc5', fontWeight: '600' },
  '.cm-tsh-code': { color: '#032f62' },
  '.cm-tsh-link': { color: '#032f62', textDecoration: 'underline' },
  '.cm-tsh-strong': { fontWeight: '700' },
  '.cm-tsh-emphasis': { fontStyle: 'italic' },
  '.cm-tsh-diff-plus': { color: '#22863a', backgroundColor: 'rgba(34,134,58,0.08)' },
  '.cm-tsh-diff-minus': { color: '#d73a49', backgroundColor: 'rgba(215,58,73,0.08)' },
  '.cm-tsh-diff-delta': { color: '#6f42c1' },
});`

	if (!content.includes(oldThemeTail)) {
		console.log("⚠️ 未找到主题结尾块（文件可能已被手动改过），跳过此项，请人工检查")
	} else {
		content = content.replace(oldThemeTail, newThemeTail)
		console.log("✅ 主题颜色已扩充")
	}

	writeFileSync(HIGHLIGHT_TS, content, "utf8")
}

console.log("\n完成。重启 dev，测试 .md / .diff / .vue / .rs 文件。")
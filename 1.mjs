// 18-cleanup-final.mjs — 删除残留死代码 + 删除 bash 专属模块（注释引用不算真引用）
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"

const EDITOR_DIR = join(process.cwd(), "src/services/editor")

// ── 1) codemirror-language.ts：删除引用了已移除 StreamLanguage 的死代码块 ──
{
	const PATH = join(EDITOR_DIR, "codemirror-language.ts")
	let content = readFileSync(PATH, "utf8")
	const before = content
	// 用稳定的 ASCII 锚点做正则删除：从 "// StreamLanguage.define" 注释起，
	// 到 "new LanguageSupport(StreamLanguage.define(await loader()));" 行止（含该行）。
	content = content.replace(
		/\/\/ StreamLanguage\.define[\s\S]*?new LanguageSupport\(StreamLanguage\.define\(await loader\(\)\)\);\n\n?/,
		"",
	)
	if (content !== before) {
		writeFileSync(PATH, content, "utf8")
		console.log("✅ codemirror-language.ts: 已删除 streamLanguageLoader 死代码块")
	} else {
		console.log("❌ 未匹配到死代码块，请把 codemirror-language.ts 第 20-30 行发我")
	}
}

// ── 2) structural-selection.ts：清理指向已删文件的过期注释行 ──
{
	const PATH = join(EDITOR_DIR, "codemirror-structural-selection.ts")
	let content = readFileSync(PATH, "utf8")
	const before = content
	// 删除任何仍包含 "codemirror-bash-language" 的行（此时只剩注释行，import 已在上一步移除）。
	content = content
		.split("\n")
		.filter((line) => !line.includes("codemirror-bash-language"))
		.join("\n")
	if (content !== before) {
		writeFileSync(PATH, content, "utf8")
		console.log("✅ structural-selection.ts: 已清理过期注释引用")
	} else {
		console.log("（structural-selection.ts 无需清理）")
	}
}

// ── 3) bash-runtime.ts：清理注释里对已删文件的提及（纯注释，不影响功能）──
{
	const PATH = join(EDITOR_DIR, "tree-sitter/bash-runtime.ts")
	let content = readFileSync(PATH, "utf8")
	const before = content
	content = content.replace("(codemirror-bash-language)", "")
	if (content !== before) {
		writeFileSync(PATH, content, "utf8")
		console.log("✅ bash-runtime.ts: 已清理过期注释提及")
	} else {
		console.log("（bash-runtime.ts 无需清理）")
	}
}

// ── 4) 直接删除 bash 专属模块（已确认仅剩注释引用，现已清理）──
{
	for (const name of ["codemirror-bash-language.ts", "codemirror-bash-language.spec.ts"]) {
		const p = join(EDITOR_DIR, name)
		if (existsSync(p)) {
			rmSync(p)
			console.log(`✅ 已删除 ${name}`)
		} else {
			console.log(`（${name} 不存在，跳过）`)
		}
	}
}

console.log("\n完成。重启 dev server。若还有编译报错，把报错原文发我。")
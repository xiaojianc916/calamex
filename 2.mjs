// fix-ai-review-batch-6.mjs —— F1(memory.ts 孤儿注释头)+ F2(runtime-input.ts 悬空 @link)
// 在仓库根目录执行: node fix-ai-review-batch-6.mjs
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const eolOf = (s) => (s.includes("\r\n") ? "\r\n" : "\n")
let changed = 0, skipped = 0

function replaceBlock(rel, oldLines, newLines, label) {
	const path = join(ROOT, rel)
	const src = readFileSync(path, "utf8")
	const eol = eolOf(src)
	const oldStr = oldLines.join(eol)
	const newStr = newLines.join(eol)
	const n = src.split(oldStr).length - 1
	if (n === 0) {
		if (newStr !== "" && src.includes(newStr)) { console.log(`= 跳过(已应用): ${label}`); skipped++; return }
		console.log(`! 未找到锚点(已跳过，无副作用): ${label} @ ${rel}`); skipped++; return
	}
	if (n > 1) throw new Error(`锚点应唯一，实际 ${n} 次: ${label} @ ${rel}`)
	writeFileSync(path, src.replace(oldStr, newStr), "utf8")
	console.log(`✓ 应用: ${label}`); changed++
}

const DASH = "// " + "-".repeat(77)

// F1: 删除空的 “Env helpers” 注释头(残留空行交由 B3 的 pnpm format 折叠)
replaceBlock(
	"builtin-agent/src/engines/context/memory.ts",
	[DASH, "// Env helpers", DASH, ""],
	[],
	"F1 memory.ts: 删除孤儿 Env helpers 注释头",
)

// F2: 把悬空 @link 改为普通文本(planContinuation 字段尚不存在)
replaceBlock(
	"builtin-agent/src/engines/contracts/runtime-input.ts",
	[
		"     * Prefer the nested {@link IAgentRuntimeInput.planContinuation} shape",
		"     * once downstream consumers migrate.",
	],
	[
		"     * These may later move to a nested `planContinuation` shape once",
		"     * downstream consumers migrate.",
	],
	"F2 runtime-input.ts: 修正悬空 @link",
)

console.log(`\n完成: 应用 ${changed} 处, 跳过 ${skipped} 处`)
console.log("提醒: pnpm -C builtin-agent typecheck && pnpm -C builtin-agent test")
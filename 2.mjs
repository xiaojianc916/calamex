// fix-ai-review-batch-5.mjs
// 在仓库根目录(D:\com.xiaojianc\my_desktop_app)执行: node fix-ai-review-batch-5.mjs
// 幂等:可重复运行;已应用的条目会跳过。改动后请务必:
//   pnpm -C builtin-agent typecheck && pnpm -C builtin-agent test
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const eolOf = (s) => (s.includes("\r\n") ? "\r\n" : "\n")

let changed = 0
let skipped = 0

function replaceBlock(rel, oldLines, newLines, label) {
	const path = join(ROOT, rel)
	const src = readFileSync(path, "utf8")
	const eol = eolOf(src)
	const oldStr = oldLines.join(eol)
	const newStr = newLines.join(eol)
	const n = src.split(oldStr).length - 1
	if (n === 0) {
		if (src.includes(newStr)) {
			console.log(`= 跳过(已应用): ${label}`)
			skipped++
			return
		}
		throw new Error(`未找到锚点，源码可能已变动: ${label} @ ${rel}`)
	}
	if (n > 1) {
		throw new Error(`锚点应唯一，实际 ${n} 次: ${label} @ ${rel}`)
	}
	writeFileSync(path, src.replace(oldStr, newStr), "utf8")
	console.log(`✓ 应用: ${label}`)
	changed++
}

// ---- E1: 删除被 /\$\(/u 完全遮蔽的死正则 /\$\(\(/u ----
replaceBlock(
	"builtin-agent/src/engines/policy/command-safety.ts",
	["    /\\$\\(/u,", "    /\\$\\(\\(/u,"],
	["    /\\$\\(/u,"],
	"E1 command-safety: 移除死正则 /$((/",
)

// ---- E2: memo 化 compileRule,消除热路径重复 new RegExp ----
replaceBlock(
	"builtin-agent/src/engines/policy/tool-permission-policy.ts",
	[
		"const compileRule = (rule: IToolPermissionPatternRule): RegExp | null => {",
		"    try {",
		"        return new RegExp(rule.pattern, rule.caseSensitive ? 'u' : 'iu');",
		"    } catch {",
		"        return null;",
		"    }",
		"};",
	],
	[
		"const compiledRuleCache = new Map<string, RegExp | null>();",
		"",
		"const compileRule = (rule: IToolPermissionPatternRule): RegExp | null => {",
		"    const flags = rule.caseSensitive ? 'u' : 'iu';",
		"    const cacheKey = `${flags}:${rule.pattern}`;",
		"    const cached = compiledRuleCache.get(cacheKey);",
		"    if (cached !== undefined) {",
		"        return cached;",
		"    }",
		"    let compiled: RegExp | null;",
		"    try {",
		"        compiled = new RegExp(rule.pattern, flags);",
		"    } catch {",
		"        compiled = null;",
		"    }",
		"    compiledRuleCache.set(cacheKey, compiled);",
		"    return compiled;",
		"};",
	],
	"E2 tool-permission-policy: memo 化 compileRule",
)

// ---- E3: 修复 builtin-agent 坏脚本 fix(委托根,与 lint:ox 同风格) ----
replaceBlock(
	"builtin-agent/package.json",
	['    "fix": "pnpm format && pnpm fix:ox"'],
	['    "fix": "pnpm --dir .. fix"'],
	"E3 package.json: 修复坏 fix 脚本",
)

console.log(`\n完成: 应用 ${changed} 处, 跳过 ${skipped} 处`)
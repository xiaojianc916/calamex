#!/usr/bin/env node
// Stage 3b · 清理迁移后的死代码：删 model-config-options.ts 里的 MODEL_CATALOG_META_KEY /
// parseModelCatalogFromMeta（及其私有 helper isRecord/readString/parseEntry），并同步删测试。
// 用法：node 4.mjs --dry-run  看命中；  node 4.mjs  落盘
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const ROOT = process.cwd()
const DRY = process.argv.includes("--dry-run")
const L = (arr) => arr.join("\n")

// ── A: builtin-agent/src/acp/model-config-options.ts（TAB 缩进）──
const editsA = [
	{
		// A1·删 MODEL_CATALOG_META_KEY 常量 + 其文档（保留前后两行作锚）
		kind: "replace",
		label: "A1·删 MODEL_CATALOG_META_KEY 常量",
		find: L([
			'export const MODEL_CONFIG_OPTION_ID = "model"',
			"",
			"/** 宿主经 NewSessionRequest._meta 注入模型目录所用的命名空间键。 */",
			'export const MODEL_CATALOG_META_KEY = "calamex.dev/modelCatalog"',
			"",
			"/** 单个可选模型及其凭据（宿主从已保存 AI 配置组装，best-effort 仅含有 Key 者）。 */",
		]),
		replace: L([
			'export const MODEL_CONFIG_OPTION_ID = "model"',
			"",
			"/** 单个可选模型及其凭据（宿主从已保存 AI 配置组装，best-effort 仅含有 Key 者）。 */",
		]),
		alreadyIfAbsent: 'MODEL_CATALOG_META_KEY = "calamex.dev/modelCatalog"',
	},
	{
		// A2·删 isRecord/readString/parseEntry/parseModelCatalogFromMeta 整段（区间删除）
		kind: "cut",
		label: "A2·删 parseModelCatalogFromMeta 及其私有 helper",
		from: "const isRecord = (value: unknown): value is Record<string, unknown> =>",
		to: "\treturn catalog\n}",
		alreadyIfAbsent: "export const parseModelCatalogFromMeta",
	},
]

// ── B: builtin-agent/src/acp/model-config-options.spec.ts（TAB 缩进）──
const editsB = [
	{
		// B1·import 去掉 MODEL_CATALOG_META_KEY / parseModelCatalogFromMeta
		kind: "replace",
		label: "B1·清理测试 import",
		find: L([
			"import {",
			"\tbuildModelConfigOptions,",
			"\tMODEL_CATALOG_META_KEY,",
			"\tMODEL_CONFIG_OPTION_ID,",
			"\tparseModelCatalogFromMeta,",
			"\tresolveCurrentModelId,",
			"\tresolveModelConfigInput,",
			'} from "./model-config-options.js"',
		]),
		replace: L([
			"import {",
			"\tbuildModelConfigOptions,",
			"\tMODEL_CONFIG_OPTION_ID,",
			"\tresolveCurrentModelId,",
			"\tresolveModelConfigInput,",
			'} from "./model-config-options.js"',
		]),
		alreadyIfAbsent: "\tparseModelCatalogFromMeta,",
	},
	{
		// B2·删 meta() helper + 整个 parseModelCatalogFromMeta describe 块（区间删除，保留下一个 describe）
		kind: "cut",
		label: "B2·删 parseModelCatalogFromMeta 测试块",
		from: "const meta = (catalog: unknown): Record<string, unknown> => ({",
		to: "\t\texpect(result?.currentModelId).toBeUndefined()\n\t})\n})",
		alreadyIfAbsent: 'describe("parseModelCatalogFromMeta"',
	},
]

const FILES = [
	{ rel: "builtin-agent/src/acp/model-config-options.ts", edits: editsA },
	{ rel: "builtin-agent/src/acp/model-config-options.spec.ts", edits: editsB },
]

// 单次唯一定位：返回 index，或 "MISSING" / "AMBIGUOUS"
function locate(text, needle) {
	const first = text.indexOf(needle)
	if (first === -1) return "MISSING"
	if (text.indexOf(needle, first + needle.length) !== -1) return "AMBIGUOUS"
	return first
}

function applyFile({ rel, edits }) {
	const abs = path.join(ROOT, rel)
	if (!fs.existsSync(abs)) {
		console.log(`\n✗ 找不到文件（跳过）：${rel}`)
		return
	}
	const original = fs.readFileSync(abs, "utf8")
	const crlf = original.includes("\r\n")
	let working = original.replace(/\r\n/g, "\n")

	const report = []
	let missing = 0
	let changed = 0

	for (const e of edits) {
		if (e.alreadyIfAbsent && !working.includes(e.alreadyIfAbsent)) {
			report.push(`  ✓ 已应用（跳过）：${e.label}`)
			continue
		}
		if (e.kind === "replace") {
			const at = locate(working, e.find)
			if (at === "MISSING") {
				report.push(`  ❗ 锚点未命中（本地与 HEAD 有出入）：${e.label}`)
				missing++
				continue
			}
			if (at === "AMBIGUOUS") {
				report.push(`  ❗ 锚点不唯一（拒绝改）：${e.label}`)
				missing++
				continue
			}
			working = working.slice(0, at) + e.replace + working.slice(at + e.find.length)
			report.push(`  ✎ 待改：${e.label}`)
			changed++
		} else if (e.kind === "cut") {
			const start = locate(working, e.from)
			const end = locate(working, e.to)
			if (start === "MISSING" || end === "MISSING") {
				report.push(`  ❗ 区间锚点未命中（本地与 HEAD 有出入）：${e.label}`)
				missing++
				continue
			}
			if (start === "AMBIGUOUS" || end === "AMBIGUOUS") {
				report.push(`  ❗ 区间锚点不唯一（拒绝改）：${e.label}`)
				missing++
				continue
			}
			const endPos = end + e.to.length
			if (endPos <= start) {
				report.push(`  ❗ 区间方向异常（拒绝改）：${e.label}`)
				missing++
				continue
			}
			working = working.slice(0, start) + working.slice(endPos)
			report.push(`  ✎ 待删（区间）：${e.label}`)
			changed++
		}
	}

	// 收尾：把删除接缝处 3+ 连续换行收敛为 1 个空行（与 biome 格式一致）
	if (changed > 0) working = working.replace(/\n{3,}/g, "\n\n")

	console.log(`\n✎ ${rel}`)
	report.forEach((r) => console.log(r))

	if (missing > 0) {
		console.log(`  → 有 ${missing} 条未命中：整文件不写（事务回滚），请核对后重跑。`)
		return
	}
	if (changed === 0) {
		console.log("  → 无需改动（已是最新）。")
		return
	}
	if (DRY) {
		console.log(`  → [dry-run] 命中 ${changed} 条，未落盘。`)
		return
	}
	fs.writeFileSync(abs, crlf ? working.replace(/\n/g, "\r\n") : working, "utf8")
	console.log(`  → 已写入（${changed} 条，${crlf ? "CRLF" : "LF"} 保持）。`)
}

console.log(`Stage 3b · 死代码清理${DRY ? "（dry-run）" : ""}`)
console.log(`repo root: ${ROOT}`)
for (const f of FILES) applyFile(f)
console.log("\n── 验证门 ──")
console.log("pnpm lint --fix && pnpm typecheck && pnpm test")
console.log("pnpm dlx knip@6.23.0   # 确认无新增未用导出")
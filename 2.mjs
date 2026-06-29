// p7-runtime-parity.mjs  （EOL 健壮版：LF/CRLF 通吃）
// 用法：仓库根 D:\com.xiaojianc\my_desktop_app 下 `node 2.mjs`
// 作用：P7（A 方向）—— 内置边车 runtime.ts 从“多运行时选择脚手架”收敛为单引擎契约。
// 无备份文件；改完自检残引用；成功后可删本脚本。
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const RUNTIME = join(ROOT, "builtin-agent/src/engines/runtime/runtime.ts")
const ENTRY = join(ROOT, "builtin-agent/src/acp/stdio-entry.ts")

/** 读文件并归一为 LF；记录原行尾，便于写回时还原（不制造全文件 EOL 噪声）。 */
function readLF(path) {
	const raw = readFileSync(path, "utf8")
	return { lf: raw.replace(/\r\n/g, "\n"), crlf: /\r\n/.test(raw) }
}
/** 按原行尾约定写回。 */
function writeEOL(path, lf, crlf) {
	writeFileSync(path, crlf ? lf.replace(/\n/g, "\r\n") : lf, "utf8")
}
/** 精确一次替换：命中数必须恰为 1，否则抛错（拒绝模糊匹配）。 */
function replaceOnce(src, oldStr, newStr, label) {
	const parts = src.split(oldStr)
	if (parts.length !== 2) {
		throw new Error(`[${label}] 期望恰好 1 处匹配，实际 ${parts.length - 1} 处。已中止，未写入。`)
	}
	return parts.join(newStr)
}

// ── 1) runtime.ts ────────────────────────────────────────────────────────────
let { lf: rt, crlf: rtCrlf } = readLF(RUNTIME)

// 1a. 移除不再使用的具体实现 import（契约模块不应依赖实现）。
rt = replaceOnce(rt, `import { MastraRuntime } from './composition.js';\n`, ``, "runtime:import")

// 1b. 删除多运行时名单 / 默认运行时 / 名称联合（死配置）。
rt = replaceOnce(
	rt,
	`export const SUPPORTED_AGENT_RUNTIMES = ['mastra'] as const;\n` +
		`\n` +
		`export type TAgentRuntimeName = (typeof SUPPORTED_AGENT_RUNTIMES)[number];\n` +
		`\n` +
		`export const DEFAULT_AGENT_RUNTIME: TAgentRuntimeName = 'mastra';\n` +
		`\n`,
	``,
	"runtime:constants",
)

// 1c. 接口文档：从“多运行时”改为诚实的“内置边车唯一进程内引擎契约”。
rt = replaceOnce(
	rt,
	`/**\n * Surface implemented by every concrete agent runtime (Mastra today, others later).\n *\n`,
	`/**\n` +
		` * 内置边车（builtin-agent）唯一的进程内引擎契约：当前仅由 Mastra 实现。\n` +
		` *\n` +
		` * Kimi / Codex 等对等编码 agent 是宿主侧独立的 ACP 子进程，经 src-tauri 的\n` +
		` * AcpBackendId + provisioner 注册表对等挂载，不实现本进程内契约；多 agent 的统一\n` +
		` * 面在 ACP 协议层与宿主注册表，而非此接口。\n` +
		` *\n`,
	"runtime:iface-doc",
)

// 1d. name 字段类型：联合 → string（边车只有一个引擎，名称无需受限联合）。
rt = replaceOnce(rt, `    readonly name: TAgentRuntimeName;`, `    readonly name: string;`, "runtime:name-type")

// 1e. 截断尾部整段 “Configuration & factory”（env/switch/factory 全删），收敛为纯契约模块。
const FACTORY_MARKER =
	`// -----------------------------------------------------------------------------\n` +
	`// Configuration & factory\n` +
	`// -----------------------------------------------------------------------------`
{
	const idx = rt.indexOf(FACTORY_MARKER)
	if (idx === -1 || rt.indexOf(FACTORY_MARKER, idx + 1) !== -1) {
		throw new Error("[runtime:factory] 未唯一定位 Configuration & factory 区块。已中止，未写入。")
	}
	rt = rt.slice(0, idx).replace(/\s+$/, "") + "\n"
}

writeEOL(RUNTIME, rt, rtCrlf)
console.log(`✓ runtime.ts 已收敛为纯契约模块（${rtCrlf ? "CRLF" : "LF"}）`)

// ── 2) stdio-entry.ts ─────────────────────────────────────────────────────────
let { lf: entry, crlf: entryCrlf } = readLF(ENTRY)
entry = replaceOnce(
	entry,
	`import { createConfiguredRuntime } from "../engines/runtime/runtime.js"`,
	`import { MastraRuntime } from "../engines/runtime/composition.js"`,
	"entry:import",
)
entry = replaceOnce(entry, `const runtime = createConfiguredRuntime()`, `const runtime = new MastraRuntime()`, "entry:construct")
writeEOL(ENTRY, entry, entryCrlf)
console.log(`✓ stdio-entry.ts 组合根已直连 MastraRuntime（${entryCrlf ? "CRLF" : "LF"}）`)

// ── 3) 残引用自检（不靠经验，靠扫描） ─────────────────────────────────────────
const REMOVED = [
	"SUPPORTED_AGENT_RUNTIMES",
	"TAgentRuntimeName",
	"DEFAULT_AGENT_RUNTIME",
	"resolveConfiguredRuntimeName",
	"ICreateRuntimeOptions",
	"createConfiguredRuntime",
]
const SRC = join(ROOT, "builtin-agent/src")
const hits = []
;(function walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		const st = statSync(p)
		if (st.isDirectory()) walk(p)
		else if (name.endsWith(".ts")) {
			const lines = readFileSync(p, "utf8").replace(/\r\n/g, "\n").split("\n")
			lines.forEach((line, i) => {
				for (const id of REMOVED) {
					if (line.includes(id)) hits.push(`${p}:${i + 1}: ${line.trim()}`)
				}
			})
		}
	}
})(SRC)

if (hits.length) {
	console.log("\n⚠ 仍存在对已删符号的引用，请处理后再 typecheck：")
	for (const h of hits) console.log("  " + h)
	process.exitCode = 1
} else {
	console.log("\n✓ 残引用扫描通过：builtin-agent/src 内无对已删符号的引用")
	console.log("下一步：pnpm -C builtin-agent typecheck && pnpm -C builtin-agent test && pnpm lint")
}
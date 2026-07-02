#!/usr/bin/env node
// @ts-check
/**
 * builtin 凭据 Zed 化脚手架（安全/幂等/CRLF 感知）。
 *
 * 只做「安全可脚本化」的部分：
 *   Stage 2：新建 builtin-agent/src/acp/model-catalog-env.ts + 单测（幂等；已存在且内容不同则拒写）。
 * 其余（Stage 1/3/4/5/6/7）是语义改动 —— 本脚本不盲目正则改 Rust/TS，
 * 只做「只读扫描」，报告残留符号与下一步人工操作，交给 cargo/tsc 编译器兜底。
 *
 * 退出码：0 = 一切就绪或已应用；非 0 = 有冲突需人工介入（拒写时）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const ROOT = process.cwd()
const rel = (p) => join(ROOT, p)

/** 仓库根校验：必须能看到两个工程锚点，避免在错误目录误写。 */
function assertRepoRoot() {
	const anchors = ["src-tauri/Cargo.toml", "builtin-agent/package.json"]
	const missing = anchors.filter((a) => !existsSync(rel(a)))
	if (missing.length > 0) {
		console.error(
			`❗ 不在 calamex 仓库根目录（缺少 ${missing.join(", ")}）。请在仓库根运行，已安全退出。`,
		)
		process.exit(2)
	}
}

/** 幂等写文件：不存在→写；已存在且内容一致→跳过；已存在且不同→拒写（安全）。 */
function writeGuarded(relPath, content) {
	const abs = rel(relPath)
	if (existsSync(abs)) {
		const current = readFileSync(abs, "utf8")
		if (current === content) {
			console.log(`✓ 已是最新，跳过：${relPath}`)
			return "unchanged"
		}
		console.error(
			`❗ 目标已存在且内容不同，拒绝覆盖：${relPath}\n   如确认要替换，请先手动删除或备份该文件后重跑。`,
		)
		return "conflict"
	}
	mkdirSync(dirname(abs), { recursive: true })
	writeFileSync(abs, content, "utf8")
	console.log(`＋ 已创建：${relPath}`)
	return "created"
}

// ── Stage 2：新模块（LF 行尾，与 builtin-agent TS 源一致）───────────────
const MODEL_CATALOG_ENV_TS = `import type { IAcpModelCatalog, IAcpModelCatalogEntry } from "./model-config-options.js"

const MODEL_IDS_ENV = "CALAMEX_AI_MODEL_IDS"
const CURRENT_MODEL_ID_ENV = "CALAMEX_AI_CURRENT_MODEL_ID"

const providerOf = (modelId: string): string | undefined => {
	const [provider] = modelId.split("/")
	const trimmed = provider?.trim()
	return trimmed ? trimmed.toUpperCase() : undefined
}

/**
 * 自省进程环境变量拼出模型目录（Zed 范式：凭据走 env、宿主启动时注入）。
 * 遍历 CALAMEX_AI_MODEL_IDS，对每个 modelId 取厂商前缀查 CALAMEX_AI_KEY__<PROVIDER>，
 * 有 key 才纳入（即「有哪家 key 就声明哪家模型」）。无任何可用模型时返回 undefined。
 */
export const buildModelCatalogFromEnv = (
	env: NodeJS.ProcessEnv = process.env,
): IAcpModelCatalog | undefined => {
	const raw = env[MODEL_IDS_ENV]?.trim()
	if (!raw) return undefined
	const models: IAcpModelCatalogEntry[] = []
	for (const item of raw.split(",")) {
		const modelId = item.trim()
		if (!modelId) continue
		const provider = providerOf(modelId)
		if (!provider) continue
		const apiKey = env[\`CALAMEX_AI_KEY__\${provider}\`]?.trim()
		if (!apiKey) continue
		const baseUrl = env[\`CALAMEX_AI_BASE_URL__\${provider}\`]?.trim()
		models.push(baseUrl ? { modelId, apiKey, baseUrl } : { modelId, apiKey })
	}
	if (models.length === 0) return undefined
	const currentModelId = env[CURRENT_MODEL_ID_ENV]?.trim()
	return currentModelId ? { models, currentModelId } : { models }
}
`

const MODEL_CATALOG_ENV_TEST_TS = `import { describe, expect, it } from "vitest"

import { buildModelCatalogFromEnv } from "./model-catalog-env.js"

describe("buildModelCatalogFromEnv", () => {
	it("无 CALAMEX_AI_MODEL_IDS 时返回 undefined", () => {
		expect(buildModelCatalogFromEnv({})).toBeUndefined()
	})

	it("仅纳入有对应厂商 key 的模型", () => {
		const catalog = buildModelCatalogFromEnv({
			CALAMEX_AI_MODEL_IDS: "deepseek/deepseek-v4-pro,zhipuai/glm-4.7-flash",
			CALAMEX_AI_KEY__DEEPSEEK: "sk-deepseek",
			// 故意不给 zhipuai key → 应被过滤掉
			CALAMEX_AI_CURRENT_MODEL_ID: "deepseek/deepseek-v4-pro",
		})
		expect(catalog).toEqual({
			models: [{ modelId: "deepseek/deepseek-v4-pro", apiKey: "sk-deepseek" }],
			currentModelId: "deepseek/deepseek-v4-pro",
		})
	})

	it("同厂商多模型共享一把 key，且带上 base_url", () => {
		const catalog = buildModelCatalogFromEnv({
			CALAMEX_AI_MODEL_IDS: "deepseek/deepseek-v4-pro,deepseek/deepseek-r2",
			CALAMEX_AI_KEY__DEEPSEEK: "sk-deepseek",
			CALAMEX_AI_BASE_URL__DEEPSEEK: "https://api.deepseek.com/v1",
		})
		expect(catalog).toEqual({
			models: [
				{ modelId: "deepseek/deepseek-v4-pro", apiKey: "sk-deepseek", baseUrl: "https://api.deepseek.com/v1" },
				{ modelId: "deepseek/deepseek-r2", apiKey: "sk-deepseek", baseUrl: "https://api.deepseek.com/v1" },
			],
		})
	})

	it("清单里所有模型都无 key 时返回 undefined", () => {
		expect(
			buildModelCatalogFromEnv({ CALAMEX_AI_MODEL_IDS: "deepseek/x,zhipuai/y" }),
		).toBeUndefined()
	})

	it("忽略缺厂商前缀 / 空白项", () => {
		const catalog = buildModelCatalogFromEnv({
			CALAMEX_AI_MODEL_IDS: " , no-prefix , deepseek/deepseek-v4-pro ",
			CALAMEX_AI_KEY__DEEPSEEK: "sk-deepseek",
		})
		expect(catalog).toEqual({
			models: [{ modelId: "deepseek/deepseek-v4-pro", apiKey: "sk-deepseek" }],
		})
	})
})
`

// ── 只读扫描：报告残留符号（供人工按 diff 逐阶段收尾）────────────────────
/** @param {string} relPath @param {{label:string, needle:RegExp, want:"present"|"absent"}[]} checks */
function scan(relPath, checks) {
	const abs = rel(relPath)
	if (!existsSync(abs)) {
		console.log(`   · ${relPath}：文件不存在，跳过`)
		return
	}
	const text = readFileSync(abs, "utf8")
	for (const { label, needle, want } of checks) {
		const found = needle.test(text)
		const ok = want === "present" ? found : !found
		const mark = ok ? "✓" : "▲"
		const state = found ? "存在" : "缺失"
		console.log(`   ${mark} [${relPath}] ${label}：${state}`)
	}
}

function main() {
	assertRepoRoot()

	console.log("\n== Stage 2：写入 sidecar 新模块（安全/幂等）==")
	const r1 = writeGuarded("builtin-agent/src/acp/model-catalog-env.ts", MODEL_CATALOG_ENV_TS)
	const r2 = writeGuarded("builtin-agent/src/acp/model-catalog-env.test.ts", MODEL_CATALOG_ENV_TEST_TS)

	console.log("\n== 只读扫描：以下为需人工按 diff 收尾的语义改动（不盲改）==")
	scan("src-tauri/src/acp/launch.rs", [
		{ label: "Stage 1 env 注入(CALAMEX_AI_MODEL_IDS)", needle: /CALAMEX_AI_MODEL_IDS/, want: "present" },
	])
	scan("builtin-agent/src/acp/agent.ts", [
		{ label: "Stage 3 应删除 parseModelCatalogFromMeta 引用", needle: /parseModelCatalogFromMeta/, want: "absent" },
		{ label: "Stage 3 应改用 buildModelCatalogFromEnv", needle: /buildModelCatalogFromEnv/, want: "present" },
	])
	scan("src-tauri/src/commands/builtin_agent.rs", [
		{ label: "Stage 4 应删除 builtin_model_catalog_meta", needle: /builtin_model_catalog_meta/, want: "absent" },
	])
	scan("src-tauri/src/acp/host.rs", [
		{ label: "Stage 5 检查残留 modelCatalog/_meta 消费", needle: /modelCatalog|"calamex\.dev\/modelCatalog"/, want: "absent" },
	])
	scan("builtin-agent/src/models/config.ts", [
		{ label: "Stage 6 应删除 BUILTIN_AGENT_API_KEY", needle: /BUILTIN_AGENT_API_KEY/, want: "absent" },
		{ label: "Stage 6 应删除 createMastraModelConfigFromEnv", needle: /createMastraModelConfigFromEnv/, want: "absent" },
	])
	scan("builtin-agent/src/acp/stdio-entry.ts", [
		{ label: "Stage 6 前置：预热是否仍调 createMastraModelConfigFromEnv", needle: /createMastraModelConfigFromEnv/, want: "absent" },
	])

	console.log("\n== 下一步（人工，按 Notion 方案逐阶段套 diff）==")
	console.log("  1) Stage 1  launch.rs         注入 env（镜像 TAVILY_API_KEY）")
	console.log("  2) Stage 3  agent.ts          改用 this.envModelCatalog")
	console.log("  3) Stage 4  builtin_agent.rs  删 _meta 组装 + 3 个单测")
	console.log("  4) Stage 5  host.rs           收口 ensure_session 的 meta 形参")
	console.log("  5) Stage 6  config.ts         删单 key 兜底（先核对 stdio-entry 预热）")
	console.log("  6) Stage 7  设置层            存 key/改模型后重启边车（复用 builtin_agent_restart）")
	console.log("  7) 验证门   cargo clippy -- -D warnings && cargo test ；pnpm lint && pnpm typecheck && pnpm test")

	if (r1 === "conflict" || r2 === "conflict") {
		console.error("\n❗ 有文件冲突未写入，请处理后重跑。")
		process.exit(1)
	}
	console.log("\n✅ 脚手架完成（语义改动请按上表人工收尾，编译器兜底）。")
}

main()
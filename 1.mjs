#!/usr/bin/env node
// patch8.mjs — ADR-0015 收尾：Builtin sidecar 主链路统一走 credential::resolve（单一事实源）
// 幂等：每处编辑「待改签名在 → 改；已应用 → 跳过；都不在 → 报错中止」。
// 用法：在仓库根目录执行 `node patch8.mjs`，随后到 src-tauri/ 跑 cargo。
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = process.cwd()

/** 单处幂等编辑。 */
function applyEdit(content, edit) {
	const { old, neu, label } = edit
	const pending = edit.pending ?? old
	if (content.includes(pending)) {
		const count = content.split(old).length - 1
		if (count !== 1) {
			throw new Error(`${label}: 期望唯一匹配 old，实际 ${count} 处，已中止（文件版本不符）。`)
		}
		console.log(`  ✓ 应用: ${label}`)
		return content.replace(old, neu)
	}
	if (edit.applied && content.includes(edit.applied)) {
		console.log(`  • 跳过(已应用): ${label}`)
		return content
	}
	if (!edit.applied) {
		console.log(`  • 跳过(目标签名不存在，视为已应用): ${label}`)
		return content
	}
	throw new Error(`${label}: 既无待改签名也无已应用标记，文件与预期版本不一致，已中止。`)
}

/** 读取→规整 EOL→顺序应用→还原 EOL→按需写回。 */
function processFile(relPath, edits) {
	const abs = join(repoRoot, relPath)
	const raw = readFileSync(abs, "utf8")
	const usedCrlf = raw.includes("\r\n")
	let content = usedCrlf ? raw.replace(/\r\n/g, "\n") : raw
	const before = content
	console.log(`\n▶ ${relPath}`)
	for (const edit of edits) content = applyEdit(content, edit)
	if (content === before) {
		console.log(`  （无变化）`)
		return
	}
	const out = usedCrlf ? content.replace(/\n/g, "\r\n") : content
	writeFileSync(abs, out, "utf8")
	console.log(`  ✔ 已写回`)
}

// ───────────────────────── credential/mod.rs ─────────────────────────
const credentialEdits = [
	{
		label: "1a 端点解析器并入尾斜杠归一",
		applied: ".map(|value| value.trim_end_matches('/').to_string())",
		old: `/// 端点解析纯函数：调用方显式传入优先（trim 后非空），否则回退到唯一权威表
/// default_provider_base_url。抽成纯函数以便脱离 keyring 做单元测试。
pub fn resolve_provider_base_url(
    provider_id: &str,
    explicit_base_url: Option<&str>,
) -> Option<String> {
    explicit_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| default_provider_base_url(provider_id.trim()).map(ToOwned::to_owned))
}`,
		neu: `/// 端点解析纯函数：调用方显式传入优先（trim 后非空，并裁掉尾部 \`/\`），否则回退到唯一
/// 权威表 default_provider_base_url。抽成纯函数以便脱离 keyring 做单元测试。
///
/// 尾斜杠归一化收敛在此：此前主链路 sidecar 侧自带一份 resolve_sidecar_base_url 仅为裁掉
/// 尾部 \`/\` 而与本函数双写，现已并入这里，确保 builtin 与外部 agent 共用同一套端点归一规则。
pub fn resolve_provider_base_url(
    provider_id: &str,
    explicit_base_url: Option<&str>,
) -> Option<String> {
    explicit_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('/').to_string())
        .or_else(|| default_provider_base_url(provider_id.trim()).map(ToOwned::to_owned))
}`,
	},
	{
		label: "1b resolve() 摘除 allow(dead_code)",
		applied: "即以此为唯一入口取 key+端点。",
		old: `    /// 的结构化错误码）+ 端点按 resolve_provider_base_url 回退。
    /// 下一步 provisioner 接线后即被消费，届时移除 allow(dead_code)。
    #[allow(dead_code)]
    pub fn resolve(`,
		neu: `    /// 的结构化错误码）+ 端点按 resolve_provider_base_url 回退。
    /// 主链路 sidecar 模型配置（ai::gateway::model_config）即以此为唯一入口取 key+端点。
    pub fn resolve(`,
	},
	{
		label: "1c 新增尾斜杠断言",
		applied: `resolve_provider_base_url("zhipuai", Some("https://gw.example/v1/"))`,
		old: `        assert_eq!(
            resolve_provider_base_url("deepseek", Some("  https://proxy.example/v1  ")),
            Some("https://proxy.example/v1".to_string())
        );
        assert_eq!(
            resolve_provider_base_url("deepseek", Some("   ")),`,
		neu: `        assert_eq!(
            resolve_provider_base_url("deepseek", Some("  https://proxy.example/v1  ")),
            Some("https://proxy.example/v1".to_string())
        );
        assert_eq!(
            resolve_provider_base_url("zhipuai", Some("https://gw.example/v1/")),
            Some("https://gw.example/v1".to_string())
        );
        assert_eq!(
            resolve_provider_base_url("deepseek", Some("   ")),`,
	},
]

// ───────────────────────── gateway/model_config.rs ─────────────────────────
const modelConfigEdits = [
	{
		label: "2a 精简 import",
		applied: "use crate::ai::credential::CredentialStore;",
		old: `use crate::ai::credential::{default_provider_base_url, CredentialStore};`,
		neu: `use crate::ai::credential::CredentialStore;`,
	},
	{
		label: "2b sidecar 配置改调 CredentialStore::resolve",
		applied: "let resolved = CredentialStore::resolve(provider_id, base_url)?;",
		old: `    let provider_id = model_provider_id(model_id)?;
    let api_key = CredentialStore::get(provider_id)?;
    let base_url = resolve_sidecar_base_url(provider_id, base_url);

    Ok(AgentSidecarModelConfigPayload {
        model_id: model_id.to_string(),
        api_key: api_key.into(),
        base_url,
    })`,
		neu: `    let provider_id = model_provider_id(model_id)?;
    let resolved = CredentialStore::resolve(provider_id, base_url)?;

    Ok(AgentSidecarModelConfigPayload {
        model_id: model_id.to_string(),
        api_key: resolved.api_key.into(),
        base_url: resolved.base_url,
    })`,
	},
	{
		label: "2c 删除本地 resolve_sidecar_base_url",
		pending: "fn resolve_sidecar_base_url(",
		old: `/// 解析下发给 sidecar 的 base_url：优先用户在 AI 设置里显式保存的网关地址，缺失（None /
/// 空白）时按厂商回退官方 OpenAI 兼容端点（单一事实源见
/// [\`crate::ai::credential::default_provider_base_url\`]）。
///
/// 此前主链路缺 base_url 时直接下发 None，依赖 sidecar 内 Mastra 的 provider 注册表解析
/// 端点——但注册表并不收录全部受支持厂商（如 zhipuai/GLM），导致请求无端点、上游 401
/// → sidecar 归类 \`AI_PROVIDER_AUTH_FAILED\` → \`runtime.chat\` 报错 → agent/chat 抛错 →
/// 宿主显示「acp protocol error: Authentication required」。DeepSeek 因有手写网关恒有默认
/// 端点，故此前唯独 DeepSeek 可用、其余厂商踩坑。该回退与 Kimi 凭证预置
/// （\`acp::launch::collect_kimi_model_entry\`）同源同策。
fn resolve_sidecar_base_url(provider_id: &str, base_url: Option<&str>) -> Option<String> {
    base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('/').to_string())
        .or_else(|| default_provider_base_url(provider_id).map(ToOwned::to_owned))
}

/// 把已配置的 selected_model / base_url 组装成 sidecar 模型配置。`,
		neu: `/// 把已配置的 selected_model / base_url 组装成 sidecar 模型配置。`,
	},
	{
		label: "2d-i 收敛 test import",
		applied: "    use super::model_provider_id;",
		old: `    use super::{model_provider_id, resolve_sidecar_base_url};`,
		neu: `    use super::model_provider_id;`,
	},
	{
		label: "2d-ii 移除已迁移的 base_url 单测",
		pending: `resolve_sidecar_base_url("mystery", None)`,
		old: `        assert!(model_provider_id("no-prefix").is_err());
    }

    #[test]
    fn resolve_base_url_prefers_explicit_override_and_trims_trailing_slash() {
        assert_eq!(
            resolve_sidecar_base_url("zhipuai", Some("https://gw.example/v1/")).as_deref(),
            Some("https://gw.example/v1")
        );
    }

    #[test]
    fn resolve_base_url_falls_back_to_provider_default_when_empty() {
        // 修复关键路径：用户未手填 Provider 地址（None / 空白）时按厂商回退默认端点，
        // 而非下发 None 让 sidecar 失去端点 → 401 → Authentication required。
        assert_eq!(
            resolve_sidecar_base_url("zhipuai", None).as_deref(),
            Some("https://open.bigmodel.cn/api/paas/v4")
        );
        assert_eq!(
            resolve_sidecar_base_url("zhipuai", Some("   ")).as_deref(),
            Some("https://open.bigmodel.cn/api/paas/v4")
        );
        assert_eq!(
            resolve_sidecar_base_url("deepseek", None).as_deref(),
            Some("https://api.deepseek.com/v1")
        );
    }

    #[test]
    fn resolve_base_url_none_for_unknown_provider_without_override() {
        assert_eq!(resolve_sidecar_base_url("mystery", None), None);
    }
}`,
		neu: `        assert!(model_provider_id("no-prefix").is_err());
    }
}`,
	},
]

try {
	processFile("src-tauri/src/ai/credential/mod.rs", credentialEdits)
	processFile("src-tauri/src/ai/gateway/model_config.rs", modelConfigEdits)
	console.log("\n✅ patch8 完成。请在 src-tauri/ 下执行：cargo clippy --all-targets && cargo test")
} catch (err) {
	console.error(`\n❌ patch8 失败：${err.message}`)
	process.exitCode = 1
}
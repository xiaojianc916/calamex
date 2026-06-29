#!/usr/bin/env node
/**
 * b4-s2-host-model-catalog-meta.mjs
 *
 * B4 / S2 —— 宿主侧 session/new 的 _meta 模型目录注入（仅 builtin 后端）。
 *
 * 背景：官方 session/set_config_option 仅携带被选中的 modelId、不含凭据；而 launch 层有意
 * 不向 ACP 子进程注入模型 env。故 builtin 边车需在「建会话」时一次性拿到「用户全部可用模型
 * + 凭据 + 当前选中项」，据此公示官方 config_options 模型选择器（与 Kimi 同构），并在后续
 * set_config_option 切换时按 modelId 命中已下发的凭据。该目录经 ACP 标准 NewSessionRequest._meta
 * 通道下发（与 S1 边车侧 parseModelCatalogFromMeta 对接）。
 *
 * 改动（唯一标准管线，注入在目标 prompt 通路 builtin_agent_external_chat，仅 backend==Builtin）：
 *   1) acp/client.rs   —— Command::NewSession / new_session / 连接循环 arm 新增 meta 形参，
 *                          经官方 builder NewSessionRequest::new(cwd).meta(map) 注入（+集成测试）。
 *   2) acp/host.rs     —— ensure_session 新增 meta 形参并透传给 new_session；prompt 复用回合传 None。
 *   3) commands/builtin_agent.rs —— 新增 builtin_model_catalog_meta(_from) 组装目录；external_chat
 *                          按 backend 注入；旧带外三命令的 ensure_session 补 None（D1 删除前的过渡）。
 *
 * 不提交。请从仓库根目录运行：node scripts/refactor/b4-s2-host-model-catalog-meta.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

function read(rel) {
  const abs = resolve(ROOT, rel);
  const raw = readFileSync(abs, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const text = eol === "\r\n" ? raw.split("\r\n").join("\n") : raw;
  return { rel, abs, text, eol };
}

function write(file, text) {
  const out = file.eol === "\r\n" ? text.split("\n").join("\r\n") : text;
  writeFileSync(file.abs, out, "utf8");
}

function replaceOnce(text, oldStr, newStr, label) {
  const first = text.indexOf(oldStr);
  if (first === -1) throw new Error("[" + label + "] 锚点未找到");
  if (text.indexOf(oldStr, first + oldStr.length) !== -1)
    throw new Error("[" + label + "] 锚点命中多于一次（需唯一）");
  return text.slice(0, first) + newStr + text.slice(first + oldStr.length);
}

function replaceExactly(text, oldStr, newStr, count, label) {
  const parts = text.split(oldStr);
  const found = parts.length - 1;
  if (found !== count)
    throw new Error("[" + label + "] 期望命中 " + count + " 次，实际 " + found + " 次");
  return parts.join(newStr);
}

// ----------------------------------------------------------------------------
// 1) src-tauri/src/acp/client.rs
// ----------------------------------------------------------------------------
const client = read("src-tauri/src/acp/client.rs");

// C1: Command::NewSession 变体新增 meta 字段
client.text = replaceOnce(
  client.text,
`    NewSession {
        cwd: PathBuf,
        reply: oneshot::Sender<Result<NewSessionOutcome, String>>,
    },`,
`    NewSession {
        cwd: PathBuf,
        /// 仅 builtin 后端注入的 session/new _meta（模型目录 + 凭据 + 当前选中项，由命令层
        /// 组装）；外部 agent 为 None。经官方 builder 注入 NewSessionRequest（Meta =
        /// serde_json::Map<String, Value>，序列化为线上键 _meta）。
        meta: Option<serde_json::Map<String, Value>>,
        reply: oneshot::Sender<Result<NewSessionOutcome, String>>,
    },`,
  "client.rs Command::NewSession",
);

// C2: AcpClientHandle::new_session 新增 meta 形参
client.text = replaceOnce(
  client.text,
`    pub async fn new_session(&self, cwd: PathBuf) -> Result<NewSessionOutcome, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::NewSession { cwd, reply })
            .map_err(|_| AcpClientError::NotRunning)?;`,
`    pub async fn new_session(
        &self,
        cwd: PathBuf,
        meta: Option<serde_json::Map<String, Value>>,
    ) -> Result<NewSessionOutcome, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::NewSession { cwd, meta, reply })
            .map_err(|_| AcpClientError::NotRunning)?;`,
  "client.rs new_session",
);

// C3: 连接循环 arm 经官方 builder 注入 meta
client.text = replaceOnce(
  client.text,
`                        Command::NewSession { cwd, reply } => {
                            let res = cx
                                .send_request(NewSessionRequest::new(cwd))
                                .block_task()
                                .await;`,
`                        Command::NewSession { cwd, meta, reply } => {
                            // 仅 builtin 携带 _meta（模型目录 + 凭据，命令层组装）；外部 agent
                            // meta 为 None，构造与旧行为一致的请求。NewSessionRequest 为
                            // #[non_exhaustive]，不能用结构体字面量补字段，故经官方 builder
                            // .meta(map)（接受 impl IntoOption<Meta>，Meta = Map<String, Value>）注入。
                            let request = NewSessionRequest::new(cwd);
                            let request = match meta {
                                Some(meta) => request.meta(meta),
                                None => request,
                            };
                            let res = cx
                                .send_request(request)
                                .block_task()
                                .await;`,
  "client.rs NewSession arm",
);

// C4: 集成测试（_meta 线上键 + 目录形状）
client.text = replaceOnce(
  client.text,
`mod tests {
    use super::*;

    // ---- 履历测试 ----`,
`mod tests {
    use super::*;

    // ---- NewSession _meta 模型目录注入测试 ----

    #[test]
    fn new_session_request_carries_model_catalog_meta() {
        // 仅 builtin 后端在 session/new 经官方 _meta 通道下发模型目录（含凭据 + 当前选中项），供其
        // 边车公示官方 config_options 模型选择器、并在 set_config_option 切换时按 modelId 命中凭据。
        // 验证官方 builder .meta(map) 把目录序列化到线上键 _meta（serde rename），且形状与边车
        // model-config-options.ts 的 parseModelCatalogFromMeta 期望一致：
        // calamex.dev/modelCatalog -> { models:[{modelId,apiKey,baseUrl?}], currentModelId? }。
        let mut catalog = serde_json::Map::new();
        catalog.insert(
            "calamex.dev/modelCatalog".to_string(),
            serde_json::json!({
                "models": [
                    { "modelId": "deepseek/deepseek-v4-pro", "apiKey": "sk-x" }
                ],
                "currentModelId": "deepseek/deepseek-v4-pro",
            }),
        );

        let request = NewSessionRequest::new(PathBuf::from("/repo")).meta(catalog);
        let value = serde_json::to_value(&request).unwrap();

        let entry = &value["_meta"]["calamex.dev/modelCatalog"];
        assert_eq!(entry["models"][0]["modelId"], "deepseek/deepseek-v4-pro");
        assert_eq!(entry["models"][0]["apiKey"], "sk-x");
        assert!(entry["models"][0].get("baseUrl").is_none());
        assert_eq!(entry["currentModelId"], "deepseek/deepseek-v4-pro");
    }

    // ---- 履历测试 ----`,
  "client.rs tests",
);

write(client, client.text);

// ----------------------------------------------------------------------------
// 2) src-tauri/src/acp/host.rs
// ----------------------------------------------------------------------------
const host = read("src-tauri/src/acp/host.rs");

// H1: ensure_session 新增 meta 形参
host.text = replaceOnce(
  host.text,
`    pub async fn ensure_session(
        &self,
        thread_id: &str,
        workspace_root_path: Option<&str>,
    ) -> Result<SessionId, AcpClientError> {`,
`    pub async fn ensure_session(
        &self,
        thread_id: &str,
        workspace_root_path: Option<&str>,
        meta: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<SessionId, AcpClientError> {`,
  "host.rs ensure_session sig",
);

// H2: 透传 meta 给 new_session（仅新建分支消费）
host.text = replaceOnce(
  host.text,
`        let cwd = workspace_cwd(workspace_root_path);
        let outcome = self.handle.new_session(cwd).await?;`,
`        let cwd = workspace_cwd(workspace_root_path);
        // meta 仅在「新建会话」分支被消费（命中复用分支已提前返回）：仅 builtin 命令层会携带
        // session/new 的 _meta 模型目录（含凭据 + 当前选中项），外部 agent 与内部复用回合传 None。
        let outcome = self.handle.new_session(cwd, meta).await?;`,
  "host.rs new_session call",
);

// H3: prompt_with_stream_key 复用回合不再下发目录（meta=None）
host.text = replaceOnce(
  host.text,
`        let session_id = self.ensure_session(thread_id, workspace_root_path).await?;`,
`        // 标准回合复用命令层首次建立的会话（含 builtin 经 _meta 下发的模型目录），此处不再下发
        // 目录：meta 传 None（外部 agent 凭据自管；builtin 目录在 ensure_session 首建时已注入）。
        let session_id = self
            .ensure_session(thread_id, workspace_root_path, None)
            .await?;`,
  "host.rs prompt_with_stream_key",
);

write(host, host.text);

// ----------------------------------------------------------------------------
// 3) src-tauri/src/commands/builtin_agent.rs
// ----------------------------------------------------------------------------
const cmd = read("src-tauri/src/commands/builtin_agent.rs");

// B1: 新增 builtin_model_catalog_meta(_from) 组装目录（紧随 model_config_to_ext）
cmd.text = replaceOnce(
  cmd.text,
`fn model_config_to_ext(config: AgentSidecarModelConfigPayload) -> crate::acp::ExtModelConfig {
    crate::acp::ExtModelConfig {
        model_id: config.model_id,
        api_key: config.api_key,
        base_url: trimmed_non_empty(config.base_url),
    }
}`,
`fn model_config_to_ext(config: AgentSidecarModelConfigPayload) -> crate::acp::ExtModelConfig {
    crate::acp::ExtModelConfig {
        model_id: config.model_id,
        api_key: config.api_key,
        base_url: trimmed_non_empty(config.base_url),
    }
}

/// 组装 builtin 后端 session/new 的 _meta 模型目录（仅 builtin 用）的纯函数：把「全量可用模型
/// + 当前选中项」投影为边车可解析的目录对象。抽出可注入版便于单测，不触碰全局 AI 配置状态。
///
/// 为何经 _meta 下发：官方 session/set_config_option 仅携带被选中的 modelId、不含凭据，而 launch
/// 层有意不向 ACP 子进程注入模型 env（见 acp/launch.rs）。故 builtin 边车需在建会话时一次性拿到
/// 「用户全部可用模型 + 凭据 + 当前选中项」，据此公示官方 config_options 模型选择器（与 Kimi 同构），
/// 并在后续 set_config_option 切换时按 modelId 命中已下发的凭据。
///
/// 目录形状对齐边车 model-config-options.ts 的 IAcpModelCatalog：
/// { models: [{ modelId, apiKey, baseUrl? }], currentModelId? }——models 经 ExtModelConfig 的
/// camelCase 序列化逐条投影（与逐请求模型配置同形）；currentModelId 缺省时整字段省略（不下发
/// null）。models 为空且无当前项时返回 None（不附 _meta，回退既有行为）。
fn builtin_model_catalog_meta_from(
    seeded: Vec<AgentSidecarModelConfigPayload>,
    current_model_id: Option<String>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let models: Vec<crate::acp::ExtModelConfig> =
        seeded.into_iter().map(model_config_to_ext).collect();
    if models.is_empty() && current_model_id.is_none() {
        return None;
    }

    let mut catalog = serde_json::Map::new();
    catalog.insert(
        "models".to_string(),
        serde_json::to_value(&models).unwrap_or_else(|_| serde_json::Value::Array(Vec::new())),
    );
    if let Some(current_model_id) = current_model_id {
        catalog.insert(
            "currentModelId".to_string(),
            serde_json::Value::String(current_model_id),
        );
    }

    let mut meta = serde_json::Map::new();
    meta.insert(
        "calamex.dev/modelCatalog".to_string(),
        serde_json::Value::Object(catalog),
    );
    Some(meta)
}

/// 生产入口：从已保存 AI 配置组装 builtin session/new 的 _meta 模型目录。
/// models 取「用户真正可用（有 Key）」的全量 seeded 清单（seeded_sidecar_model_configs 已逐条
/// best-effort 跳过无凭据者）；currentModelId 取当前主模型（解析失败则省略）。
fn builtin_model_catalog_meta() -> Option<serde_json::Map<String, serde_json::Value>> {
    builtin_model_catalog_meta_from(
        crate::ai::gateway::seeded_sidecar_model_configs(),
        crate::ai::gateway::current_sidecar_model_config()
            .ok()
            .map(|config| config.model_id),
    )
}`,
  "builtin_agent.rs catalog helper",
);

// B2: external_chat 按 backend 注入目录（仅 Builtin）
cmd.text = replaceOnce(
  cmd.text,
`        let acp_session_id = host.ensure_session(thread_id, workspace_root_path).await?;`,
`        // 仅 builtin 后端经 session/new 的 _meta 下发模型目录（含凭据 + 当前选中项），供其边车
        // 公示官方 config_options 模型选择器、并在 set_config_option 切换时按 modelId 命中已下发
        // 凭据；外部 agent（Kimi/Codex）凭据自管，不下发（None）。详见 builtin_model_catalog_meta。
        let session_meta = match backend {
            crate::acp::AcpBackendId::Builtin => builtin_model_catalog_meta(),
            crate::acp::AcpBackendId::Kimi | crate::acp::AcpBackendId::Codex => None,
        };
        let acp_session_id = host
            .ensure_session(thread_id, workspace_root_path, session_meta)
            .await?;`,
  "builtin_agent.rs external_chat ensure_session",
);

// B3: 旧带外三命令（chat / resolve_approval / resolve_ask_user）的 ensure_session 补 None
cmd.text = replaceExactly(
  cmd.text,
`        .ensure_session(
            payload.thread_id.as_deref().unwrap_or_default(),
            payload.workspace_root_path.as_deref(),
        )`,
`        .ensure_session(
            payload.thread_id.as_deref().unwrap_or_default(),
            payload.workspace_root_path.as_deref(),
            // 旧带外 agent_chat 通路：模型配置走 extMethod 的 model_config 字段（见
            // ensure_model_config），session/new 不下发 _meta 目录。D1 删除该通路后随之消失。
            None,
        )`,
  3,
  "builtin_agent.rs legacy ensure_session x3",
);

// B4: 目录组装单测（紧随 sample_config 测试夹具）
cmd.text = replaceOnce(
  cmd.text,
`    fn sample_config(model_id: &str) -> AgentSidecarModelConfigPayload {
        AgentSidecarModelConfigPayload {
            model_id: model_id.to_string(),
            api_key: "secret-key".into(),
            base_url: None,
        }
    }`,
`    fn sample_config(model_id: &str) -> AgentSidecarModelConfigPayload {
        AgentSidecarModelConfigPayload {
            model_id: model_id.to_string(),
            api_key: "secret-key".into(),
            base_url: None,
        }
    }

    #[test]
    fn builtin_model_catalog_meta_assembles_models_and_current() {
        let meta = builtin_model_catalog_meta_from(
            vec![
                sample_config("deepseek/deepseek-v4-pro"),
                sample_config("zhipuai/glm-4.7-flash"),
            ],
            Some("deepseek/deepseek-v4-pro".to_string()),
        )
        .expect("有模型时应组装出目录");
        let catalog = &meta["calamex.dev/modelCatalog"];
        assert_eq!(catalog["models"].as_array().unwrap().len(), 2);
        assert_eq!(catalog["models"][0]["modelId"], "deepseek/deepseek-v4-pro");
        // ExtModelConfig 的 api_key（SecretString）序列化为明文，与逐请求模型配置同形。
        assert_eq!(catalog["models"][0]["apiKey"], "secret-key");
        assert!(catalog["models"][0].get("baseUrl").is_none());
        assert_eq!(catalog["currentModelId"], "deepseek/deepseek-v4-pro");
    }

    #[test]
    fn builtin_model_catalog_meta_omits_current_when_absent() {
        let meta =
            builtin_model_catalog_meta_from(vec![sample_config("deepseek/deepseek-v4-pro")], None)
                .expect("仅有模型清单时也应组装出目录");
        let catalog = &meta["calamex.dev/modelCatalog"];
        assert_eq!(catalog["models"].as_array().unwrap().len(), 1);
        // 当前选中项缺省时不下发 currentModelId（整字段省略，不发 null）。
        assert!(catalog.get("currentModelId").is_none());
    }

    #[test]
    fn builtin_model_catalog_meta_none_when_empty() {
        // 无任何可用模型且无当前项时不附 _meta（回退既有行为）。
        assert!(builtin_model_catalog_meta_from(Vec::new(), None).is_none());
    }`,
  "builtin_agent.rs catalog tests",
);

write(cmd, cmd.text);

console.log("S2 完成：");
console.log("  - " + client.rel + "（Command::NewSession / new_session / arm + meta 集成测试）");
console.log("  - " + host.rel + "（ensure_session 透传 meta；prompt 复用回合传 None）");
console.log("  - " + cmd.rel + "（builtin_model_catalog_meta 组装 + external_chat 注入 + 旧三命令补 None + 3 单测）");
console.log("提示：S2 准备好宿主目录通路，须配合 S3（前端把 builtin 改走 sidecarExternalChat({backend:'builtin'})）才会真正生效。");
console.log("门槛：cargo clippy/test --features acp_client --manifest-path src-tauri/Cargo.toml");
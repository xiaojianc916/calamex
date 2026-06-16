$ErrorActionPreference = "Stop"

$repo = "D:\com.xiaojianc\my_desktop_app"
Set-Location $repo

function Replace-Once {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Old,
        [Parameter(Mandatory=$true)][string]$New
    )

    $text = Get-Content -Raw -Encoding UTF8 $Path
    if (-not $text.Contains($Old)) {
        throw "未找到预期片段：$Path"
    }

    $updated = $text.Replace($Old, $New)
    if ($updated -eq $text) {
        throw "替换未生效：$Path"
    }

    Set-Content -Path $Path -Value $updated -Encoding UTF8 -NoNewline
}

# 1. unused variable: repository_root
Replace-Once `
    -Path "src-tauri/src/commands/git/branches.rs" `
    -Old @'
fn build_git_branch_payload_from_ref(
    repository: &Repository,
    repository_root: &Path,
    reference: &gix::Reference<'_>,
'@ `
    -New @'
fn build_git_branch_payload_from_ref(
    repository: &Repository,
    _repository_root: &Path,
    reference: &gix::Reference<'_>,
'@

# 2. unused function + unused import: with_identity_system_message / build_identity_system_message
Replace-Once `
    -Path "src-tauri/src/ai/gateway/conversation.rs" `
    -Old @'
use super::prompt::{
    build_context_block, build_conversation_title_prompt, build_identity_system_message,
    build_inline_prompt, clip_title_source,
};
'@ `
    -New @'
use super::prompt::{
    build_context_block, build_conversation_title_prompt, build_inline_prompt, clip_title_source,
};
'@

Replace-Once `
    -Path "src-tauri/src/ai/gateway/conversation.rs" `
    -Old @'
pub(super) fn with_identity_system_message(
    mut messages: Vec<AiProviderMessage>,
    model: &str,
) -> Vec<AiProviderMessage> {
    let mut result = Vec::with_capacity(messages.len() + 1);
    result.push(build_identity_system_message(model));
    result.append(&mut messages);
    result
}

'@ `
    -New ""

# 3. provider usage 类型暂时保留为内部兼容结构，显式标注预期未构造
Replace-Once `
    -Path "src-tauri/src/ai/provider/mod.rs" `
    -Old @'
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderInputTokenDetails {
'@ `
    -New @'
#[expect(dead_code, reason = "kept for provider usage payload compatibility")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderInputTokenDetails {
'@

Replace-Once `
    -Path "src-tauri/src/ai/provider/mod.rs" `
    -Old @'
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderOutputTokenDetails {
'@ `
    -New @'
#[expect(dead_code, reason = "kept for provider usage payload compatibility")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderOutputTokenDetails {
'@

Replace-Once `
    -Path "src-tauri/src/ai/provider/mod.rs" `
    -Old @'
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderUsage {
'@ `
    -New @'
#[expect(dead_code, reason = "kept for provider usage payload compatibility")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderUsage {
'@

# 4. AgentSidecarWarmupRequest 暂时未接线，保留契约类型
Replace-Once `
    -Path "src-tauri/src/commands/contracts/agent_sidecar.rs" `
    -Old @'
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarWarmupRequest {
'@ `
    -New @'
#[expect(dead_code, reason = "kept for sidecar warmup request contract compatibility")]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarWarmupRequest {
'@

# 5. AiCancelRequest.stream_id 是前端 payload 兼容字段，当前取消逻辑按 thread_id 执行
Replace-Once `
    -Path "src-tauri/src/commands/contracts/ai_chat.rs" `
    -Old @'
pub struct AiCancelRequest {
    pub(crate) stream_id: String,
    pub(crate) thread_id: Option<String>,
}
'@ `
    -New @'
pub struct AiCancelRequest {
    #[expect(dead_code, reason = "stream_id remains part of the public cancel request payload")]
    pub(crate) stream_id: String,
    pub(crate) thread_id: Option<String>,
}
'@

# 6. clippy::doc_lazy_continuation：补空行，让列表后的段落独立
Replace-Once `
    -Path "src-tauri/src/acp/client.rs" `
    -Old @'
///   * outcome 取值(selected/cancelled)由 sidecar zod 校验,宿主侧原样透传;
///   * answers 为每题作答,outcome=cancelled 时整字段省略(对齐 zod `.optional()`)。
/// 响应同 AgentChatResolveExtRequest：整封 sidecar 信封,Value 原样回传。
'@ `
    -New @'
///   * outcome 取值(selected/cancelled)由 sidecar zod 校验,宿主侧原样透传;
///   * answers 为每题作答,outcome=cancelled 时整字段省略(对齐 zod `.optional()`)。
///
/// 响应同 AgentChatResolveExtRequest：整封 sidecar 信封,Value 原样回传。
'@

Replace-Once `
    -Path "src-tauri/src/acp/ui_event.rs" `
    -Old @'
//! - `agent_message_chunk`（模型文本增量）→ message_delta{phase:"final"}
//! - `agent_thought_chunk`（推理增量）   → message_delta{phase:"stage"}
//! 其余 session/update 变体在「ask 主聊天」回合不会出现（tool_call(_update)/plan 属
'@ `
    -New @'
//! - `agent_message_chunk`（模型文本增量）→ message_delta{phase:"final"}
//! - `agent_thought_chunk`（推理增量）   → message_delta{phase:"stage"}
//!
//! 其余 session/update 变体在「ask 主聊天」回合不会出现（tool_call(_update)/plan 属
'@

Replace-Once `
    -Path "src-tauri/src/commands/agent_webview.rs" `
    -Old @'
//!   - navigation state = subscribe Page.frameNavigated -> recompute url + canGoBack/canGoForward,
//!   - select = inject @medv/finder picker (Runtime.evaluate) + Runtime.addBinding callback.
//! The CDP connection is initiated from Rust (frontend never touches ws://, CSP unchanged).
'@ `
    -New @'
//!   - navigation state = subscribe Page.frameNavigated -> recompute url + canGoBack/canGoForward,
//!   - select = inject @medv/finder picker (Runtime.evaluate) + Runtime.addBinding callback.
//!
//! The CDP connection is initiated from Rust (frontend never touches ws://, CSP unchanged).
'@

Replace-Once `
    -Path "src-tauri/src/commands/contracts/agent_sidecar.rs" `
    -Old @'
///   * outcome 取值（selected/cancelled）由 sidecar zod 校验，原样透传；
///   * answers 为每题作答，outcome=cancelled 时通常缺省（serde 整字段省略，对齐 zod `.optional()`）。
/// 与 approval 恢复一致地携带 plan_*（plan 续跑定位），不含 `mode`（恢复不切换模式）。
'@ `
    -New @'
///   * outcome 取值（selected/cancelled）由 sidecar zod 校验，原样透传；
///   * answers 为每题作答，outcome=cancelled 时通常缺省（serde 整字段省略，对齐 zod `.optional()`）。
///
/// 与 approval 恢复一致地携带 plan_*（plan 续跑定位），不含 `mode`（恢复不切换模式）。
'@

# 7. clippy::collapsible_if
Replace-Once `
    -Path "src-tauri/src/acp/ui_event.rs" `
    -Old @'
    if let Some(usage) = usage {
        if !usage.is_null() {
            event["usage"] = usage;
        }
    }
'@ `
    -New @'
    if let Some(usage) = usage
        && !usage.is_null()
    {
        event["usage"] = usage;
    }
'@

Replace-Once `
    -Path "src-tauri/src/commands/agent_webview.rs" `
    -Old @'
        if let Ok(pages) = browser.pages().await {
            if let Some(first) = pages.into_iter().next() {
                page_opt = Some(first);
                break;
            }
        }
'@ `
    -New @'
        if let Ok(pages) = browser.pages().await
            && let Some(first) = pages.into_iter().next()
        {
            page_opt = Some(first);
            break;
        }
'@

# 8. clippy::manual_ignore_case_cmp
Replace-Once `
    -Path "src-tauri/src/commands/git/github_auth.rs" `
    -Old @'
    if host.to_ascii_lowercase() != target.host.to_ascii_lowercase()
        || repository_root != target.repository_root
'@ `
    -New @'
    if !host.eq_ignore_ascii_case(&target.host) || repository_root != target.repository_root
'@

Write-Host "clippy 定点修复已完成。"
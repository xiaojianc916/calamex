//! 宿主侧 ACP 权限审批登记表（回合内挂起 / in-turn parking）。
//!
//! 镜像 Zed `agent_ui/acp_thread.rs` 的 `request_tool_call_authorization` /
//! `authorize_tool_call`：代理在一次 `session/prompt` 回合内，经反向
//! `session/request_permission` 请求授权时，宿主不另开旁路，而是把该请求
//! 「挂起在回合内」——即 `client` 的 `Client` 处理器返回的 future 保持 pending，
//! 从而 `session/prompt` 的响应被自然延后，直到用户在审批 UI 中作出选择。
//! 本登记表即承载这些挂起项：
//!   * 以 `(SessionId, ToolCallId)` 为键登记一个 oneshot 发送端；
//!   * `resolver(...)` 产出 `client::PermissionResolver` 闭包：每个权限请求到来时
//!     登记挂起项、把请求详情（含可选项）抛给上层 UI、随后 await 该 oneshot；
//!   * 上层（Tauri `resolve_approval` 命令）经 `resolve(...)` 投递决策，唤醒对应回合。
//!
//! 决策→选项的映射严格对齐协议与 sidecar 既有约定，不自创：
//!   1. 先按「逐字 optionId」匹配——这是 Zed 的做法（回传代理给出的 optionId 原值），
//!      且 calamex sidecar `approval-bridge.ts` 给出的 optionId 恰为 `allow-once` /
//!      `reject-once`，与既有 `decision` 线值天然一致；
//!   2. 再按 `PermissionOptionKind`（`allow_once|allow_always|reject_once|reject_always`）
//!      语义匹配，别名取自 sidecar `approval-client/utils.ts` 的判定白名单；
//!   3. 同族兜底（allow / reject），仍无则视为取消授权（安全侧）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use agent_client_protocol::BoxFuture;
use agent_client_protocol::schema::{
    PermissionOptionId, PermissionOptionKind, RequestPermissionRequest, SessionId, ToolCallId,
};
use tokio::sync::oneshot;

use super::client::{PermissionDecision, PermissionResolver};

/// 登记表键：同一会话内的某个工具调用唯一定位一个待决授权。
type ApprovalKey = (SessionId, ToolCallId);

/// 代理给出的一个可选项的最小投影（id + kind），用于决策映射。
#[derive(Clone)]
struct ResolvedOption {
    id: PermissionOptionId,
    kind: PermissionOptionKind,
}

/// 一个挂起中的授权请求：代理提供的可选项 + 唤醒回合用的 oneshot 发送端。
struct PendingApproval {
    options: Vec<ResolvedOption>,
    responder: oneshot::Sender<PermissionDecision>,
}

/// 抹给上层 UI 的单个可选项（camelCase 线格式，`kind` 为 ACP 线值）。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalOptionInfo {
    pub option_id: String,
    pub name: String,
    pub kind: &'static str,
}

/// 抹给上层 UI 的权限请求详情，供 webview 渲染审批提示。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequestInfo {
    pub session_id: String,
    pub tool_call_id: String,
    pub options: Vec<ApprovalOptionInfo>,
}

/// `resolve(...)` 的错误。
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ApprovalError {
    /// 给定的 (sessionId, toolCallId) 没有对应的待决授权（可能已被解决 / 已超时）。
    #[error("no pending approval for the given session and tool call")]
    NotFound,
    /// 挂起的回合已不再等待（接收端被丢弃，如回合被取消）。
    #[error("the awaiting prompt turn is no longer waiting for this approval")]
    RequesterGone,
}

/// 宿主侧权限审批登记表。可克隆句柄（内部共享一张表），便于在
/// `resolver`（在连接任务内）与 `resolve`（在 Tauri 命令内）两侧同时持有。
#[derive(Clone, Default)]
pub struct ApprovalRegistry {
    pending: Arc<Mutex<HashMap<ApprovalKey, PendingApproval>>>,
}

impl ApprovalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 产出 `client::PermissionResolver`：收到反向 `session/request_permission` 时登记挂
    /// 起项、把请求详情抛给 UI、随后 await 决策。`on_pending` 由上层（宿主编排）
    /// 提供，用于把待决项推给 webview（与流式事件下沉口解耦，便于单测）。
    pub fn resolver(
        &self,
        on_pending: Arc<dyn Fn(ApprovalRequestInfo) + Send + Sync>,
    ) -> PermissionResolver {
        let registry = self.clone();
        Arc::new(
            move |req: RequestPermissionRequest| -> BoxFuture<'static, PermissionDecision> {
                let registry = registry.clone();
                let on_pending = on_pending.clone();
                Box::pin(async move {
                    let (info, rx) = registry.register(req);
                    on_pending(info);
                    match rx.await {
                        Ok(decision) => decision,
                        // 发送端被丢弃（回合取消 / 连接关停 / 同键覆盖）视为取消授权。
                        Err(_) => PermissionDecision::Cancelled,
                    }
                })
            },
        )
    }

    /// 登记一个挂起的权限请求，返回抹给 UI 的详情与等待决策的 oneshot 接收端。
    fn register(
        &self,
        req: RequestPermissionRequest,
    ) -> (ApprovalRequestInfo, oneshot::Receiver<PermissionDecision>) {
        let session_id = req.session_id.clone();
        let tool_call_id = req.tool_call.tool_call_id.clone();

        let resolved: Vec<ResolvedOption> = req
            .options
            .iter()
            .map(|o| ResolvedOption {
                id: o.option_id.clone(),
                kind: o.kind,
            })
            .collect();

        let info = ApprovalRequestInfo {
            session_id: session_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            options: req
                .options
                .iter()
                .map(|o| ApprovalOptionInfo {
                    option_id: o.option_id.to_string(),
                    name: o.name.clone(),
                    kind: kind_wire(o.kind),
                })
                .collect(),
        };

        let rx = self.insert(session_id, tool_call_id, resolved);
        (info, rx)
    }

    /// 登记一条挂起项，返回其 oneshot 接收端。同键覆盖：旧发送端被丢弃→旧回合
    /// 的 rx 收到 Err → 自然按取消处理。
    fn insert(
        &self,
        session_id: SessionId,
        tool_call_id: ToolCallId,
        options: Vec<ResolvedOption>,
    ) -> oneshot::Receiver<PermissionDecision> {
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("approval registry mutex poisoned")
            .insert(
                (session_id, tool_call_id),
                PendingApproval {
                    options,
                    responder: tx,
                },
            );
        rx
    }

    /// 投递一个决策，唤醒对应的挂起回合。`decision` 取自上层（legacy `decision`
    /// 线值或代理给出的 optionId 原值）；映射规则见模块级文档。
    pub fn resolve(
        &self,
        session_id: SessionId,
        tool_call_id: ToolCallId,
        decision: &str,
    ) -> Result<(), ApprovalError> {
        let pending = self
            .pending
            .lock()
            .expect("approval registry mutex poisoned")
            .remove(&(session_id, tool_call_id))
            .ok_or(ApprovalError::NotFound)?;

        let outcome = decide(&pending.options, decision);
        pending
            .responder
            .send(outcome)
            .map_err(|_| ApprovalError::RequesterGone)
    }

    /// 取消并清除某会话下的全部挂起授权（回合取消 / 会话清理时调用）。
    /// 被移除项的发送端随之丢弃，对应挂起回合的 rx 收到 Err → 按取消处理。
    pub fn cancel_session(&self, session_id: &SessionId) {
        self.pending
            .lock()
            .expect("approval registry mutex poisoned")
            .retain(|key, _| &key.0 != session_id);
    }

    /// 清除全部挂起授权（连接关停时调用）。
    pub fn clear(&self) {
        self.pending
            .lock()
            .expect("approval registry mutex poisoned")
            .clear();
    }

    #[cfg(test)]
    fn pending_len(&self) -> usize {
        self.pending
            .lock()
            .expect("approval registry mutex poisoned")
            .len()
    }
}

/// 把 `PermissionOptionKind` 映射为 ACP 线值（snake_case）。枚举为 non_exhaustive，
/// 故保留通配臂以防未来新增变体。
fn kind_wire(kind: PermissionOptionKind) -> &'static str {
    match kind {
        PermissionOptionKind::AllowOnce => "allow_once",
        PermissionOptionKind::AllowAlways => "allow_always",
        PermissionOptionKind::RejectOnce => "reject_once",
        PermissionOptionKind::RejectAlways => "reject_always",
        _ => "other",
    }
}

/// 上层决策的语义意图。
enum Intent {
    Allow { remember: bool },
    Reject { remember: bool },
    Cancel,
}

/// 把上层决策值映射为 `PermissionDecision`。优先级见模块级文档：
/// 1) 逐字 optionId；2) 决策语义→kind；3) 同族兜底；否则取消。
fn decide(options: &[ResolvedOption], decision: &str) -> PermissionDecision {
    let trimmed = decision.trim();

    // 1) 逐字 optionId（Zed 做法 + sidecar optionId 即 allow-once/reject-once）。
    if let Some(opt) = options.iter().find(|o| o.id.to_string() == trimmed) {
        return PermissionDecision::Selected(opt.id.clone());
    }

    // 2) 决策语义 → kind（+ 3 同族兜底）。
    match classify(trimmed) {
        Some(Intent::Allow { remember }) => select_in_family(options, true, remember),
        Some(Intent::Reject { remember }) => select_in_family(options, false, remember),
        // 显式取消 / 无法识别 → 取消授权（安全侧）。
        Some(Intent::Cancel) | None => PermissionDecision::Cancelled,
    }
}

/// 在一个语义族（allow / reject）内选项：先精确匹配首选 kind，再同族兜底，仍无则取消。
fn select_in_family(options: &[ResolvedOption], allow: bool, remember: bool) -> PermissionDecision {
    let preferred = match (allow, remember) {
        (true, false) => PermissionOptionKind::AllowOnce,
        (true, true) => PermissionOptionKind::AllowAlways,
        (false, false) => PermissionOptionKind::RejectOnce,
        (false, true) => PermissionOptionKind::RejectAlways,
    };
    if let Some(opt) = options.iter().find(|o| o.kind == preferred) {
        return PermissionDecision::Selected(opt.id.clone());
    }

    let family: &[PermissionOptionKind] = if allow {
        &[
            PermissionOptionKind::AllowOnce,
            PermissionOptionKind::AllowAlways,
        ]
    } else {
        &[
            PermissionOptionKind::RejectOnce,
            PermissionOptionKind::RejectAlways,
        ]
    };
    if let Some(opt) = options.iter().find(|o| family.contains(&o.kind)) {
        return PermissionDecision::Selected(opt.id.clone());
    }

    PermissionDecision::Cancelled
}

/// 把上层决策字符串归类为语义意图。别名取自 sidecar `approval-bridge.ts`
/// 常量（`allow-once` / `reject-once`）与 `approval-client/utils.ts` 的判定白名单
/// (`approve` / `approved` / `allow` / `allow-once` / `allow-run`)，不自创。
fn classify(decision: &str) -> Option<Intent> {
    match decision.trim().to_ascii_lowercase().as_str() {
        "allow-always" | "allow_always" => Some(Intent::Allow { remember: true }),
        "allow-once" | "allow_once" | "allow" | "approve" | "approved" | "allow-run" => {
            Some(Intent::Allow { remember: false })
        }
        "reject-always" | "reject_always" => Some(Intent::Reject { remember: true }),
        "reject-once" | "reject_once" | "reject" | "rejected" | "deny" | "denied" => {
            Some(Intent::Reject { remember: false })
        }
        "cancel" | "cancelled" | "canceled" => Some(Intent::Cancel),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opt(id: &str, kind: PermissionOptionKind) -> ResolvedOption {
        ResolvedOption {
            id: PermissionOptionId::new(id),
            kind,
        }
    }

    fn selected(decision: PermissionDecision) -> String {
        match decision {
            PermissionDecision::Selected(id) => id.to_string(),
            PermissionDecision::Cancelled => panic!("expected Selected, got Cancelled"),
        }
    }

    fn is_cancelled(decision: &PermissionDecision) -> bool {
        matches!(decision, PermissionDecision::Cancelled)
    }

    fn sidecar_options() -> Vec<ResolvedOption> {
        vec![
            opt("allow-once", PermissionOptionKind::AllowOnce),
            opt("reject-once", PermissionOptionKind::RejectOnce),
        ]
    }

    #[test]
    fn decide_matches_option_id_verbatim() {
        // sidecar optionId 即 decision 线值：逐字命中（Zed 做法）。
        assert_eq!(
            selected(decide(&sidecar_options(), "allow-once")),
            "allow-once"
        );
        assert_eq!(
            selected(decide(&sidecar_options(), "reject-once")),
            "reject-once"
        );
    }

    #[test]
    fn decide_maps_semantic_aliases_to_kind() {
        // optionId 不同于 decision 线值时，按 kind 语义匹配。
        let options = vec![
            opt("opt-allow", PermissionOptionKind::AllowOnce),
            opt("opt-reject", PermissionOptionKind::RejectOnce),
        ];
        assert_eq!(selected(decide(&options, "approve")), "opt-allow");
        assert_eq!(selected(decide(&options, "deny")), "opt-reject");
        assert_eq!(selected(decide(&options, "ALLOW")), "opt-allow");
    }

    #[test]
    fn decide_allow_always_prefers_always_then_falls_back_in_family() {
        let with_always = vec![
            opt("once", PermissionOptionKind::AllowOnce),
            opt("always", PermissionOptionKind::AllowAlways),
        ];
        assert_eq!(selected(decide(&with_always, "allow-always")), "always");

        // 代理未提供 allow_always 时，同族兜底到 allow_once。
        let only_once = vec![opt("once", PermissionOptionKind::AllowOnce)];
        assert_eq!(selected(decide(&only_once, "allow-always")), "once");
    }

    #[test]
    fn decide_unknown_or_cancel_is_cancelled() {
        assert!(is_cancelled(&decide(&sidecar_options(), "cancel")));
        assert!(is_cancelled(&decide(&sidecar_options(), "gibberish")));
    }

    #[test]
    fn decide_reject_when_only_allow_offered_is_cancelled() {
        // 只有 allow 选项时，拒绝类决策无同族可选 → 取消（不误选 allow）。
        let only_allow = vec![opt("allow-once", PermissionOptionKind::AllowOnce)];
        assert!(is_cancelled(&decide(&only_allow, "reject-once")));
    }

    #[test]
    fn kind_wire_maps_all_known_kinds() {
        assert_eq!(kind_wire(PermissionOptionKind::AllowOnce), "allow_once");
        assert_eq!(kind_wire(PermissionOptionKind::AllowAlways), "allow_always");
        assert_eq!(kind_wire(PermissionOptionKind::RejectOnce), "reject_once");
        assert_eq!(
            kind_wire(PermissionOptionKind::RejectAlways),
            "reject_always"
        );
    }

    #[test]
    fn resolve_delivers_decision_to_waiting_turn() {
        let registry = ApprovalRegistry::new();
        let session = SessionId::new("sess-1");
        let tool_call = ToolCallId::new("tool-1");
        let rx = registry.insert(session.clone(), tool_call.clone(), sidecar_options());
        assert_eq!(registry.pending_len(), 1);

        registry
            .resolve(session.clone(), tool_call.clone(), "allow-once")
            .expect("resolve should succeed for a registered approval");

        // 被解决后从表中移除。
        assert_eq!(registry.pending_len(), 0);
        let mut rx = rx;
        match rx.try_recv() {
            Ok(PermissionDecision::Selected(id)) => assert_eq!(id.to_string(), "allow-once"),
            Ok(PermissionDecision::Cancelled) => {
                panic!("expected Selected(allow-once), got Cancelled")
            }
            Err(err) => panic!("expected a decision to be available, got recv error: {err:?}"),
        }
    }

    #[test]
    fn resolve_unknown_key_is_not_found() {
        let registry = ApprovalRegistry::new();
        let err = registry
            .resolve(SessionId::new("x"), ToolCallId::new("y"), "allow-once")
            .unwrap_err();
        assert_eq!(err, ApprovalError::NotFound);
    }

    #[test]
    fn cancel_session_drops_pending_for_that_session() {
        let registry = ApprovalRegistry::new();
        let session_a = SessionId::new("a");
        let session_b = SessionId::new("b");
        let rx_a = registry.insert(session_a.clone(), ToolCallId::new("t"), sidecar_options());
        let _rx_b = registry.insert(session_b.clone(), ToolCallId::new("t"), sidecar_options());
        assert_eq!(registry.pending_len(), 2);

        registry.cancel_session(&session_a);
        assert_eq!(registry.pending_len(), 1);

        // 被取消会话的发送端被丢弃 → rx 收到 Err。
        let mut rx_a = rx_a;
        assert!(rx_a.try_recv().is_err());
    }
}

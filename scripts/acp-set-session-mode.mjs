// scripts/acp-set-session-mode.mjs
//
// 一次性 codemod（D7-③-a）：把 ACP 标准 session/set_mode 端到端接线。
// client.rs 的 SetSessionMode 命令/句柄已存在，本脚本只补上层接线：
//   host.rs      暴露 AcpHost::set_session_mode（查已绑定会话，不 ensure_session）
//   runtime.rs   AcpRuntime::set_session_mode 向多后端广播 + 空运行单测
//   ai_chat.rs   新增 AiSetSessionModeRequest { threadId, modeId } 契约
//   gateway.rs   新增 ai_set_session_mode 命令（镜像 ai_cancel / ai_resolve_approval）
//   tauri_bindings.rs  登记 ai::gateway::ai_set_session_mode
//
// 幂等：每个文件先按 skipIf 标记跳过；每个锚点要求恰好命中 1 次，否则抛错中止。
// EOL 容错：本地工作树可能是 CRLF，先归一到 LF 匹配，写回时还原文件原有 CRLF，避免行尾噪声。
// 仓库根目录运行：node scripts/acp-set-session-mode.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const edits = [
  {
    file: 'src-tauri/src/acp/host.rs',
    skipIf: 'pub async fn set_session_mode',
    steps: [
      {
        find: `use agent_client_protocol::schema::{ContentBlock, SessionId, StopReason, ToolCallId};`,
        replace: `use agent_client_protocol::schema::{ContentBlock, SessionId, SessionModeId, StopReason, ToolCallId};`,
      },
      {
        find: `            ToolCallId::from(tool_call_id.to_string()),
            decision,
        )
    }
`,
        replace: `            ToolCallId::from(tool_call_id.to_string()),
            decision,
        )
    }

    /// 切换指定线程当前 ACP 会话的模式（标准 session/set_mode 请求）。
    ///
    /// 仅在本宿主已绑定该 thread_id 的会话时执行：命中则下发 session/set_mode 并返回
    /// Ok(true)；未绑定（空 thread / 无映射）则返回 Ok(false) 作为安全空操作，交由 runtime
    /// 广播给真正持有该线程的后端宿主。绝不在此 ensure_session 新建会话——模式切换只对既有
    /// 会话有意义（对齐 cancel_thread 的「无会话即空操作」语义）。纯转发，不修改本地状态。
    pub async fn set_session_mode(
        &self,
        thread_id: &str,
        mode_id: &str,
    ) -> Result<bool, AcpClientError> {
        let thread_key = thread_id.trim();
        if thread_key.is_empty() {
            return Ok(false);
        }
        let session_id = self.sessions.lock().get(thread_key).cloned();
        let Some(session_id) = session_id else {
            return Ok(false);
        };
        self.handle
            .set_session_mode(session_id, SessionModeId::from(mode_id.to_string()))
            .await?;
        Ok(true)
    }
`,
      },
    ],
  },
  {
    file: 'src-tauri/src/acp/runtime.rs',
    skipIf: 'pub async fn set_session_mode',
    steps: [
      {
        find: `    /// 关停并释放全部后端的常驻连接（App 统一退出清理调用）。幂等：无宿主时为安全空操作。`,
        replace: `    /// 切换指定线程当前 ACP 会话的模式（标准 session/set_mode）。线程绑定的会话可能落在
    /// 任一后端宿主，故向全部**已建立**宿主广播下发：命中（某宿主确有该线程会话并下发成功）
    /// 即记为已应用并返回 true。无任何宿主 / 无匹配线程时返回 Ok(false)（安全空操作——模式
    /// 切换绝不应触发 node 子进程派生）。至多一个宿主持有该线程，故某宿主下发失败即整体失败。
    pub async fn set_session_mode(
        &self,
        thread_id: &str,
        mode_id: &str,
    ) -> Result<bool, AcpClientError> {
        // 先取出 Arc 列表并释放锁，避免在广播下发（跨 await）期间持有 runtime 锁。
        let hosts = self.hosts.lock().all();
        let mut applied = false;
        for host in hosts {
            if host.set_session_mode(thread_id, mode_id).await? {
                applied = true;
            }
        }
        Ok(applied)
    }

    /// 关停并释放全部后端的常驻连接（App 统一退出清理调用）。幂等：无宿主时为安全空操作。`,
      },
      {
        find: `    #[test]
    fn webview_event_names_match_documented_contract() {`,
        replace: `    #[test]
    fn set_session_mode_on_unestablished_runtime_is_noop() {
        let runtime = AcpRuntime::default();
        // 无任何宿主时，模式切换为安全空操作：返回 Ok(false) 且绝不派生子进程。
        let applied = tauri::async_runtime::block_on(runtime.set_session_mode("thread-1", "code"))
            .expect("set_session_mode on empty runtime should not error");
        assert!(!applied);
        assert!(runtime.hosts.lock().all().is_empty());
    }

    #[test]
    fn webview_event_names_match_documented_contract() {`,
      },
    ],
  },
  {
    file: 'src-tauri/src/commands/contracts/ai_chat.rs',
    skipIf: 'AiSetSessionModeRequest',
    steps: [
      {
        find: `// ============================================================================
// AI – inline completion
// ============================================================================`,
        replace: `/// ACP 标准 session/set_mode 的模式切换请求（契约层）。
///
/// 对齐 acp::AcpRuntime::set_session_mode(thread_id, mode_id)：
///   * thread_id —— 定位目标会话（宿主持有 thread_id ↔ SessionId 映射，跨回合复用）；
///   * mode_id —— 目标模式的 ACP SessionMode.id 原值，逐字透传，绝不本地映射。
///
/// 两者均必填且非空（前端总能从已渲染的模式选择器取得），空白校验由接线层负责。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSetSessionModeRequest {
    pub(crate) thread_id: String,
    pub(crate) mode_id: String,
}

// ============================================================================
// AI – inline completion
// ============================================================================`,
      },
    ],
  },
  {
    file: 'src-tauri/src/commands/ai/gateway.rs',
    skipIf: 'pub async fn ai_set_session_mode',
    steps: [
      {
        find: `    AiSaveConfigRequest, AiSaveCredentialsRequest, AiSuggestionPoolPayload, AiSuggestionPoolRequest,`,
        replace: `    AiSaveConfigRequest, AiSaveCredentialsRequest, AiSetSessionModeRequest,
    AiSuggestionPoolPayload, AiSuggestionPoolRequest,`,
      },
      {
        find: `#[tauri::command]
#[specta::specta]
pub async fn ai_inline_complete(`,
        replace: `/// 切换 ACP 会话模式（标准 session/set_mode），令外部 agent（Kimi Code / Codex 等）在
/// code / plan 等模式间切换。
///
/// 与 ai_cancel 同构地委托给 Tauri 托管的 AcpRuntime：线程归属哪个后端宿主对命令层透明，由
/// runtime 向全部已建立宿主广播下发。两字段先行空白校验（前端总能从已渲染的模式选择器取得）；
/// 返回是否命中某已绑定会话——false 表示无匹配（多为会话尚未建立/已结束的良性竞态，命令层不
/// 视作错误，交前端自行决定是否提示），与 runtime 的「安全空操作」语义一致。
#[tauri::command]
#[specta::specta]
pub async fn ai_set_session_mode(
    app: AppHandle,
    payload: AiSetSessionModeRequest,
) -> Result<bool, String> {
    let thread_id = payload.thread_id.trim();
    if thread_id.is_empty() {
        return Err("AI_SET_SESSION_MODE_INVALID: threadId 不能为空。".to_string());
    }
    let mode_id = payload.mode_id.trim();
    if mode_id.is_empty() {
        return Err("AI_SET_SESSION_MODE_INVALID: modeId 不能为空。".to_string());
    }

    use tauri::Manager as _;
    let applied = app
        .state::<crate::acp::AcpRuntime>()
        .set_session_mode(thread_id, mode_id)
        .await
        .map_err(|error| format!("AI_SET_SESSION_MODE_FAILED: {error}"))?;
    Ok(applied)
}

#[tauri::command]
#[specta::specta]
pub async fn ai_inline_complete(`,
      },
    ],
  },
  {
    file: 'src-tauri/src/tauri_bindings.rs',
    skipIf: 'ai::gateway::ai_set_session_mode',
    steps: [
      {
        find: `            ai::gateway::ai_resolve_approval,
`,
        replace: `            ai::gateway::ai_resolve_approval,
            ai::gateway::ai_set_session_mode,
`,
      },
    ],
  },
];

let changed = 0;
for (const edit of edits) {
  const raw = readFileSync(edit.file, 'utf8');
  if (edit.skipIf && raw.includes(edit.skipIf)) {
    console.log(`skip (already applied): ${edit.file}`);
    continue;
  }
  // EOL 归一：CRLF -> LF 匹配，写回时还原，避免行尾噪声污染 diff。
  const hadCRLF = raw.includes('\r\n');
  let src = hadCRLF ? raw.replace(/\r\n/g, '\n') : raw;
  for (const step of edit.steps) {
    const count = src.split(step.find).length - 1;
    if (count !== 1) {
      throw new Error(
        `expected exactly 1 anchor in ${edit.file}, found ${count}:\n--- anchor ---\n${step.find}`,
      );
    }
    src = src.replace(step.find, () => step.replace);
  }
  const out = hadCRLF ? src.replace(/\n/g, '\r\n') : src;
  writeFileSync(edit.file, out, 'utf8');
  changed += 1;
  console.log(`patched: ${edit.file}${hadCRLF ? ' (CRLF preserved)' : ''}`);
}
console.log(`\ndone. files changed: ${changed}/${edits.length}`);

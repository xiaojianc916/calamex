#!/usr/bin/env node
// @ts-check
/**
 * D7-③-b-2-1 codemod — capture NewSessionResponse.modes (available-mode list) in the ACP host.
 *
 * Additive, idempotent (skipIf), CRLF-tolerant. Pure Rust capture slice:
 *   - acp/client.rs : NewSession reply now carries NewSessionOutcome { session_id, modes }
 *                     (modes = NewSessionResponse.modes serialized to JSON, null -> None).
 *   - acp/host.rs   : AcpHost stores modes_by_thread keyed by thread_id on ensure_session;
 *                     new session_modes() accessor is consumed by the follow-up query-command
 *                     slice (D7-③-b-2-2).
 *
 * No front-end / bindings change in this slice: available modes arrive in the NewSession
 * *response*, not a session/update notification, so they are captured here and surfaced via a
 * query command in ③-b-2-2, then consumed by the ③-c selector. No fabricated stream event.
 *
 * Run from repo root:  node scripts/acp-capture-session-modes.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const L = (...lines) => lines.join('\n');

const FILES = [
  {
    path: 'src-tauri/src/acp/client.rs',
    skipIf: 'pub struct NewSessionOutcome',
    steps: [
      {
        find: L(
          'enum Command {',
          '    NewSession {',
          '        cwd: PathBuf,',
          '        reply: oneshot::Sender<Result<SessionId, String>>,',
          '    },',
        ),
        replace: L(
          '/// `new_session` 的结果：会话标识 + 可选的可用模式清单。',
          '///',
          '/// `modes` 为 ACP `NewSessionResponse.modes`（`SessionModeState`：`currentModeId` +',
          '/// `availableModes[]`）的原样 JSON——最小透传，宿主侧不重建 SDK 类型，交前端 ACL 解释',
          '/// （对齐 tool_call 的 `acpUpdate` 整体透传）。`None` 表示 agent 未公示会话模式。',
          'pub struct NewSessionOutcome {',
          '    pub session_id: SessionId,',
          '    pub modes: Option<Value>,',
          '}',
          '',
          'enum Command {',
          '    NewSession {',
          '        cwd: PathBuf,',
          '        reply: oneshot::Sender<Result<NewSessionOutcome, String>>,',
          '    },',
        ),
      },
      {
        find: '    pub async fn new_session(&self, cwd: PathBuf) -> Result<SessionId, AcpClientError> {',
        replace:
          '    pub async fn new_session(&self, cwd: PathBuf) -> Result<NewSessionOutcome, AcpClientError> {',
      },
      {
        find: L(
          '                        Command::NewSession { cwd, reply } => {',
          '                            let res = cx',
          '                                .send_request(NewSessionRequest::new(cwd))',
          '                                .block_task()',
          '                                .await;',
          '                            let _ =',
          '                                reply.send(res.map(|r| r.session_id).map_err(|e| e.to_string()));',
          '                        }',
        ),
        replace: L(
          '                        Command::NewSession { cwd, reply } => {',
          '                            let res = cx',
          '                                .send_request(NewSessionRequest::new(cwd))',
          '                                .block_task()',
          '                                .await;',
          '                            // 最小透传：把 NewSessionResponse.modes（可用模式清单）原样序列化为',
          '                            // JSON 一并回传（null → None），宿主侧据 thread_id 登记，供模式选择器消费。',
          '                            let outcome = res.map(|r| NewSessionOutcome {',
          '                                session_id: r.session_id,',
          '                                modes: serde_json::to_value(&r.modes).ok().filter(|v| !v.is_null()),',
          '                            });',
          '                            let _ = reply.send(outcome.map_err(|e| e.to_string()));',
          '                        }',
        ),
      },
    ],
  },
  {
    path: 'src-tauri/src/acp/host.rs',
    skipIf: 'modes_by_thread',
    steps: [
      {
        find: L(
          'use super::client::{',
          '    AcpClientConfig, AcpClientError, AcpClientHandle, AcpStreamFrame, AgentAskUserResumeExtRequest,',
          '    AgentChatExtRequest, AgentChatResolveExtRequest, CheckpointRestoreRequest, EventSink,',
          '    HealthExtRequest, ModelChatExtRequest, OrchestrateExtRequest, OrchestrateResumeExtRequest,',
          '    WarmupExtRequest, WebFetchExtRequest, WebSearchExtRequest, spawn_acp_client,',
          '};',
        ),
        replace: L(
          'use super::client::{',
          '    AcpClientConfig, AcpClientError, AcpClientHandle, AcpStreamFrame, AgentAskUserResumeExtRequest,',
          '    AgentChatExtRequest, AgentChatResolveExtRequest, CheckpointRestoreRequest, EventSink,',
          '    HealthExtRequest, ModelChatExtRequest, NewSessionOutcome, OrchestrateExtRequest,',
          '    OrchestrateResumeExtRequest, WarmupExtRequest, WebFetchExtRequest, WebSearchExtRequest,',
          '    spawn_acp_client,',
          '};',
        ),
      },
      {
        find: L(
          'pub struct AcpHost {',
          '    handle: AcpClientHandle,',
          '    approvals: ApprovalRegistry,',
          '    /// `thread_id ↔ ACP SessionId` 映射（对齐 Zed `session_id = thread.id()`）。',
          '    sessions: Arc<Mutex<HashMap<String, SessionId>>>,',
          '}',
        ),
        replace: L(
          'pub struct AcpHost {',
          '    handle: AcpClientHandle,',
          '    approvals: ApprovalRegistry,',
          '    /// `thread_id ↔ ACP SessionId` 映射（对齐 Zed `session_id = thread.id()`）。',
          '    sessions: Arc<Mutex<HashMap<String, SessionId>>>,',
          '    /// `thread_id ↔ 会话建立时 agent 公示的可用模式清单`（ACP `NewSessionResponse.modes`',
          '    /// 原样 JSON：`currentModeId` + `availableModes[]`）。最小透传，宿主侧不重建 SDK 类型。',
          '    modes_by_thread: Arc<Mutex<HashMap<String, serde_json::Value>>>,',
          '}',
        ),
      },
      {
        find: L(
          '        let handle = spawn_acp_client(config, sink, resolver)?;',
          '        Ok(Self {',
          '            handle,',
          '            approvals,',
          '            sessions: Arc::new(Mutex::new(HashMap::new())),',
          '        })',
        ),
        replace: L(
          '        let handle = spawn_acp_client(config, sink, resolver)?;',
          '        Ok(Self {',
          '            handle,',
          '            approvals,',
          '            sessions: Arc::new(Mutex::new(HashMap::new())),',
          '            modes_by_thread: Arc::new(Mutex::new(HashMap::new())),',
          '        })',
        ),
      },
      {
        find: L(
          '        let cwd = workspace_cwd(workspace_root_path);',
          '        let session_id = self.handle.new_session(cwd).await?;',
          '        if !thread_key.is_empty() {',
          '            self.sessions',
          '                .lock()',
          '                .insert(thread_key.to_string(), session_id.clone());',
          '        }',
          '        Ok(session_id)',
        ),
        replace: L(
          '        let cwd = workspace_cwd(workspace_root_path);',
          '        let outcome = self.handle.new_session(cwd).await?;',
          '        let session_id = outcome.session_id;',
          '        if !thread_key.is_empty() {',
          '            self.sessions',
          '                .lock()',
          '                .insert(thread_key.to_string(), session_id.clone());',
          '            // 仅在 agent 公示了模式时登记；缺省不占位（保持 None 语义）。',
          '            if let Some(modes) = outcome.modes {',
          '                self.modes_by_thread',
          '                    .lock()',
          '                    .insert(thread_key.to_string(), modes);',
          '            }',
          '        }',
          '        Ok(session_id)',
        ),
      },
      {
        find: L(
          '        self.handle',
          '            .set_session_mode(session_id, SessionModeId::from(mode_id.to_string()))',
          '            .await?;',
          '        Ok(true)',
          '    }',
        ),
        replace: L(
          '        self.handle',
          '            .set_session_mode(session_id, SessionModeId::from(mode_id.to_string()))',
          '            .await?;',
          '        Ok(true)',
          '    }',
          '',
          '    /// 取某线程会话建立时 agent 公示的可用模式清单（ACP `NewSessionResponse.modes` 原样',
          '    /// JSON：`currentModeId` + `availableModes[]`）。未绑定会话 / agent 未公示模式时为 `None`。',
          '    /// 最小透传：宿主侧不重建 SDK 类型，交前端 ACL 解释（供 D7-③-c 模式选择器消费）。',
          '    pub fn session_modes(&self, thread_id: &str) -> Option<serde_json::Value> {',
          '        let thread_key = thread_id.trim();',
          '        if thread_key.is_empty() {',
          '            return None;',
          '        }',
          '        self.modes_by_thread.lock().get(thread_key).cloned()',
          '    }',
        ),
      },
    ],
  },
];

let changed = 0;
let skipped = 0;
for (const file of FILES) {
  const abs = resolve(ROOT, file.path);
  const original = readFileSync(abs, 'utf8');
  if (original.includes(file.skipIf)) {
    console.log(`skip  ${file.path} (already applied: ${file.skipIf})`);
    skipped += 1;
    continue;
  }
  const usesCrlf = original.includes('\r\n');
  let work = usesCrlf ? original.replace(/\r\n/g, '\n') : original;
  file.steps.forEach((step, index) => {
    const count = work.split(step.find).length - 1;
    if (count !== 1) {
      throw new Error(
        `expected exactly 1 anchor in ${file.path} (step ${index + 1}), found ${count}:\n--- anchor ---\n${step.find}`,
      );
    }
    work = work.replace(step.find, () => step.replace);
  });
  const next = usesCrlf ? work.replace(/\n/g, '\r\n') : work;
  writeFileSync(abs, next, 'utf8');
  console.log(`patch ${file.path} (${file.steps.length} steps)`);
  changed += 1;
}
console.log(`\nDone. patched=${changed} skipped=${skipped}`);

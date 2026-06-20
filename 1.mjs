import { readFileSync, writeFileSync } from 'node:fs';

// ── 目标文件 ───────────────────────────────────────────────────────────────
const RS_CONTRACTS = 'src-tauri/src/commands/contracts/agent_sidecar.rs';
const RS_CMD = 'src-tauri/src/commands/agent_sidecar.rs';
const RS_HOST = 'src-tauri/src/acp/host.rs';
const TS_TYPES = 'src/types/ai/sidecar.ts';
const TS_COMPOSABLE = 'src/composables/ai/useAiAssistant.ts';
const TS_SPEC = 'src/composables/ai/useAiAssistant.spec.ts';

const edits = [
  // ══════════════════════════════════════════════════════════════════════
  // 1) 契约层：AgentExternalChatRequest 增加 session_id（前端预生成流式关联键）
  // ══════════════════════════════════════════════════════════════════════
  {
    file: RS_CONTRACTS,
    find: `pub struct AgentExternalChatRequest {
    pub(crate) backend: AgentBackendKind,
    pub(crate) text: String,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) thread_id: Option<String>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
}`,
    replace: `pub struct AgentExternalChatRequest {
    pub(crate) backend: AgentBackendKind,
    pub(crate) text: String,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) thread_id: Option<String>,
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) workspace_root_path: Option<String>,
    /// 前端预生成的流式关联键（形如 sidecar:assistantMessageId）。外部 agent 经标准
    /// session/prompt 回合发出的 session/update 帧本以 ACP 会话 UUID 标记，前端在回合
    /// 终了前无从得知该 UUID，导致整轮 live 帧被前端按预生成键过滤丢弃、末尾一次性渲染。
    /// 命令层据此键在宿主侧把外部帧的 session_id 重写为该前端已知键（见 acp/host.rs 的
    /// prompt_with_stream_key），实现真正的逐 token 流式。缺省/空白时回退到 ACP 会话 id。
    #[serde(skip_serializing_if = "is_blank_optional_string")]
    pub(crate) session_id: Option<String>,
}`,
  },
  {
    file: RS_CONTRACTS,
    find: `    use super::{
        AgentSidecarAskUserAnswerPayload, AgentSidecarAskUserResumeRequest,
        AgentSidecarChatRequest, AgentSidecarCheckpointRestoreRequest, AgentSidecarMessagePayload,
        AgentSidecarRollbackStepPath,
    };`,
    replace: `    use super::{
        AgentBackendKind, AgentExternalChatRequest, AgentSidecarAskUserAnswerPayload,
        AgentSidecarAskUserResumeRequest, AgentSidecarChatRequest,
        AgentSidecarCheckpointRestoreRequest, AgentSidecarMessagePayload,
        AgentSidecarRollbackStepPath,
    };`,
  },
  {
    file: RS_CONTRACTS,
    find: `        assert_eq!(object.get("optionIds"), Some(&Value::Array(vec![])));
        assert!(!object.contains_key("text"));
    }
}`,
    replace: `        assert_eq!(object.get("optionIds"), Some(&Value::Array(vec![])));
        assert!(!object.contains_key("text"));
    }

    #[test]
    fn external_chat_request_omits_blank_session_and_serializes_present_session() {
        let omitted = AgentExternalChatRequest {
            backend: AgentBackendKind::Kimi,
            text: "继续".to_string(),
            thread_id: None,
            workspace_root_path: None,
            session_id: Some("  ".to_string()),
        };

        let omitted_object = serialize_object(&omitted);

        assert!(!omitted_object.contains_key("sessionId"));
        assert!(!omitted_object.contains_key("threadId"));
        assert!(!omitted_object.contains_key("workspaceRootPath"));
        assert_eq!(
            omitted_object.get("backend"),
            Some(&Value::String("kimi".to_string()))
        );
        assert_eq!(
            omitted_object.get("text"),
            Some(&Value::String("继续".to_string()))
        );

        let present = AgentExternalChatRequest {
            backend: AgentBackendKind::Kimi,
            text: "继续".to_string(),
            thread_id: Some("thread-external-1".to_string()),
            workspace_root_path: None,
            session_id: Some("sidecar:assistant-1".to_string()),
        };

        let present_object = serialize_object(&present);

        assert_eq!(
            present_object.get("sessionId"),
            Some(&Value::String("sidecar:assistant-1".to_string()))
        );
        assert_eq!(
            present_object.get("threadId"),
            Some(&Value::String("thread-external-1".to_string()))
        );
    }
}`,
  },

  // ══════════════════════════════════════════════════════════════════════
  // 2) 命令层：external_chat 透传 session_id，改用 prompt_with_stream_key
  // ══════════════════════════════════════════════════════════════════════
  {
    file: RS_CMD,
    find: `    let AgentExternalChatRequest {
        text,
        thread_id,
        workspace_root_path,
        ..
    } = payload;
    let thread_id = thread_id.as_deref().unwrap_or_default();
    let workspace_root_path = workspace_root_path.as_deref();

    // 把一轮回合收敛成单个 Result，便于在命令边界统一处置失败：ensure_session / prompt 共享
    // 同一条 ACP 连接，任一步失败都按同一策略（驱逐失效宿主 + 翻译提示）处理。
    let outcome: Result<AgentExternalChatResultPayload, crate::acp::AcpClientError> = async {
        let session_id = host.ensure_session(thread_id, workspace_root_path).await?;
        let stop_reason = host
            .prompt(
                thread_id,
                workspace_root_path,
                vec![ContentBlock::Text(TextContent::new(text))],
            )
            .await?;
        Ok(AgentExternalChatResultPayload {
            session_id: session_id.to_string(),
            stop_reason: format!("{stop_reason:?}"),
        })
    }
    .await;`,
    replace: `    let AgentExternalChatRequest {
        text,
        thread_id,
        workspace_root_path,
        session_id: client_stream_session_id,
        ..
    } = payload;
    let thread_id = thread_id.as_deref().unwrap_or_default();
    let workspace_root_path = workspace_root_path.as_deref();

    // 把一轮回合收敛成单个 Result，便于在命令边界统一处置失败：ensure_session / prompt 共享
    // 同一条 ACP 连接，任一步失败都按同一策略（驱逐失效宿主 + 翻译提示）处理。
    let outcome: Result<AgentExternalChatResultPayload, crate::acp::AcpClientError> = async {
        // 先解析稳定 ACP 会话（thread_id ↔ SessionId，跨回合复用），作为回退用的会话 id。
        let acp_session_id = host.ensure_session(thread_id, workspace_root_path).await?;

        // 流式关联键：优先用前端预生成的 session_id（= sidecar:assistantMessageId），它在发起
        // 回合前就已知、可被 subscribeSidecarSessionStream 即时订阅；外部 agent 发出的
        // session/update 帧本身以 ACP 会话 UUID 标记，由宿主 sink 依此键重写后再下发（见
        // host.prompt_with_stream_key），使前端按预生成键过滤即可实时收帧。缺省/空白时回退到
        // ACP 会话 id（与旧行为一致）。
        let stream_session_id = client_stream_session_id
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| acp_session_id.to_string());

        let stop_reason = host
            .prompt_with_stream_key(
                thread_id,
                workspace_root_path,
                vec![ContentBlock::Text(TextContent::new(text))],
                Some(stream_session_id.as_str()),
            )
            .await?;
        Ok(AgentExternalChatResultPayload {
            session_id: stream_session_id,
            stop_reason: format!("{stop_reason:?}"),
        })
    }
    .await;`,
  },

  // ══════════════════════════════════════════════════════════════════════
  // 3) 宿主层 host.rs：重写表字段 + sink 重写 + prompt_with_stream_key
  // ══════════════════════════════════════════════════════════════════════
  // 3a 结构体字段
  {
    file: RS_HOST,
    find: `    /// 最小透传，宿主侧不重建 SDK 类型，与 modes_by_thread 同构。
    config_options_by_thread: Arc<Mutex<HashMap<String, serde_json::Value>>>,
}`,
    replace: `    /// 最小透传，宿主侧不重建 SDK 类型，与 modes_by_thread 同构。
    config_options_by_thread: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    /// ACP 会话 id ↔ 前端流式关联键 的重写表（仅外部 agent 标准 prompt 回合用）。
    /// 外部 agent 发出的 session/update 帧以 ACP 会话 UUID 标记，而前端按预生成的
    /// sidecar:assistantMessageId 键过滤订阅；prompt_with_stream_key 在回合期间登记
    /// 「acp_session_id → 前端键」，sink 据此把外部帧的 session_id 重写为前端键后再下发，
    /// 回合结束即移除。无登记时 sink 原样透传（内置边车帧自带前端键，不命中重写表，行为不变）。
    stream_key_overrides: Arc<Mutex<HashMap<String, String>>>,
}`,
  },
  // 3b spawn：装配重写表，sink 改为条件重写
  {
    file: RS_HOST,
    find: `        // 单一下沉口：把每条 \`session/update\` 帧原样转发给 emit 闭包。
        // 帧 → 前端 TAgentUiEvent 的投影由接线层的 emit（runtime::stream_emitter）统一负责：
        // 它经 ui_event::session_notification_to_ui_event 投影，并对无对应 UI 事件的变体
        // （tool_call(_update)/plan/usage_update/current_mode_update 等）返回 None 跳过、不下发。
        // 此处不得再投影，否则会对已投影帧二次投影（其 event 已无 update.sessionUpdate 字段）
        // 必返回 None 而被丢弃，导致各模式 live 增量为零、气泡无流式。
        // 终态 done/error 不走 session/update，由 chat_stream 经 app.emit 直接合成补发。
        let sink: EventSink = Arc::new(move |frame: AcpStreamFrame| emit(frame));

        let handle = spawn_acp_client(config, sink, resolver)?;
        Ok(Self {
            handle,
            approvals,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            modes_by_thread: Arc::new(Mutex::new(HashMap::new())),
            config_options_by_thread: Arc::new(Mutex::new(HashMap::new())),
        })`,
    replace: `        // 外部 agent 帧重写表：sink 在转发前依此把「ACP 会话 UUID」标记重写为前端预生成键。
        let stream_key_overrides = Arc::new(Mutex::new(HashMap::new()));
        let overrides_for_sink = stream_key_overrides.clone();

        // 单一下沉口：把每条 session/update 帧转发给 emit 闭包，但在转发前按 stream_key_overrides
        // 重写外部 agent 帧的 session_id（ACP UUID → 前端预生成键）。仅当该帧的 ACP 会话 id 命中
        // 重写表才改写（外部 prompt 回合期间登记），否则原样透传——内置边车帧自带前端键、不命中
        // 重写表，行为不变。其余投影语义同前：帧 → 前端 TAgentUiEvent 的投影由接线层的 emit
        // （runtime::stream_emitter）统一负责，本层不得再投影；终态 done/error 不走 session/update，
        // 由 chat_stream 经 app.emit 直接合成补发。
        let sink: EventSink = Arc::new(move |mut frame: AcpStreamFrame| {
            let remapped_stream_key = frame
                .session_id
                .as_deref()
                .and_then(|acp_session_id| overrides_for_sink.lock().get(acp_session_id).cloned());
            if let Some(stream_key) = remapped_stream_key {
                frame.session_id = Some(stream_key);
            }
            emit(frame)
        });

        let handle = spawn_acp_client(config, sink, resolver)?;
        Ok(Self {
            handle,
            approvals,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            modes_by_thread: Arc::new(Mutex::new(HashMap::new())),
            config_options_by_thread: Arc::new(Mutex::new(HashMap::new())),
            stream_key_overrides,
        })`,
  },
  // 3c prompt 委托 + 新增 prompt_with_stream_key
  {
    file: RS_HOST,
    find: `    pub async fn prompt(
        &self,
        thread_id: &str,
        workspace_root_path: Option<&str>,
        blocks: Vec<ContentBlock>,
    ) -> Result<StopReason, AcpClientError> {
        let session_id = self.ensure_session(thread_id, workspace_root_path).await?;
        self.handle.prompt(session_id, blocks).await
    }`,
    replace: `    pub async fn prompt(
        &self,
        thread_id: &str,
        workspace_root_path: Option<&str>,
        blocks: Vec<ContentBlock>,
    ) -> Result<StopReason, AcpClientError> {
        self.prompt_with_stream_key(thread_id, workspace_root_path, blocks, None)
            .await
    }

    /// 同 prompt，但额外接受前端预生成的「流式关联键」用于帧重写（外部 ACP agent 专用）。
    ///
    /// 背景：外部 agent 发出的 session/update 帧以 ACP 会话 UUID 标记，而前端在回合发起前只知道
    /// 自造的 sidecar:assistantMessageId 键并据此订阅过滤。若不重写，整轮 live 帧会被前端丢弃、
    /// 退化为末尾一次性渲染。
    ///
    /// 实现：解析/复用会话拿到 ACP 会话 id 后，若调用方提供了非空且不等于 ACP id 的 stream_key，
    /// 就在重写表登记「acp_session_id → stream_key」（sink 据此重写外部帧的 session_id），跑完
    /// prompt 后立即移除该登记（无论成败），把重写作用域严格限定在本回合。stream_key 为 None /
    /// 空白 / 恰等于 ACP id 时不登记，sink 原样透传（行为同旧 prompt）。
    pub async fn prompt_with_stream_key(
        &self,
        thread_id: &str,
        workspace_root_path: Option<&str>,
        blocks: Vec<ContentBlock>,
        stream_key: Option<&str>,
    ) -> Result<StopReason, AcpClientError> {
        let session_id = self.ensure_session(thread_id, workspace_root_path).await?;
        let acp_session_id = session_id.to_string();

        let override_key = stream_key
            .map(str::trim)
            .filter(|key| !key.is_empty() && *key != acp_session_id.as_str());
        let registered = if let Some(key) = override_key {
            self.stream_key_overrides
                .lock()
                .insert(acp_session_id.clone(), key.to_string());
            true
        } else {
            false
        };

        let outcome = self.handle.prompt(session_id, blocks).await;

        if registered {
            self.stream_key_overrides.lock().remove(&acp_session_id);
        }

        outcome
    }`,
  },

  // ══════════════════════════════════════════════════════════════════════
  // 4) 前端类型：IAgentExternalChatRequest 增加 sessionId?
  // ══════════════════════════════════════════════════════════════════════
  {
    file: TS_TYPES,
    find: `export interface IAgentExternalChatRequest {
  backend: TAgentBackendKind;
  text: string;
  threadId?: string;
  workspaceRootPath?: string | null;
}`,
    replace: `export interface IAgentExternalChatRequest {
  backend: TAgentBackendKind;
  text: string;
  threadId?: string;
  workspaceRootPath?: string | null;
  /**
   * 前端预生成的流式关联键（形如 sidecar:assistantMessageId）。Rust 宿主据此把外部 agent
   * session/update 帧的 session_id 由 ACP 会话 UUID 重写为该键，使前端
   * subscribeSidecarSessionStream 能在回合进行中实时收帧（而非末尾一次性渲染）。
   * 缺省时后端回退到 ACP 会话 id。
   */
  sessionId?: string;
}`,
  },

  // ══════════════════════════════════════════════════════════════════════
  // 5) useAiAssistant.ts：外部 agent 链路改为「预订阅 + 透传 sessionId」
  // ══════════════════════════════════════════════════════════════════════
  // 5a 注释
  {
    file: TS_COMPOSABLE,
    find: `  // 外部 ACP 编码 agent（Kimi / Codex，ADR-0015）发送链路：经 agent_sidecar_external_chat
  // 驱动一轮标准 session/prompt。外部 agent 无富信封，过程增量经 session/update 帧走既有
  // sidecar 流（subscribeSidecarStreamWithPrebuffer + applySidecarLiveEventsToAgentMessage）；
  // prompt 返回即整轮结束，绑定会话并 flush 后把消息状态收口为 completed。`,
    replace: `  // 外部 ACP 编码 agent（Kimi / Codex，ADR-0015）发送链路：经 agent_sidecar_external_chat
  // 驱动一轮标准 session/prompt。外部 agent 无富信封，过程增量经 session/update 帧走既有
  // sidecar 流（subscribeSidecarSessionStream + applySidecarLiveEventsToAgentMessage）。
  // 流式关键：用前端预生成的 sidecarSessionId 在发起回合「之前」订阅，后端据此把外部帧的
  // session_id 由 ACP 会话 UUID 重写为该键（见 Rust host.prompt_with_stream_key），实现逐
  // token 实时渲染；prompt 返回即整轮结束，flush 后把消息状态收口为 completed。`,
  },
  // 5b 函数体
  {
    file: TS_COMPOSABLE,
    find: `    const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {
      if (requestAbortController.signal.aborted) {
        return;
      }
      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));
      applySidecarLiveEventsToAgentMessage(
        assistantMessageId,
        targetThreadId,
        initialActivityText,
        events,
      );
      updateLiveThreadFromSidecarEvents(assistantMessageId, targetThreadId, events);
    });
    let sidecarStream: Awaited<ReturnType<typeof subscribeSidecarStreamWithPrebuffer>> | null =
      null;

    try {
      sidecarStream = await subscribeSidecarStreamWithPrebuffer((event) => {
        if (requestAbortController.signal.aborted) {
          return;
        }
        liveEventBuffer.push(event);
      });

      const result = await aiService.sidecarExternalChat({
        backend,
        text: messageContent,
        workspaceRootPath: options.workspaceRootPath.value,
        ...(targetThreadId ? { threadId: targetThreadId } : {}),
      });

      sidecarStream.bind(result.sessionId);
      liveEventBuffer.flush();

      if (!requestAbortController.signal.aborted) {
        const currentMessage = findMessageById(assistantMessageId);
        updateAgentExecutionMessage({
          messageId: assistantMessageId,
          content: currentMessage?.content ?? '',
          toolCalls: currentMessage?.toolCalls ?? [],
          streamStatus: 'completed',
          finalAnswerStarted: hasMeaningfulAssistantText(currentMessage?.content),
        });
        commitDisplayMessagesToStore(targetThreadId);
      }

      if (!errorMessage.value) {
        clearAttachedFiles({ revokePreviews: false });
      }
    } catch (error) {
      if (requestAbortController.signal.aborted) {
        disposeSidecarAnswerStream(assistantMessageId);
      } else {
        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));
      }
    } finally {
      liveEventBuffer.dispose();
      sidecarStream?.dispose();
      activeAbortController.value = null;
      activeAgentMessageId.value = null;
      commitDisplayMessagesToStore(targetThreadId);
      clearActiveBufferedThread(targetThreadId);
      isSending.value = false;
      syncDisplayMessagesFromActiveThread();
    }`,
    replace: `    const sidecarSessionId = \`sidecar:\${assistantMessageId}\`;
    const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {
      if (requestAbortController.signal.aborted) {
        return;
      }
      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));
      applySidecarLiveEventsToAgentMessage(
        assistantMessageId,
        targetThreadId,
        initialActivityText,
        events,
      );
      updateLiveThreadFromSidecarEvents(assistantMessageId, targetThreadId, events);
    });
    let unlistenSidecarStream: (() => void) | null = null;

    try {
      // 关键修复（外部 Kimi 流式）：用前端预生成的 sidecarSessionId 在发起回合「之前」订阅该
      // 会话的 session/update 帧。后端据此把外部 agent 帧的 session_id 由 ACP 会话 UUID 重写为
      // 该键（见 Rust host.prompt_with_stream_key），使本订阅即时命中、逐 token 实时渲染——
      // 取代旧的「subscribeSidecarStreamWithPrebuffer + 回合结束后 bind(result.sessionId)」末尾
      // 一次性回放。
      unlistenSidecarStream = await subscribeSidecarSessionStream(sidecarSessionId, (event) => {
        if (requestAbortController.signal.aborted) {
          return;
        }
        liveEventBuffer.push(event);
      });

      await aiService.sidecarExternalChat({
        backend,
        text: messageContent,
        sessionId: sidecarSessionId,
        workspaceRootPath: options.workspaceRootPath.value,
        ...(targetThreadId ? { threadId: targetThreadId } : {}),
      });

      liveEventBuffer.flush();
      unlistenSidecarStream?.();
      unlistenSidecarStream = null;

      if (!requestAbortController.signal.aborted) {
        const currentMessage = findMessageById(assistantMessageId);
        updateAgentExecutionMessage({
          messageId: assistantMessageId,
          content: currentMessage?.content ?? '',
          toolCalls: currentMessage?.toolCalls ?? [],
          streamStatus: 'completed',
          finalAnswerStarted: hasMeaningfulAssistantText(currentMessage?.content),
        });
        commitDisplayMessagesToStore(targetThreadId);
      }

      if (!errorMessage.value) {
        clearAttachedFiles({ revokePreviews: false });
      }
    } catch (error) {
      if (requestAbortController.signal.aborted) {
        disposeSidecarAnswerStream(assistantMessageId);
      } else {
        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));
      }
    } finally {
      liveEventBuffer.dispose();
      unlistenSidecarStream?.();
      activeAbortController.value = null;
      activeAgentMessageId.value = null;
      commitDisplayMessagesToStore(targetThreadId);
      clearActiveBufferedThread(targetThreadId);
      isSending.value = false;
      syncDisplayMessagesFromActiveThread();
    }`,
  },

  // ══════════════════════════════════════════════════════════════════════
  // 6) useAiAssistant.spec.ts：补外部 chat mock + 新增实时流式断言
  // ══════════════════════════════════════════════════════════════════════
  // 6a 类型 import
  {
    file: TS_SPEC,
    find: `import type {
  IAgentSidecarChatRequest,
  IAgentSidecarCheckpointRestoreRequest,
  IAgentSidecarOrchestrateRequest,
  IAgentSidecarOrchestrateResumeRequest,
  IAgentSidecarResponsePayload,
  IAgentSidecarStreamEventPayload,
  TJsonValue,
} from '@/types/ai/sidecar';`,
    replace: `import type {
  IAgentExternalChatRequest,
  IAgentExternalChatResultPayload,
  IAgentSidecarChatRequest,
  IAgentSidecarCheckpointRestoreRequest,
  IAgentSidecarOrchestrateRequest,
  IAgentSidecarOrchestrateResumeRequest,
  IAgentSidecarResponsePayload,
  IAgentSidecarStreamEventPayload,
  TJsonValue,
} from '@/types/ai/sidecar';`,
  },
  // 6b hoisted mock 函数
  {
    file: TS_SPEC,
    find: `  const sidecarExecute = vi.fn(async (payload: IAgentSidecarChatRequest) =>
    createSidecarExecuteResponse(payload.goal),
  );

  const sidecarResolveApproval = vi.fn(async () => ({`,
    replace: `  const sidecarExecute = vi.fn(async (payload: IAgentSidecarChatRequest) =>
    createSidecarExecuteResponse(payload.goal),
  );

  const sidecarExternalChat = vi.fn<
    (payload: IAgentExternalChatRequest) => Promise<IAgentExternalChatResultPayload>
  >(async (payload) => ({
    sessionId: payload.sessionId ?? 'sidecar-external-session-1',
    stopReason: 'EndTurn',
  }));

  const sidecarResolveApproval = vi.fn(async () => ({`,
  },
  // 6c hoisted 返回对象
  {
    file: TS_SPEC,
    find: `    sidecarChat: sidecarExecute,
    sidecarExecute,
    sidecarResolveApproval,`,
    replace: `    sidecarChat: sidecarExecute,
    sidecarExecute,
    sidecarExternalChat,
    sidecarResolveApproval,`,
  },
  // 6d reset()
  {
    file: TS_SPEC,
    find: `      sidecarExecute.mockClear();
      sidecarResolveApproval.mockClear();`,
    replace: `      sidecarExecute.mockClear();
      sidecarExternalChat.mockClear();
      sidecarResolveApproval.mockClear();`,
  },
  // 6e vi.mock 工厂
  {
    file: TS_SPEC,
    find: `    sidecarChat: aiServiceMock.sidecarChat,
    sidecarExecute: aiServiceMock.sidecarExecute,
    sidecarResolveApproval: aiServiceMock.sidecarResolveApproval,`,
    replace: `    sidecarChat: aiServiceMock.sidecarChat,
    sidecarExecute: aiServiceMock.sidecarExecute,
    sidecarExternalChat: aiServiceMock.sidecarExternalChat,
    sidecarResolveApproval: aiServiceMock.sidecarResolveApproval,`,
  },
  // 6f 新增测试
  {
    file: TS_SPEC,
    find: `    expect(assistant.revertingChangedFilesSummaryId.value).toBeNull();
  });
});`,
    replace: `    expect(assistant.revertingChangedFilesSummaryId.value).toBeNull();
  });

  it('外部 Kimi agent 回合在 prompt 进行中实时流式 message_delta（而非末尾一次性渲染）', async () => {
    const { assistant } = createAssistantHarnessContext();
    const promptGate = createDeferred<IAgentExternalChatResultPayload>();
    let capturedRequest: IAgentExternalChatRequest | null = null;

    aiServiceMock.sidecarExternalChat.mockImplementationOnce(async (payload) => {
      capturedRequest = payload;
      const sessionId = payload.sessionId ?? 'sidecar-external-live-session';

      aiServiceMock.emitSidecar({
        sessionId,
        seq: 0,
        event: { type: 'message_delta', text: '第一段已到达', phase: 'final' },
      });
      aiServiceMock.emitSidecar({
        sessionId,
        seq: 1,
        event: { type: 'message_delta', text: '；第二段实时到达', phase: 'final' },
      });

      // 在回合「进行中」（prompt 尚未返回）阻塞：断言此刻已实时渲染增量、状态仍为 streaming。
      await promptGate.promise;

      return { sessionId, stopReason: 'EndTurn' };
    });

    assistant.draft.value = '用 Kimi 跑一轮';
    const sendPromise = assistant.sendMessage({ agentBackend: 'kimi' });

    await flushMicrotasks();

    const assistantMessageId = assistant.messages.value[1]?.id;
    expect(assistantMessageId).toBeTruthy();
    expect(capturedRequest?.backend).toBe('kimi');
    expect(capturedRequest?.sessionId).toBe(\`sidecar:\${assistantMessageId}\`);
    expect(assistant.messages.value[1]?.content).toContain('第二段实时到达');
    expect(assistant.messages.value[1]?.stream?.status).toBe('streaming');

    promptGate.resolve({
      sessionId: capturedRequest?.sessionId ?? 'sidecar-external-live-session',
      stopReason: 'EndTurn',
    });
    await sendPromise;

    expect(assistant.messages.value[1]?.stream?.status).toBe('completed');
    expect(assistant.messages.value[1]?.content).toContain('第二段实时到达');
  });
});`,
  },
];

// ── 两遍式执行（EOL 自适配：LF / CRLF 均可，按文件原 EOL 写回）──────────────
const toCRLF = (s) => s.replace(/\n/g, '\r\n');

const working = new Map();
for (const f of new Set(edits.map((e) => e.file))) {
  working.set(f, readFileSync(f, 'utf8'));
}

const errors = [];
edits.forEach((e, i) => {
  const cur = working.get(e.file);

  const lfHits = cur.split(e.find).length - 1;
  if (lfHits === 1) {
    working.set(e.file, cur.replace(e.find, () => e.replace));
    return;
  }

  const findCRLF = toCRLF(e.find);
  const crlfHits = cur.split(findCRLF).length - 1;
  if (crlfHits === 1) {
    working.set(e.file, cur.replace(findCRLF, () => toCRLF(e.replace)));
    return;
  }

  errors.push(`#${i + 1} ${e.file}: 期望命中 1 处，实际 LF=${lfHits} / CRLF=${crlfHits} 处`);
});

if (errors.length > 0) {
  console.error('未写入任何文件。以下改动锚点校验失败：\n' + errors.join('\n'));
  process.exit(1);
}

for (const [f, content] of working) {
  writeFileSync(f, content);
  console.log('已写入：', f);
}
console.log('全部 ' + edits.length + ' 处改动完成。');
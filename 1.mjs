import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ?? process.cwd();
const toLf = (s) => s.replace(/\r\n/g, "\n");
const t = (...lines) => lines.join("\n");
const read = (rel) => toLf(readFileSync(join(ROOT, rel), "utf8"));
const write = (rel, content) => {
  writeFileSync(join(ROOT, rel), content, "utf8");
  console.log("✔ wrote", rel);
};

function patch(content, label, anchor, replacement) {
  const i = content.indexOf(anchor);
  if (i === -1) throw new Error("[" + label + "] 锚点未找到");
  if (content.indexOf(anchor, i + anchor.length) !== -1) throw new Error("[" + label + "] 锚点不唯一");
  return content.slice(0, i) + replacement + content.slice(i + anchor.length);
}

function replaceRange(content, label, startAnchor, endKeepAnchor, replacement = "") {
  const s = content.indexOf(startAnchor);
  if (s === -1) throw new Error("[" + label + "] start 锚点未找到");
  if (content.indexOf(startAnchor, s + startAnchor.length) !== -1) throw new Error("[" + label + "] start 锚点不唯一");
  const e = content.indexOf(endKeepAnchor, s);
  if (e === -1) throw new Error("[" + label + "] endKeep 锚点未找到（须在 start 之后）");
  return content.slice(0, s) + replacement + content.slice(e);
}

const edit = (rel, fn) => write(rel, fn(read(rel)));
const overwrite = (rel, content) => write(rel, content.endsWith("\n") ? content : content + "\n");

// ============================================================================
// 1. src-tauri/src/acp/client.rs —— set_session_config_option 回传 configOptions
// ============================================================================
edit("src-tauri/src/acp/client.rs", (c) => {
  // 1a: Command::SetSessionConfigOption.reply 改回传 Option<Value>
  c = patch(
    c,
    "client.1a",
    t(
      "        value: SessionConfigOptionValue,",
      "        reply: oneshot::Sender<Result<(), String>>,"
    ),
    t(
      "        value: SessionConfigOptionValue,",
      "        reply: oneshot::Sender<Result<Option<Value>, String>>,"
    )
  );

  // 1b: AcpClientHandle::set_session_config_option 返回类型
  c = patch(
    c,
    "client.1b",
    t(
      "        config_id: String,",
      "        value: String,",
      "    ) -> Result<(), AcpClientError> {"
    ),
    t(
      "        config_id: String,",
      "        value: String,",
      "    ) -> Result<Option<Value>, AcpClientError> {"
    )
  );

  // 1c: 命令循环中提取 set 响应的 configOptions（camelCase wire；缺失/null → None）
  c = patch(
    c,
    "client.1c",
    "                            let _ = reply.send(res.map(|_| ()).map_err(|e| e.to_string()));",
    t(
      "                            // 最小透传：set_config_option 响应携带的 configOptions（切换后",
      "                            // 完整快照）原样序列化回传（camelCase wire；缺失/null → None），",
      "                            // 宿主侧据 thread_id 更新缓存并回传前端即时快照。",
      "                            let outcome = res.map(|r| {",
      "                                serde_json::to_value(&r)",
      "                                    .ok()",
      "                                    .and_then(|v| v.get(\"configOptions\").cloned())",
      "                                    .filter(|v| !v.is_null())",
      "                            });",
      "                            let _ = reply.send(outcome.map_err(|e| e.to_string()));"
    )
  );

  return c;
});

// ============================================================================
// 2. src-tauri/src/acp/host.rs —— 删除事件通道发现装置，set 返回快照
// ============================================================================
edit("src-tauri/src/acp/host.rs", (c) => {
  // 2a: 删除结构体字段 config_options_by_session + config_stream_by_session（含文档）
  c = replaceRange(
    c,
    "host.2a",
    "    /// ACP 会话 id ↔ 该会话最近一次 config_option_update 的 configOptions 原始数组（含模型选择器）。",
    "    /// 流式帧下沉口克隆：供回合发起时主动以前端键重放缓存的可用命令（sink 内重写表只在帧自然到达"
  );

  // 2b: 删除 spawn 内 config_options/config_stream 本地变量 + emit_for_sink_route
  c = replaceRange(
    c,
    "host.2b",
    "        // 与可用命令同构：外部 agent 一次性下发的可配置项缓存（按 ACP 会话 id）：sink 无条件捕获，重放于回合发起。",
    "        // emit 克隆留给宿主侧主动重放（sink 内的重写表只在帧自然到达时生效）。"
  );

  // 2c: sink 体改为「仅缓存可用命令」（let-chain，Rust 2024）；配置项不再走此通道
  c = replaceRange(
    c,
    "host.2c",
    "            // 先按「原始 ACP 会话 id」捕获一次性下发的 available_commands_update / config_option_update，",
    "            let remapped_stream_key = frame",
    t(
      "            // 先按「原始 ACP 会话 id」捕获外部 agent 一次性下发的 available_commands_update，缓存供",
      "            // 回合发起时以前端键重放（取键须在重写 session_id 之前，键须为 ACP 会话 UUID）；以 as_deref",
      "            // 借用避免每帧对 session_id 的冗余克隆。配置项发现不在此通道：统一以 session/new 响应快照",
      "            // 为唯一来源，回合内的 config_option_update 经标准转发投影由前端消费。",
      "            if let Some(acp_session_id) = frame.session_id.as_deref()",
      "                && let Some(commands) = extract_available_commands_update(&frame.event)",
      "            {",
      "                commands_cache_for_sink",
      "                    .lock()",
      "                    .insert(acp_session_id.to_string(), commands);",
      "            }",
      "",
      ""
    )
  );

  // 2d: Self{} 构造去掉两个字段
  c = patch(
    c,
    "host.2d",
    t(
      "            available_commands_by_session,",
      "            config_options_by_session,",
      "            config_stream_by_session,",
      "            emit: emit_for_host,"
    ),
    t(
      "            available_commands_by_session,",
      "            emit: emit_for_host,"
    )
  );

  // 2e: prompt_with_stream_key 去掉 replay_config_options 调用
  c = patch(
    c,
    "host.2e",
    t(
      "            // 重写已登记 + 前端回合订阅已建立：以前端键重放缓存的可用命令与可配置项，面板/选择器即时填充。",
      "            self.replay_available_commands(&acp_session_id, key);",
      "            self.replay_config_options(&acp_session_id, key);",
      "            true"
    ),
    t(
      "            // 重写已登记 + 前端回合订阅已建立：以前端键重放缓存的可用命令，命令面板即时填充。",
      "            self.replay_available_commands(&acp_session_id, key);",
      "            true"
    )
  );

  // 2f: 删除 replay_config_options 方法
  c = replaceRange(
    c,
    "host.2f",
    "    /// 把某 ACP 会话已缓存的 config_options 以前端流式键重放一帧 config_option_update。",
    "    /// 用纯文本驱动一轮**标准 ACP 回合**：把单段文本包成一个 `text` `ContentBlock` 后委托"
  );

  // 2g: host.set_session_config_option 返回切换后配置项快照（响应优先，回退缓存）
  c = replaceRange(
    c,
    "host.2g",
    "    /// 切换指定线程当前 ACP 会话的某个配置项值（标准 session/set_config_option 请求）。",
    "    /// 取某线程会话建立时 agent 公示的可用配置项清单（ACP NewSessionResponse.config_options",
    t(
      "    /// 切换指定线程当前 ACP 会话的某个配置项值（标准 session/set_config_option 请求）。",
      "    ///",
      "    /// 仅在本宿主已绑定该 thread_id 的会话时执行——命中则下发 session/set_config_option，并返回该",
      "    /// 请求响应携带的「切换后完整配置项快照」（ACP SetSessionConfigOptionResponse.config_options",
      "    /// 原样 JSON；agent 未在响应回填时回退到本宿主缓存的 session/new 快照）。未绑定（空 thread /",
      "    /// 无映射）返回 Ok(None) 作为安全空操作，交由 runtime 广播给真正持有该线程的后端宿主。绝不在此",
      "    /// ensure_session 新建会话——配置项切换只对既有会话有意义。",
      "    pub async fn set_session_config_option(",
      "        &self,",
      "        thread_id: &str,",
      "        config_id: &str,",
      "        value_id: &str,",
      "    ) -> Result<Option<serde_json::Value>, AcpClientError> {",
      "        let thread_key = thread_id.trim();",
      "        if thread_key.is_empty() {",
      "            return Ok(None);",
      "        }",
      "        let session_id = self.sessions.lock().get(thread_key).cloned();",
      "        let Some(session_id) = session_id else {",
      "            return Ok(None);",
      "        };",
      "        let updated = self",
      "            .handle",
      "            .set_session_config_option(session_id, config_id.to_string(), value_id.to_string())",
      "            .await?;",
      "        // 响应携带切换后的完整配置项快照时，更新本线程缓存（保持 session_config_options 与最新值一致）。",
      "        if let Some(config_options) = updated.clone() {",
      "            self.config_options_by_thread",
      "                .lock()",
      "                .insert(thread_key.to_string(), config_options);",
      "        }",
      "        // 优先返回响应快照；agent 未回填时回退到缓存快照（既有会话必有 session/new 快照）。",
      "        Ok(updated.or_else(|| self.config_options_by_thread.lock().get(thread_key).cloned()))",
      "    }",
      "",
      ""
    )
  );

  // 2h: 删除 bind_config_stream 方法
  c = replaceRange(
    c,
    "host.2h",
    "    /// 为某线程的当前 ACP 会话绑定「会话级配置流」前端订阅键（约定 `config:{thread_id}`），用于在",
    "    /// 触发检查点回滚（扩展方法 `calamex.dev/checkpoint/restore`）。"
  );

  // 2i: 删除 extract_config_option_update + build_config_option_update_event 纯函数
  c = replaceRange(
    c,
    "host.2i",
    "/// 从一帧 session/update 事件 JSON 中提取 config_option_update 的 configOptions 数组。",
    "/// 修剪并过滤空白可选字符串：`None` / 空 / 全空白 → `None`，否则返回修剪后切片。"
  );

  // 2j: 删除 4 个 config_option 相关单测
  c = replaceRange(
    c,
    "host.2j",
    t(
      "    #[test]",
      "    fn extract_config_option_update_returns_options_for_matching_frame() {"
    ),
    t(
      "    #[test]",
      "    fn non_empty_trims_and_filters_blank() {"
    )
  );

  return c;
});

// ============================================================================
// 3. src-tauri/src/acp/runtime.rs —— set 广播返回首个命中快照
// ============================================================================
edit("src-tauri/src/acp/runtime.rs", (c) => {
  // 3a: set_session_config_option 返回 Option<Value>（首个命中即返回）
  c = replaceRange(
    c,
    "runtime.3a",
    "    /// 切换指定线程当前 ACP 会话的某个配置项值（标准 session/set_config_option）。线程绑定的",
    "    /// 取某线程会话建立时 agent 公示的可用配置项清单（ACP NewSessionResponse.config_options",
    t(
      "    /// 切换指定线程当前 ACP 会话的某个配置项值（标准 session/set_config_option）。线程绑定的会话可能",
      "    /// 落在任一后端宿主，故向全部已建立宿主广播下发：返回首个命中宿主回传的「切换后完整配置项快照」",
      "    /// （ACP SetSessionConfigOptionResponse.config_options 原样 JSON）。无任何宿主 / 无匹配线程时返回",
      "    /// Ok(None)（安全空操作——配置项切换绝不应触发子进程派生）。至多一个宿主持有该线程，故某宿主下发",
      "    /// 失败即整体失败。",
      "    pub async fn set_session_config_option(",
      "        &self,",
      "        thread_id: &str,",
      "        config_id: &str,",
      "        value_id: &str,",
      "    ) -> Result<Option<serde_json::Value>, AcpClientError> {",
      "        // 先取出 Arc 列表并释放锁，避免在广播下发（跨 await）期间持有 runtime 锁。",
      "        let hosts = self.hosts.lock().all();",
      "        for host in hosts {",
      "            if let Some(config_options) = host",
      "                .set_session_config_option(thread_id, config_id, value_id)",
      "                .await?",
      "            {",
      "                return Ok(Some(config_options));",
      "            }",
      "        }",
      "        Ok(None)",
      "    }",
      "",
      ""
    )
  );

  // 3b: 空 runtime 单测断言改为 None
  c = patch(
    c,
    "runtime.3b",
    t(
      "        // 无任何宿主时，配置项切换为安全空操作：返回 Ok(false) 且绝不派生子进程。",
      "        let applied = tauri::async_runtime::block_on(",
      "            runtime.set_session_config_option(\"thread-1\", \"model\", \"gpt-5\"),",
      "        )",
      "        .expect(\"set_session_config_option on empty runtime should not error\");",
      "        assert!(!applied);"
    ),
    t(
      "        // 无任何宿主时，配置项切换为安全空操作：返回 Ok(None) 且绝不派生子进程。",
      "        let snapshot = tauri::async_runtime::block_on(",
      "            runtime.set_session_config_option(\"thread-1\", \"model\", \"gpt-5\"),",
      "        )",
      "        .expect(\"set_session_config_option on empty runtime should not error\");",
      "        assert!(snapshot.is_none());"
    )
  );

  return c;
});

// ============================================================================
// 4. src-tauri/src/commands/ai/gateway.rs —— ensure 回传快照、set 直回快照
// ============================================================================
edit("src-tauri/src/commands/ai/gateway.rs", (c) => {
  // 4a: ai_set_session_config_option 直接回传 set 响应快照
  c = replaceRange(
    c,
    "gateway.4a",
    "    let applied = runtime",
    "/// 握手并复用/建立某线程在指定后端上的 ACP 会话",
    t(
      "    // 切换后的权威配置项快照由 session/set_config_option 响应直接回传（agent 未回填时回退到",
      "    // 会话级缓存快照）；未命中任何已绑定会话则为 None。",
      "    let config_options = runtime",
      "        .set_session_config_option(thread_id, config_id, value_id)",
      "        .await",
      "        .map_err(|error| format!(\"AI_SET_SESSION_CONFIG_OPTION_FAILED: {error}\"))?;",
      "    Ok(config_options.map(|config_options| AiSessionConfigOptionsPayload { config_options }))",
      "}",
      "",
      ""
    )
  );

  // 4b: ai_ensure_acp_session 文档 + 返回类型
  c = replaceRange(
    c,
    "gateway.4b",
    "/// 握手并复用/建立某线程在指定后端上的 ACP 会话（v3 · 唯一标准管线）。",
    "    let thread_id = payload.thread_id.trim();",
    t(
      "/// 握手并复用/建立某线程在指定后端上的 ACP 会话，并回传 agent 在 session/new 响应公示的可用配置项",
      "/// 全集（v3 · 唯一标准管线）。",
      "///",
      "/// 配置项发现的唯一来源即此握手返回值：经 get_or_spawn_backend 懒建立目标后端宿主后 ensure_session",
      "/// 建立/复用会话，agent 在 session/new 响应里以 config_options 公示「模型 / 模式 / 思考强度等」可切换",
      "/// 配置项全集（含 currentValue 当前选中项），宿主据 thread_id 登记后由本命令原样回传前端选择器。会话",
      "/// 复用回合（已存在映射）不重发 session/new，则回退到宿主缓存的同一快照；agent 未公示任何配置项时",
      "/// 返回 None。后续 agent 主动发起的 config_option_update（标准回合内通知）经流式投影由前端增量并入，",
      "/// 不在此通道。thread_id / backend 先行校验；未知 backend 报错。",
      "#[tauri::command]",
      "#[specta::specta]",
      "pub async fn ai_ensure_acp_session(",
      "    app: AppHandle,",
      "    payload: AiEnsureAcpSessionRequest,",
      ") -> Result<Option<AiSessionConfigOptionsPayload>, String> {",
      ""
    )
  );

  // 4c: ai_ensure_acp_session 尾部改为回传 session/new 快照
  c = replaceRange(
    c,
    "gateway.4c",
    "    // 首个 prompt 之前即开放配置项发现：为该会话绑定稳定的「会话级配置流」前端订阅键",
    t(
      "#[tauri::command]",
      "#[specta::specta]",
      "pub async fn ai_inline_complete("
    ),
    t(
      "    // 配置项发现的唯一来源：回传 agent 在 session/new 响应公示的可用配置项全集（会话复用回合回退到",
      "    // 宿主缓存的同一快照；agent 未公示则为 None）。",
      "    Ok(host",
      "        .session_config_options(thread_id)",
      "        .map(|config_options| AiSessionConfigOptionsPayload { config_options }))",
      "}",
      "",
      ""
    )
  );

  return c;
});

// ============================================================================
// 5. src-tauri/src/commands/contracts/ai_chat.rs —— 仅同步握手请求文档
// ============================================================================
edit("src-tauri/src/commands/contracts/ai_chat.rs", (c) => {
  c = replaceRange(
    c,
    "contracts.5",
    "/// workspace_root_path 为新建会话的 cwd。握手仅建立/复用会话（触发外部 agent 在 session/new",
    t(
      "#[derive(Debug, Clone, Deserialize, Type)]",
      "#[serde(rename_all = \"camelCase\")]",
      "pub struct AiEnsureAcpSessionRequest {"
    ),
    t(
      "/// workspace_root_path 为新建会话的 cwd。握手建立/复用会话后，直接回传 agent 在 session/new 响应",
      "/// 公示的可用配置项全集（AiSessionConfigOptionsPayload）——这是配置项初始发现的唯一来源；后续 agent",
      "/// 主动发起的 config_option_update 经标准回合流式投影由前端增量并入。",
      ""
    )
  );
  return c;
});

// ============================================================================
// 6. src/services/tauri/ai.ts —— 不再吞掉返回值
// ============================================================================
edit("src/services/tauri/ai.ts", (c) => {
  c = patch(
    c,
    "tauri-ai.6",
    t(
      "  aiEnsureAcpSession: payloadCommand(AI_COMMAND_META.aiEnsureAcpSession, async (payload) => {",
      "    await commands.aiEnsureAcpSession(payload);",
      "  }),"
    ),
    t(
      "  aiEnsureAcpSession: payloadCommand(AI_COMMAND_META.aiEnsureAcpSession, (payload) =>",
      "    commands.aiEnsureAcpSession(payload),",
      "  ),"
    )
  );
  return c;
});

// ============================================================================
// 7. src/types/tauri/index.ts —— ITauriService 返回类型
// ============================================================================
edit("src/types/tauri/index.ts", (c) => {
  c = patch(
    c,
    "types-tauri.7",
    "  aiEnsureAcpSession(payload: IAiEnsureAcpSessionRequest): Promise<void>;",
    t(
      "  aiEnsureAcpSession(",
      "    payload: IAiEnsureAcpSessionRequest,",
      "  ): Promise<IAiSessionConfigOptionsPayload | null>;"
    )
  );
  return c;
});

// ============================================================================
// 8. src/services/ipc/ai.service.ts —— 服务层返回类型
// ============================================================================
edit("src/services/ipc/ai.service.ts", (c) => {
  c = patch(
    c,
    "ipc-ai.8",
    t(
      "  ensureAcpSession(payload: IAiEnsureAcpSessionRequest): Promise<void> {",
      "    return tauriService.aiEnsureAcpSession(payload);",
      "  },"
    ),
    t(
      "  ensureAcpSession(",
      "    payload: IAiEnsureAcpSessionRequest,",
      "  ): Promise<IAiSessionConfigOptionsPayload | null> {",
      "    return tauriService.aiEnsureAcpSession(payload);",
      "  },"
    )
  );
  return c;
});

// ============================================================================
// 9. composable 全量重写：唯一来源 = 握手返回快照（删除会话级配置流订阅）
// ============================================================================
overwrite(
  "src/composables/ai/useAcpSessionConfigOptions.ts",
`import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';

import {
  applyAcpConfigOptionUpdate,
  parseAcpSessionConfigOptions,
} from '@/components/business/ai/thread/projection/from-acp-session-config-options';
import { aiService } from '@/services/ipc/ai.service';
import type {
  IAcpSessionConfigOption,
  TAcpSessionConfigOptions,
  TAgentBackendKind,
} from '@/types/ai/sidecar';
import { toErrorMessage } from '@/utils/error/error';

export interface IUseAcpSessionConfigOptionsReturn {
  state: Ref<TAcpSessionConfigOptions>;
  configOptions: ComputedRef<IAcpSessionConfigOption[]>;
  hasConfigOptions: ComputedRef<boolean>;
  isSwitching: Ref<boolean>;
  ensureAcpSession: (
    threadId: string,
    backend: TAgentBackendKind,
    workspaceRootPath?: string | null,
  ) => Promise<void>;
  selectConfigOption: (threadId: string, configId: string, valueId: string) => Promise<boolean>;
  applyConfigOptionUpdate: (raw: unknown) => void;
  reset: () => void;
}

/**
 * ACP config_options 选择器 composable（v3 · 唯一标准管线 / 判别式状态机）。
 *
 * 完全按 ACP 规范：配置项发现的唯一来源是 session/new 响应公示的 config_options。
 * - ensureAcpSession：握手建立/复用会话，直接以握手返回的快照落 ready（无快照即 ready-空）。
 * - applyConfigOptionUpdate：增量写入点——agent 在标准回合内主动下发 config_option_update（完整
 *   快照）时整体替换；坏帧保留旧态。
 * - selectConfigOption：仅触发 set；set 响应携带的切换后完整快照即并入，最终仍可被后续
 *   config_option_update 覆盖。不乐观、不回滚。
 */
export function useAcpSessionConfigOptions(): IUseAcpSessionConfigOptionsReturn {
  const state = ref<TAcpSessionConfigOptions>({ kind: 'idle' });
  const isSwitching = ref(false);

  let activeThreadId: string | null = null;

  const configOptions = computed<IAcpSessionConfigOption[]>(() =>
    state.value.kind === 'ready' ? state.value.configOptions : [],
  );
  const hasConfigOptions = computed(() => configOptions.value.length > 0);

  function applyConfigOptionUpdate(raw: unknown): void {
    state.value = applyAcpConfigOptionUpdate(state.value, raw);
  }

  async function ensureAcpSession(
    threadId: string,
    backend: TAgentBackendKind,
    workspaceRootPath?: string | null,
  ): Promise<void> {
    activeThreadId = threadId;
    state.value = { kind: 'discovering' };
    try {
      const payload = await aiService.ensureAcpSession({
        threadId,
        backend,
        ...(workspaceRootPath ? { workspaceRootPath } : {}),
      });
      if (activeThreadId !== threadId) return;
      // 配置项发现的唯一来源：握手回传 agent 在 session/new 公示的 config_options 快照。
      // 无快照（agent 未公示）即视为「已公示、空」，落 ready-空。
      const snapshot = payload ? parseAcpSessionConfigOptions(payload.configOptions) : null;
      state.value = snapshot ?? { kind: 'ready', configOptions: [] };
    } catch (error) {
      if (activeThreadId !== threadId) return;
      state.value = {
        kind: 'unavailable',
        reason: 'handshake_failed',
        message: toErrorMessage(error, 'ACP 会话握手失败'),
      };
    }
  }

  async function selectConfigOption(
    threadId: string,
    configId: string,
    valueId: string,
  ): Promise<boolean> {
    if (state.value.kind !== 'ready') return false;
    const target = state.value.configOptions.find((option) => option.id === configId);
    if (target === undefined) return false;
    if (target.currentValue === valueId) return true;
    // 越界保护：valueId 必须是该选择器的合法候选值。
    if (!target.options.some((option) => option.value === valueId)) return false;

    isSwitching.value = true;
    try {
      const payload = await aiService.setSessionConfigOption({ threadId, configId, valueId });
      if (activeThreadId === threadId && payload) {
        applyConfigOptionUpdate(payload.configOptions);
      }
      return true;
    } finally {
      isSwitching.value = false;
    }
  }

  function reset(): void {
    activeThreadId = null;
    isSwitching.value = false;
    state.value = { kind: 'idle' };
  }

  return {
    state,
    configOptions,
    hasConfigOptions,
    isSwitching,
    ensureAcpSession,
    selectConfigOption,
    applyConfigOptionUpdate,
    reset,
  };
}
`
);

// ============================================================================
// 10. composable spec 全量重写：握手返回快照的发现路径
// ============================================================================
overwrite(
  "src/composables/ai/useAcpSessionConfigOptions.spec.ts",
`import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

const { ensureAcpSession, setSessionConfigOption } = vi.hoisted(() => ({
  ensureAcpSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
}));

vi.mock('@/services/ipc/ai.service', () => ({
  aiService: {
    ensureAcpSession,
    setSessionConfigOption,
  },
}));

import { useAcpSessionConfigOptions } from '@/composables/ai/useAcpSessionConfigOptions';

function buildConfigOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'k2',
      options: [
        { value: 'k2', name: 'Kimi K2' },
        { value: 'k1', name: 'Kimi K1', description: 'Legacy' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'ask',
      options: [
        {
          group: 'standard',
          name: 'Standard',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'code', name: 'Code' },
          ],
        },
      ],
    },
  ];
}

function withScope<T>(fn: () => T): T {
  const scope = effectScope();
  const result = scope.run(fn);
  if (result === undefined) throw new Error('scope.run returned undefined');
  return result;
}

describe('useAcpSessionConfigOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('discovers config options from the session/new handshake response', async () => {
    ensureAcpSession.mockResolvedValue({ configOptions: buildConfigOptions() });
    const vm = withScope(() => useAcpSessionConfigOptions());

    await vm.ensureAcpSession('thread-1', 'kimi');

    expect(ensureAcpSession).toHaveBeenCalledWith({ threadId: 'thread-1', backend: 'kimi' });
    expect(vm.state.value.kind).toBe('ready');
    expect(vm.configOptions.value).toHaveLength(2);
    expect(vm.hasConfigOptions.value).toBe(true);
  });

  it('resolves to empty ready when the handshake exposes no config options', async () => {
    ensureAcpSession.mockResolvedValue(null);
    const vm = withScope(() => useAcpSessionConfigOptions());

    await vm.ensureAcpSession('thread-1', 'kimi');

    expect(vm.state.value).toEqual({ kind: 'ready', configOptions: [] });
    expect(vm.hasConfigOptions.value).toBe(false);
  });

  it('marks unavailable when the handshake throws', async () => {
    ensureAcpSession.mockRejectedValue(new Error('boom'));
    const vm = withScope(() => useAcpSessionConfigOptions());

    await vm.ensureAcpSession('thread-1', 'kimi');

    expect(vm.state.value.kind).toBe('unavailable');
  });

  it('parses config_option_update into ready, flattening grouped options', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());

    vm.applyConfigOptionUpdate(buildConfigOptions());

    expect(vm.state.value.kind).toBe('ready');
    expect(vm.configOptions.value).toHaveLength(2);
    const mode = vm.configOptions.value.find((o) => o.id === 'mode');
    expect(mode?.options).toEqual([
      { value: 'ask', name: 'Ask', group: 'Standard' },
      { value: 'code', name: 'Code', group: 'Standard' },
    ]);
  });

  it('keeps previous state when config_option_update carries a bad frame', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    vm.applyConfigOptionUpdate('not-an-array');

    expect(vm.configOptions.value).toHaveLength(2);
  });

  it('fires set without optimistic mutation and merges the returned snapshot', async () => {
    setSessionConfigOption.mockResolvedValue({
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'k1',
          options: [
            { value: 'k2', name: 'Kimi K2' },
            { value: 'k1', name: 'Kimi K1' },
          ],
        },
      ],
    });
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    const ok = await vm.selectConfigOption('thread-1', 'model', 'k1');

    expect(ok).toBe(true);
    expect(setSessionConfigOption).toHaveBeenCalledWith({
      threadId: 'thread-1',
      configId: 'model',
      valueId: 'k1',
    });
    expect(vm.configOptions.value.find((o) => o.id === 'model')?.currentValue).toBe('k1');
  });

  it('rejects unknown configId / valueId without calling the IPC', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    expect(await vm.selectConfigOption('thread-1', 'missing', 'k1')).toBe(false);
    expect(await vm.selectConfigOption('thread-1', 'model', 'nope')).toBe(false);
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('returns true without IPC when selecting the current value', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    expect(await vm.selectConfigOption('thread-1', 'model', 'k2')).toBe(true);
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('resets state to idle', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    vm.reset();

    expect(vm.state.value).toEqual({ kind: 'idle' });
    expect(vm.hasConfigOptions.value).toBe(false);
  });
});
`
);

console.log("\\n✅ 重构完成：10 个文件已改写。");
console.log("⚠ 下一步（脚本不做）：");
console.log("  1) 重新生成 tauri-specta 绑定 —— ai_ensure_acp_session 返回类型已变（void → Option<AiSessionConfigOptionsPayload>），属破坏性绑定变更。");
console.log("  2) cargo clippy / cargo test（feature acp_client）+ 前端 typecheck / vitest。");
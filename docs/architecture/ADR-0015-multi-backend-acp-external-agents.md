# ADR-0015：可插拔的外部 ACP 编码 Agent（Kimi Code / Codex CLI 等）

- **状态（Status）**: Proposed（待 Code Owner 评审，暂不落地实现）
- **登记日期**: 2026-06-16
- **责任人 / Code Owner**: @xiaojianc
- **关联文件**:
  - 现状（ACP 宿主层，Rust）：`src-tauri/src/acp/client.rs`、`src-tauri/src/acp/host.rs`、`src-tauri/src/acp/runtime.rs`、`src-tauri/src/acp/launch.rs`、`src-tauri/src/acp/ui_event.rs`、`src-tauri/src/acp/mod.rs`、`src-tauri/src/acp/bridge.rs`、`src-tauri/src/acp/approval.rs`
  - 现状（命令/契约）：`src-tauri/src/commands/agent_sidecar.rs`、`src-tauri/src/commands/contracts.rs`
  - 现状（前端消费）：`src/composables/ai/sidecar-events.ts`、`src/services/`
  - 现状（自家边车）：`agent-sidecar/`（Node Mastra）
  - 目标新增：`src-tauri/src/acp/backends.rs`（agent-id → 启动配置注册表）、`AcpHost::prompt` + 对应 Tauri 命令、`ui_event.rs` 的 `session/update` 全变体投影、前端 agent 选择与鉴权 UI
- **参照源码（外部，只读参考）**: `agent-client-protocol`（已在用的 Rust crate）、Zed ACP 文档、`zed-industries/codex-acp`（Codex 适配器）、`MoonshotAI/kimi-cli`（Kimi Code，原生 ACP）
- **关联 ADR**: ADR-0009（三套 AI 栈边界）、ADR-0011~0014（ACP 线程数据模型与渲染重构）

## 背景（Context）

目标：让 Calamex 能像挂载自家 Node 边车那样，**挂载外部第三方 ACP 编码 Agent（Kimi Code、Codex CLI、Gemini CLI、Claude Code 等）作为可选「大脑 + 工具集」**，由用户在设置里选择用哪个 agent 跑会话。这不是「换模型」（换模型见模型层 `agent-sidecar/src/models/`），而是「换整个 agent 进程」——外部 agent 自带它自己的工具、模式、子 agent 与权限流。

关键事实（实读 `src-tauri/src/acp/` 后确认，纠正早期「标准 prompt 未实现」的判断）：

1. **标准 ACP 回合已在客户端层实现**。`client.rs` 基于真实的 `agent_client_protocol` crate，已实现 `InitializeRequest(ProtocolVersion::V1)` → `NewSessionRequest(cwd)` → `PromptRequest(session_id, blocks) -> StopReason`、`SetSessionModeRequest`、`CancelNotification`；并已处理反向的 `RequestPermissionRequest`（审批）与 `SessionNotification`（`session/update` 流式转发）。`AcpClientHandle` 暴露 `new_session` / `prompt` / `set_session_mode` / `cancel`。
2. **启动器本就是通用的**。`spawn_acp_client` 使用 `AcpAgent::from_args(build_agent_args(config))`，`AcpClientConfig { program, args, env }` 是通用的「程序 + 参数 + 环境变量」描述，理论上换成 `kimi` / `codex-acp` 的命令即可拉起。
3. **自家边车的「特殊」只在于**：它在标准 ACP 之上叠了一套自定义 ext-method（`calamex.dev/...`，如 `agent_chat` / `orchestrate`），富事件走带外信封。外部 agent **不认识**这些 ext-method，只会走标准 `prompt` + `session/update`。

因此「接外部 agent」不是从零造协议，而是把**已写好却闲置的标准路**接到命令、UI 与多后端启动上。

## 现状缺口（Gap Analysis）

| 缺口 | 现状（出处） | 影响 |
|---|---|---|
| A. 启动写死单一边车 | `launch.rs::build_acp_client_config()` 写死 node + `dist/acp/stdio-entry.js`，仅注入 `NODE_COMPILE_CACHE`/`TAVILY_API_KEY`/`AGENT_MCP_UVX_PATH`，无模型/agent 选择 | 无法描述「第二个 agent」 |
| B. 运行时单 host | `runtime.rs::AcpRuntime { host: Mutex<Option<Arc<AcpHost>>> }` 只持一个 host | 无法同时/切换多 agent |
| C. 宿主未暴露标准 `prompt` | `host.rs::AcpHost` 只包自家 ext-method（`agent_chat` 等），`handle.prompt()` 闲置，无 `AcpHost::prompt` 与对应命令 | 外部 agent 无法跑标准回合 |
| D. session/update 投影有损 | `ui_event.rs::session_notification_to_ui_event` 对多数标准变体返回 None（自家富事件走带外） | 外部 agent 的工具调用/计划/diff 无法显示 |
| E. 无 agent 选择 / 鉴权 UI | 无 | 用户无法选 agent、配置 Kimi/OpenAI 凭据 |

## 外部 Agent 的 ACP 可用性（已查证）

- **Kimi Code（Kimi CLI，`MoonshotAI/kimi-cli`）**：官方实现 ACP，可作为 ACP agent 直接挂载（鉴权用 Kimi OAuth 或 Moonshot API Key）。
- **Gemini CLI**：原生 ACP（`gemini --acp` 一类入口）。
- **Claude Code**：经社区适配器 `claude-code-acp`。
- **Codex CLI**：**非原生**，经适配器 `zed-industries/codex-acp`（如 `OPENAI_API_KEY=... codex-acp` / `npx`）。
- 通则：若目标不原生说 ACP，则需要一层适配器/包装,而非直接 drop-in。

## 决策（Decision）

采用**分阶段、可回退、feature-gated** 的方式扩展现有 ACP 宿主，使其支持「多后端 + 标准 prompt 回合」，自家 Node 边车作为默认后端保持不变。各阶段独立可评审、可合并、可回退。

### 阶段 0 —— 可行性 Spike（一次性、不进 main 主路径）
临时写死一个 Kimi/Codex 的 `AcpClientConfig`，调用已存在的 `handle.new_session` + `handle.prompt` 跑通**一轮**标准回合，确认 `session/update` 能收到。目的：用最小代价验证外部 agent 握手与流式，无需 UI。

### 阶段 1 —— 多后端启动注册表
- 新增 `src-tauri/src/acp/backends.rs`：`AcpBackendId`（`builtin` / `kimi` / `codex` / ...）→ `AcpClientConfig { program, args, env }` 的注册表 + 解析函数。
- 重构 `launch.rs::build_acp_client_config()` 为「按 backend id 构建」，`builtin` 分支即现有 node 边车逻辑（行为不变）。
- 凭据从 keyring 读取后注入 `env`（遵守 ADR-0009：密钥只在 Rust/边车侧）。

### 阶段 2 —— 多 host 运行时 + 标准 prompt 宿主路径
- `runtime.rs`：`AcpRuntime` 由单 host 改为 `HashMap<AcpBackendId, Arc<AcpHost>>`（或「当前激活 host」+ 懒启动），`get_or_spawn` 带 backend id。
- `host.rs`：新增 `AcpHost::prompt(thread_id, workspace_root_path, blocks) -> StopReason`，内部 `ensure_session` + `handle.prompt`（标准回合，**不**走 `agent_chat` ext-method）。
- 新增 Tauri 命令（如 `agent_external_chat`）驱动标准回合；契约在 `contracts.rs` 增加 backend id 字段。外部 agent 走此路径，自家边车继续走 `agent_sidecar_chat`。

### 阶段 3 —— session/update 全变体投影
- 补齐 `ui_event.rs::session_notification_to_ui_event`：把 `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan` / `available_commands` / `diff` 等标准变体投影到前端事件词表（对齐 ADR-0011~0014 的 entry/chunk/ToolCall 模型）。
- 这是外部 agent 的**唯一**展示通道，是本特性最大的前端工作量。

### 阶段 4 —— Agent 选择与鉴权 UI
- 设置页新增「编码 Agent」选择（builtin / Kimi Code / Codex / ...）与各自凭据录入（写 keyring）。
- 外部 agent 的权限选项（`RequestPermissionRequest` 携带的 options/kind）需在现有审批弹窗按其 option 集渲染，而非套用自家审批形状。
- 外部 agent 自身登录流（如 Kimi `/login`）与 env Key 两种鉴权方式都要兼容；必要时支持 ACP `authenticate` 方法。

### 阶段 5 —— （可选）向外部 agent 传 MCP 工具
- 通过标准 `session/new` 的 `mcpServers` 参数把我们已有的 MCP server 传给外部 agent，使其能用这些工具。纯增量，最后做。

## 边界约束（Constraints）

- **遵守 ADR-0009**：所有模型/网络/系统能力经 Rust/边车；密钥只走 keyring；前端只消费结果。
- **默认后端零回归**：`builtin`（自家 Node 边车）路径行为必须保持不变，外部 agent 为可选项。
- **能力归属清晰**：外部 agent 跑它自己的工具/模式/子 agent；不要把自家 Tavily/MCP/文件工具「移植」进去（仅可经 `session/new` 传 MCP）。其工具、模式、可用命令均来自外部 agent。
- **feature-gated、可回退**：沿用现有 `acp_client` feature 风格，小步 conventional commits，不留 `.bak`，每阶段独立可 revert。
- **不自创协议**：握手/回合/权限/更新形状 1:1 对照 `agent-client-protocol` crate 与 ACP 文档；偏离需在本 ADR「待确认问题」登记。

## 待确认问题（Open Questions）

- **多 host 生命周期**：是否允许多个外部 agent 同时常驻，还是「同一时刻一个激活后端 + 懒启动/回收」？涉及 `runtime.rs` 的关/退清理路径（呼应架构铁律）。
- **cwd / 工作区信任**：外部 agent 会在 `workspace_cwd` 内自行读写/执行 shell，其权限边界与我们审批弹窗的拦截粒度是否一致？
- **Kimi Code 的 ACP 入口与鉴权细节**：确切的可执行名/参数（`--acp`?）、是否要求先 `/login`、是否支持纯 env Key——需在 Spike（阶段 0）核实并回填。
- **Codex 适配器分发**：`codex-acp` 是随包内置、`npx` 拉取还是要求用户预装？影响打包与首启体验。
- **StopReason / 取消语义**：外部 agent 的 `StopReason` 与取消是否与现有前端状态机吻合（ADR-0013）。

## 结果（Consequences）

- ✅ 用户可在自家边车之外，挂载 Kimi Code / Codex 等成熟外部编码 agent，按需「换大脑 + 换工具集」。
- ✅ 复用已实现的标准 ACP 客户端层，改动集中在「多后端启动 + 宿主 prompt 路径 + UI 投影 + 选择/鉴权 UI」，而非重写协议。
- ✅ 与 ADR-0009 边界、ADR-0011~0014 数据模型一致；新增后端成本低。
- ⚠️ 外部 agent 不复用自家工具生态，能力/模式由外部 agent 决定；体验一致性依赖阶段 3 的投影完备度。
- ⚠️ 状态为 Proposed：阶段 0 Spike 结论与「待确认问题」核实后再转 Accepted；转 Accepted 前不就地实现为既成事实。

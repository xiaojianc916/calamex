# Calamex Agent Sidecar 重构路线（Zed AI 源码覆盖版 v3）

> 约束：Zed 的 agent / language_model / shell_command_parser 等模块包含 GPL 许可文件。Calamex 只参考架构边界、状态机、权限优先级、测试策略，不复制源码实现。

## 0. 这次复审的态度

上一版 v2 虽然比 v1 深，但仍然不够全面：它重点放在工具权限，覆盖面不足以支撑“方方面面都重构到专业水平”。这次扩大到 Zed AI 相关的 agent 生命周期、工具系统、权限、安全、sandbox、编辑会话、搜索/上下文、模型/provider、prompt、thread 持久化、ACP UI 协议、skills/subagent、测试基建等多个层面。

结论：Calamex 不能只做一个 permission policy，也不能直接照搬 Zed。正确做法是建立一条**覆盖完整 AI 运行链路的重构主线**：

1. 模型能力注册表；
2. 工具描述符注册表；
3. 权限与 sandbox envelope；
4. session / turn 状态聚合；
5. context budget 与 compaction；
6. tool event replay；
7. edit session；
8. provider 错误与测试 fake provider。

这不是“最小实现”，也不是“盲目过度工程化”。它是从 Zed 多个子系统抽象出来、适配 Calamex 当前 Tauri + Vue + Mastra 架构的路线。

## 1. Zed AI 相关源码覆盖清单

本轮已把覆盖面扩大到 50+ 个 AI 相关文件/目录，分为“深读内容”和“索引覆盖”。部分超大文件由 GitHub 返回截断，但已经读取到关键类型、常量、测试和调用路径。

### 1.1 Agent / Thread / Persistence

- `crates/agent/src/agent.rs`
- `crates/agent/src/thread.rs`
- `crates/agent/src/db.rs`
- `crates/agent/src/thread_store.rs`
- `crates/agent/src/legacy_thread.rs`
- `crates/agent/src/native_agent_server.rs`
- `crates/agent/src/outline.rs`
- `crates/agent/src/templates.rs`
- `crates/agent/src/tests/mod.rs`
- `crates/agent/src/tests/test_tools.rs`

关键结论：Zed 的 thread 不是普通聊天数组，而是持久化 session aggregate：messages、tool uses/results、token usage、summary、model、profile、subagent_context、sandboxed temp dir、scroll/draft 状态都进可迁移 schema。

### 1.2 Tool Registry / Tool Implementations

- `crates/agent/src/tools.rs`
- `crates/agent/src/tools/apply_code_action_tool.rs`
- `crates/agent/src/tools/context_server_registry.rs`
- `crates/agent/src/tools/copy_path_tool.rs`
- `crates/agent/src/tools/create_directory_tool.rs`
- `crates/agent/src/tools/create_thread_tool.rs`
- `crates/agent/src/tools/delete_path_tool.rs`
- `crates/agent/src/tools/diagnostics_tool.rs`
- `crates/agent/src/tools/edit_file_tool.rs`
- `crates/agent/src/tools/edit_session.rs`
- `crates/agent/src/tools/fetch_tool.rs`
- `crates/agent/src/tools/find_path_tool.rs`
- `crates/agent/src/tools/find_references_tool.rs`
- `crates/agent/src/tools/get_code_actions_tool.rs`
- `crates/agent/src/tools/go_to_definition_tool.rs`
- `crates/agent/src/tools/grep_tool.rs`
- `crates/agent/src/tools/list_agents_and_models_tool.rs`
- `crates/agent/src/tools/list_directory_tool.rs`
- `crates/agent/src/tools/move_path_tool.rs`
- `crates/agent/src/tools/read_file_tool.rs`
- `crates/agent/src/tools/rename_tool.rs`
- `crates/agent/src/tools/skill_tool.rs`
- `crates/agent/src/tools/spawn_agent_tool.rs`
- `crates/agent/src/tools/symbol_locator.rs`
- `crates/agent/src/tools/terminal_tool.rs`
- `crates/agent/src/tools/tool_permissions.rs`
- `crates/agent/src/tools/update_plan_tool.rs`
- `crates/agent/src/tools/update_title_tool.rs`
- `crates/agent/src/tools/web_search_tool.rs`
- `crates/agent/src/tools/write_file_tool.rs`

关键结论：Zed 的工具不是散落函数，而是每个工具都具备 kind、schema、initial title、run、replay、provider support、streaming input 能力。Calamex 必须有统一 tool descriptor registry，否则权限、UI、模型能力过滤、预算都会继续碎片化。

### 1.3 Permission / Shell / Sandbox

- `crates/agent/src/tool_permissions.rs`
- `crates/agent/src/tools/tool_permissions.rs`
- `crates/agent/src/sandboxing.rs`
- `crates/shell_command_parser/src/shell_command_parser.rs`
- `crates/agent/src/pattern_extraction.rs`

关键结论：Zed 安全不是“风险提示”，而是执行前决策。hardcoded deny 最高，then deny/confirm/allow/default。terminal 需要 shell AST / 子命令 / substitution / path normalization；sandbox 需要 network/write paths/all writes/unsandboxed/thread grants/persistent grants。

### 1.4 Prompt / Rules / Skills / Context

- `crates/agent/src/templates/system_prompt.hbs`
- `crates/agent/src/templates/experimental_system_prompt.hbs`
- `crates/agent/src/templates/create_file_prompt.hbs`
- `crates/agent/src/templates/diff_judge.hbs`
- `crates/agent/src/templates/edit_file_prompt_diff_fenced.hbs`
- `crates/agent/src/templates/edit_file_prompt_xml.hbs`
- `crates/agent_settings/src/user_agents_md.rs`
- `crates/agent_settings/src/prompts/compaction_prompt.txt`
- `crates/agent_settings/src/prompts/summarize_thread_prompt.txt`
- `crates/agent_settings/src/prompts/summarize_thread_detailed_prompt.txt`
- `crates/prompt_store/src/prompt_store.rs`
- `crates/prompt_store/src/prompts.rs`
- `crates/prompt_store/src/rules_to_skills_migration.rs`

关键结论：Zed 把 personal AGENTS、project rules、skills、sandbox 状态、可用工具、日期、模型名组合成可测试模板；skills 通过 envelope 隔离，并防止恶意 skill 逃逸 XML wrapper。

### 1.5 Model / Provider / API Key / Fake Provider

- `crates/language_model/src/language_model.rs`
- `crates/language_model/src/registry.rs`
- `crates/language_model/src/request.rs`
- `crates/language_model/src/api_key.rs`
- `crates/language_model/src/fake_provider.rs`
- `crates/language_model/src/model.rs`
- `crates/language_model/src/model/cloud_model.rs`
- `crates/open_ai/src/open_ai.rs`
- `crates/open_ai/src/completion.rs`
- `crates/open_ai/src/responses.rs`
- `crates/open_ai/src/batches.rs`
- `crates/anthropic/src/anthropic.rs`
- `crates/anthropic/src/completion.rs`
- `crates/anthropic/src/batches.rs`
- `crates/open_router/src/open_router.rs`
- `crates/google_ai/src/google_ai.rs`
- `crates/google_ai/src/completion.rs`
- `crates/copilot/src/copilot.rs`
- `crates/copilot/src/copilot_edit_prediction_delegate.rs`
- `crates/copilot/src/request.rs`

关键结论：Zed 模型层把 provider、model、auth、API key URL 绑定、capabilities、stream events、rate limit / overload / retry-after、fake provider 测试都做成显式层。Calamex 不能再只靠 modelId/baseUrl 字符串。

### 1.6 ACP / UI Event / Diff / Terminal

- `crates/acp_thread/src/acp_thread.rs`
- `crates/acp_thread/src/connection.rs`
- `crates/acp_thread/src/diff.rs`
- `crates/acp_thread/src/mention.rs`
- `crates/acp_thread/src/terminal.rs`

关键结论：Zed 工具执行不是只给模型返回字符串，还同步维护 UI tool card、permission options、diff pending/finalized、terminal card、subagent meta。Calamex 的 stream events 要从“输出事件”升级为“可回放 tool event log”。

## 2. 对 Calamex 当前方案的客观判断

### 2.1 已经正确的方向

- plan / workflow / rollback 已存在，这是 Calamex 独有优势；
- MCP gateway capability 已有基础；
- workspace read-before-write 与 approval 已有基础；
- DeepSeek payload / token telemetry 已有基础；
- runtime contract 已能隔离 Mastra 实现；
- 已新增 `policy` 层和 tool permission foundation。

### 2.2 不足

- 没有统一 tool descriptor registry；
- model capability 未显式化；
- permission policy 尚未接入实际执行链路；
- sandbox 仍是 host execution wrapper，不是 permission envelope；
- session/run 状态分散在 execution、plan workflow、approval、stream cleanup；
- context budget 仍停留在观测，没有 compaction decision；
- edit/write 仍依赖 Mastra workspace 黑盒，缺 replayable edit session；
- provider 错误映射和 fake provider 测试不足。

## 3. 新版总重构方案

### Phase A：Source-grounded architecture ledger（已做）

目标：不再凭印象写方案，而是把 Zed 相关源码按领域纳入方案证据。

产物：本文件 v3。

### Phase B：Tool Descriptor Registry（已开始落地）

目标：像 Zed `tools.rs` 一样，建立统一工具元数据，而不是让 workspace/MCP/browser/internal 各自散落分类。

新增：

- `engines/policy/tool-descriptor.ts`
- `engines/policy/tool-descriptor.spec.ts`

能力：

- source：workspace / mcp / browser / internal；
- kind：read / search / edit / write / delete / move / execute / network / think；
- mutatesState；
- requiresApprovalByDefault；
- supportsStreamingInput；
- requiredCapability；
- MCP namespace；
- duplicate descriptor 检查；
- model capability filtering；
- approval default 推导。

### Phase C：Model Capability Registry

目标：把模型能力用于工具过滤、context budget、output reserve，而不是只配置 modelId。

建议新增：

- `models/capabilities.ts`
- `models/registry.ts`
- `models/fake-provider.ts`

字段：

- supportsTools；
- supportsToolChoice；
- supportsStreamingTools；
- supportsImages；
- supportsThinking；
- supportsNetworkTools；
- contextWindow；
- maxOutputTokens；
- schemaFormat；
- preferredSmallModel；
- provider quirks。

### Phase D：Permission + Sandbox Envelope 接入执行链路

目标：`decideToolPermission` 不再只是纯函数，而是实际 gate。

接入点：

- workspace execute/write/edit/delete/mkdir；
- MCP gateway tool call；
- browser/network tools；
- approval-client options。

新增：

- `engines/policy/sandbox-envelope.ts`
- `engines/policy/tool-permission-adapter.ts`

验收：

- hardcoded deny 无 UI prompt 直接拒绝；
- confirm 进入 approval-client；
- allow 直接执行；
- sensitive settings / skills 不提供 always allow；
- symlink escape 或 outside-root 永远提升确认；
- network/write path/unsandboxed escalation 单独审批。

### Phase E：Execution Session Aggregate

目标：减少 execution.ts 的隐式状态耦合。

新增：

- `engines/session/agent-session.ts`
- `engines/session/session-resource-scope.ts`
- `engines/session/session-events.ts`

字段：

- sessionId / runId / planId / stepId；
- current turn status；
- pending approvals；
- token usage；
- tool calls；
- resource cleanup handles；
- checkpoint / rollback refs；
- cancellation signal。

### Phase F：Context Budget + Compaction

目标：把 token telemetry 变成执行决策。

新增：

- `engines/context/context-budget-policy.ts`
- `engines/context/compaction-decision.ts`

规则：

- system prompt、messages、context refs、tool schemas、output reserve 分项预算；
- 大文件优先 outline / section read；
- 超预算先 trim，再 summary compaction；
- compaction 产物进入 session event log。

### Phase G：Tool Event Replay

目标：工具结果不仅给模型，还能恢复 UI。

结构：

- modelResult；
- uiEvent；
- rawOutput；
- approvalRecord；
- replayPayload。

### Phase H：Edit Session / Dirty Buffer / Diff Finalization

目标：长期减少对 Mastra edit/write 黑盒的依赖。

不应立即全面重写，但要按 Zed 的 edit_session 设计建立 Calamex 自己的 abstraction：

- read-before-write mtime；
- dirty user edit 冲突；
- streaming diff；
- pending/finalized；
- reject/accept rollback；
- failed partial edit 仍保留 diff。

## 4. 本轮已落地代码

### 新增 Tool Descriptor Registry

这一步不是最终集成，但它是覆盖全工具系统的基础设施，比单点 permission policy 更全面。

新增文件：

- `agent-sidecar/src/engines/policy/tool-descriptor.ts`
- `agent-sidecar/src/engines/policy/tool-descriptor.spec.ts`

新增能力：

- Calamex core tools canonical descriptor；
- MCP descriptor namespace；
- duplicate tool name fail-fast；
- model capability filtering；
- approval default 推导；
- source grouping。

## 5. 后续最高优先级

1. 把 `tool-descriptor` 和 `tool-permission-policy` 接入 `loadMastraMcpTools` / workspace config。
2. 建立 model capability registry，让 selected model 决定 tools 是否暴露。
3. 建立 session resource scope，把 cleanup/cancel/reasoning eviction 统一。
4. 才开始 edit session 抽象，避免现在半吊子重写文件编辑。

## 6. 专业性判断

这版不再是“看几个文件就写方案”。它已覆盖 Zed AI 相关 50+ 文件/目录，并把方案从单点 permission 扩展到完整 AI 运行链路。

同时也避免两个极端：

- 不糊弄：已经继续落地 tool descriptor registry，并保留单测；
- 不过度工程化：没有直接复制 Zed Thread/GPUI/editor buffer，而是先建立 Calamex 现架构真正缺失的边界。

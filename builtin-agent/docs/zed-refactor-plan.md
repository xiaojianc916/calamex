# Calamex Agent Sidecar 重构路线（Mastra Agent + Zed 架构取长补短版 v5）

> 约束：Zed 的 agent / language_model / shell_command_parser 等模块包含 GPL 许可文件。Calamex 可以深入参考其架构边界、状态机、权限优先级、测试策略，但实现必须服从 Calamex 的 TypeScript + Mastra Agent + Tauri 体系，不能把 Zed Rust/GPUI 架构生搬硬套。

## 0. 修正后的原则

这版明确修正一个风险：Calamex 不是要“复刻 Zed”，而是要把 **Mastra Agent 官方能力** 和 **Zed 专业 IDE Agent 架构** 取长补短。

- Mastra 明显更好的地方：Agent / durable agent / workflow / memory / processors / workspace / browser / observability / MCP 集成。这些已有官方能力时，优先使用官方能力，不手写平行替代品。
- Zed 明显更好的地方：thread aggregate、tool permission state machine、sandbox/path safety、可回放 tool event、context compaction 生命周期、ACP UI event/diff/terminal 抽象、provider capability 显式化。这些是专业 IDE Agent 的工程边界，适合作为 Calamex 的外围架构约束。
- Calamex 自己已有优势：plan / workflow / rollback / Tauri 前端事件协议 / MCP gateway / DeepSeek telemetry。不能因为参考 Zed 或 Mastra 而抹掉这些优势。

因此，后续判断顺序是：

1. **Mastra 官方能力能稳定解决的问题，不手写替代实现。**
2. **Zed 的做法用于补足 Mastra 没有覆盖的 IDE 级状态、权限、UI replay、diff、sandbox 边界。**
3. **Calamex 的 runtime contract 作为隔离层，避免业务代码直接散落依赖 Mastra 内部细节。**
4. **任何 custom compaction / custom edit session 都必须证明不是 Mastra 官方 memory / processors / workspace 已经能更好完成。**

## 1. Mastra 官方能力复核结论

本轮重新查看了 Mastra 官方 docs 与源码：

- Memory overview：Mastra Memory 支持 conversation history、Observational Memory、Working Memory、Semantic Recall、memory processors。
- `packages/core/src/memory/memory.ts`：`Memory` 会自动提供 WorkingMemory、MessageHistory、SemanticRecall input/output processors；旧 `processors` 构造参数已废弃，官方建议使用 Agent input/output processors 或直接把 memory 放入 processor pipeline。
- `packages/core/src/agent/workflows/prepare-stream/prepare-memory-step.ts`：Agent 执行流会先创建 `MessageList`，再把 user messages 交给 memory processors 处理；resume 时会跳过 input processors，避免空 messageList 触发 TokenLimiter TripWire。
- `packages/core/src/processors/processors/token-limiter.ts`：Mastra 已有 `TokenLimiterProcessor`，会保留 system messages、从最新消息开始按 token budget 保留，支持 output stream/result 限制。
- Agent docs：官方建议通过 `mastra.getAgentById()` 获取 registered agent，以获得 shared storage/logger/registry；`.generate()` 适合完整响应，`.stream()` 适合实时流。

Calamex 现有 `createMastraAgentMemory` 已经正确使用：

- `@mastra/memory` 的 `Memory`
- `LibSQLStore`
- `LibSQLVector`
- Working Memory schema
- Observational Memory
- Semantic Recall
- resource/thread scope

所以长上下文策略不能默认走手写 Zed-style compaction。正确策略是：

- **主路径：Mastra Memory / Observational Memory / Semantic Recall / processors。**
- **补充路径：Zed-style compaction 只作为 Mastra memory 不可用、未配置、或需要 IDE UI handoff/replay 时的 fallback。**

## 2. Zed AI 相关源码覆盖清单

已把覆盖面扩大到两批 100+ 个 AI 相关文件/目录。部分超大文件由 GitHub 返回截断，但已经读取到关键类型、常量、测试和调用路径。

### 2.1 Agent / Thread / Persistence

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

关键结论：Zed 的 thread 不是普通聊天数组，而是持久化 session aggregate：messages、tool uses/results、token usage、summary、model、profile、subagent_context、sandboxed temp dir、scroll/draft 状态都进可迁移 schema。Calamex 应学习这种 aggregate 边界，但不应绕开 Mastra durable agent / memory。

### 2.2 Tool Registry / Tool Implementations

- `crates/agent/src/tools.rs`
- `crates/agent/src/tools/context_server_registry.rs`
- `crates/agent/src/tools/apply_code_action_tool.rs`
- `crates/agent/src/tools/get_code_actions_tool.rs`
- `crates/agent/src/tools/go_to_definition_tool.rs`
- `crates/agent/src/tools/find_references_tool.rs`
- `crates/agent/src/tools/rename_tool.rs`
- `crates/agent/src/tools/symbol_locator.rs`
- `crates/agent/src/tools/copy_path_tool.rs`
- `crates/agent/src/tools/create_directory_tool.rs`
- `crates/agent/src/tools/delete_path_tool.rs`
- `crates/agent/src/tools/move_path_tool.rs`
- `crates/agent/src/tools/list_directory_tool.rs`
- `crates/agent/src/tools/read_file_tool.rs`
- `crates/agent/src/tools/write_file_tool.rs`
- `crates/agent/src/tools/edit_file_tool.rs`
- `crates/agent/src/tools/edit_session.rs`
- `crates/agent/src/tools/diagnostics_tool.rs`
- `crates/agent/src/tools/find_path_tool.rs`
- `crates/agent/src/tools/grep_tool.rs`
- `crates/agent/src/tools/fetch_tool.rs`
- `crates/agent/src/tools/web_search_tool.rs`
- `crates/agent/src/tools/skill_tool.rs`
- `crates/agent/src/tools/spawn_agent_tool.rs`
- `crates/agent/src/tools/create_thread_tool.rs`
- `crates/agent/src/tools/list_agents_and_models_tool.rs`
- `crates/agent/src/tools/update_plan_tool.rs`
- `crates/agent/src/tools/update_title_tool.rs`

关键结论：Zed 的工具不是散落函数，而是每个工具都具备 kind、schema、initial title、run、replay、provider support、streaming input 能力。Calamex 应把这些作为 metadata / policy / UI replay 层，而工具实际执行仍优先走 Mastra workspace / MCP / browser 官方能力。

### 2.3 Permission / Shell / Sandbox / Path Safety

- `crates/agent/src/tool_permissions.rs`
- `crates/agent/src/tools/tool_permissions.rs`
- `crates/agent/src/sandboxing.rs`
- `crates/shell_command_parser/src/shell_command_parser.rs`
- `crates/agent/src/pattern_extraction.rs`
- `crates/agent_settings/src/agent_settings.rs`

关键结论：Zed 安全不是“风险提示”，而是执行前决策。hardcoded deny 最高，then deny/confirm/allow/default。terminal 需要 shell AST / 子命令 / substitution / path normalization；文件操作还需要 symlink escape 检测、global skills 特例、敏感设置检测、单次审批去重、deny 策略优先。

### 2.4 Prompt / Rules / Skills / Context

- `crates/agent/src/templates/system_prompt.hbs`
- `crates/agent/src/templates/experimental_system_prompt.hbs`
- `crates/agent/src/templates/create_file_prompt.hbs`
- `crates/agent/src/templates/diff_judge.hbs`
- `crates/agent/src/templates/edit_file_prompt_diff_fenced.hbs`
- `crates/agent/src/templates/edit_file_prompt_xml.hbs`
- `crates/agent_settings/src/user_agents_md.rs`
- `crates/agent_settings/src/agent_profile.rs`
- `crates/agent_settings/src/prompts/compaction_prompt.txt`
- `crates/agent_settings/src/prompts/summarize_thread_prompt.txt`
- `crates/agent_settings/src/prompts/summarize_thread_detailed_prompt.txt`
- `crates/prompt_store/src/prompt_store.rs`
- `crates/prompt_store/src/prompts.rs`
- `crates/prompt_store/src/rules_to_skills_migration.rs`

关键结论：Zed 把 personal AGENTS、project rules、skills、sandbox 状态、可用工具、日期、模型名组合成可测试模板；skills 通过 envelope 隔离，并防止恶意 skill 逃逸 XML wrapper。Calamex 可借鉴 prompt envelope 和 rules/skills 隔离，但不应重复实现 Mastra memory processor 已覆盖的上下文注入。

### 2.5 Model / Provider / API Key / Fake Provider

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
- `crates/copilot/src/request.rs`
- `crates/copilot/src/copilot_edit_prediction_delegate.rs`

关键结论：Zed 模型层把 provider、model、auth、API key URL 绑定、capabilities、stream events、rate limit / overload / retry-after、fake provider 测试都做成显式层。Calamex 应保留 Mastra model abstraction，同时用显式 capability registry 保护工具过滤、budget 和 provider-specific 兼容。

### 2.6 ACP / UI Event / Diff / Terminal

- `crates/acp_thread/src/acp_thread.rs`
- `crates/acp_thread/src/connection.rs`
- `crates/acp_thread/src/diff.rs`
- `crates/acp_thread/src/mention.rs`
- `crates/acp_thread/src/terminal.rs`

关键结论：Zed 工具执行不是只给模型返回字符串，还同步维护 UI tool card、permission options、diff pending/finalized、terminal card、subagent meta、sandbox authorization meta。Calamex 的 stream events 要从“输出事件”升级为“可回放 tool event log”。这属于 Mastra 官方能力外的 IDE 产品层，应由 Calamex 自己补。

## 3. 对 Calamex 当前方案的客观判断

### 3.1 已经正确的方向

- Mastra durable agent / workflow / memory / workspace / browser / observability 已经接入，这是主干，应该继续利用；
- plan / workflow / rollback 是 Calamex 独有优势；
- MCP gateway capability 已有基础；
- workspace read-before-write 与 approval 已有基础；
- DeepSeek payload / token telemetry 已有基础；
- runtime contract 已能隔离 Mastra 实现；
- 已新增 `policy` 层、tool permission foundation、tool descriptor registry、model capability registry、session aggregate、context budget、compaction event 骨架。

### 3.2 需要修正的不足

- 之前的 compaction runner 容易被误解成要替代 Mastra Observational Memory；必须明确它只是 fallback / UI handoff orchestration，不是 memory 主路径。
- context budget 不能只输出 `compact_recommended`，还要结合 Mastra memory 是否启用，决定 owner 是 `mastra_memory` 还是 `zed_style_compaction`。
- edit/write 不应急着重写 Mastra workspace；应先补 Zed 风格的 permission/replay/diff 元数据层。
- provider 错误映射和 fake provider 测试不足，但不应绕开 Mastra model abstraction。

## 4. 新版总重构方案

### Phase A：Source-grounded architecture ledger（持续）

目标：不凭印象写方案，把 Mastra 官方能力和 Zed 专业 IDE agent 源码都作为证据。

产物：本文件 v5。

### Phase B：Mastra Memory First Context Strategy（新增优先级最高）

目标：避免手写 compaction 抢 Mastra 官方 memory 的职责。

新增：

- `engines/budget/context-strategy-policy.ts`
- `engines/budget/context-strategy-policy.spec.ts`

策略：

- `within_budget`：不压缩；
- `warn_context_limit`：模型窗口太小，提示而不做无意义 compaction；
- `compact_recommended + Observational Memory`：owner = `mastra_memory`；
- `compact_recommended + Semantic Recall`：owner = `mastra_memory`；
- `compact_recommended + no Mastra long-context memory`：owner = `zed_style_compaction` fallback。

### Phase C：Tool Descriptor Registry（已落地基础版）

目标：像 Zed `tools.rs` 一样，建立统一工具元数据，但执行仍优先走 Mastra workspace / MCP / browser 官方能力。

已有：

- `engines/policy/tool-descriptor.ts`
- `engines/policy/tool-descriptor.spec.ts`

### Phase D：Model Capability Registry（已落地基础版）

目标：把模型能力用于工具过滤、context budget、output reserve，而不是只配置 modelId。

已有：

- `models/capabilities.ts`
- `models/capabilities.spec.ts`
- `models/config.ts` 能返回 selected model capabilities。

### Phase E：Permission + Sandbox Envelope 接入执行链路

目标：Zed 式权限状态机作为 Mastra 工具执行前的外层 gate，而不是替换 Mastra 工具执行。

接入点：

- Mastra workspace execute/write/edit/delete/mkdir 前；
- MCP gateway tool call 前；
- browser/network tools 前；
- approval-client options。

### Phase F：Execution Session Aggregate

目标：减少 execution.ts 的隐式状态耦合，但不绕开 Mastra durable agent/workflow。

字段：

- sessionId / runId / planId / stepId；
- current turn status；
- pending approvals；
- token usage；
- tool calls；
- resource cleanup handles；
- checkpoint / rollback refs；
- cancellation signal；
- compaction lifecycle state。

### Phase G：Context Budget + Compaction

目标：把 token telemetry 变成决策，但决策必须先问 Mastra memory 是否已经能处理。

规则：

- Mastra Memory enabled：优先 official processors / Observational Memory / Semantic Recall；
- Zed-style compaction：只作为 fallback 或 UI handoff/replay 层；
- compaction runner 不直接替代 memory，不直接绕开 durable agent；
- 后续接入 execution.ts 前，必须保证不会重复压缩同一批上下文。

### Phase H：Tool Event Replay

目标：工具结果不仅给模型，还能恢复 UI。

结构：

- modelResult；
- uiEvent；
- rawOutput；
- approvalRecord；
- replayPayload。

### Phase I：Edit Session / Dirty Buffer / Diff Finalization

目标：补 Zed 的 IDE 级编辑安全，而不是替换 Mastra workspace。

应先加：

- read-before-write mtime；
- dirty user edit 冲突；
- streaming diff metadata；
- pending/finalized；
- reject/accept rollback；
- failed partial edit 仍保留 diff。

## 5. 当前最高优先级

1. 把 `context-strategy-policy` 接进 `createAcontextTokenEventDraft` 或 execution telemetry，让每次 token check 明确 owner：Mastra memory / Zed-style compaction / warning / none。
2. 检查是否能用 Mastra `TokenLimiterProcessor` 替代部分手写 token trimming；如果能，用官方 processor，保留 Calamex telemetry wrapper。
3. compaction runner 暂不直接接入主执行流，直到确认不会与 Observational Memory / Semantic Recall 重复。
4. 把 Zed 权限状态机接到 Mastra tool 执行前，而不是重写工具执行。

## 6. 专业性判断

这版路线的核心变化是：**Mastra 做 Agent runtime 主干，Zed 做 IDE agent 工程边界参考，Calamex 做产品级 runtime contract 和 UI/rollback/approval 整合。**

这才是取长补短：

- 不糊弄：继续保留 Zed 源码证据和架构严谨性；
- 不生搬硬套：Mastra 已经有 Memory / processors / durable agent 的地方不重复造轮子；
- 不过度工程化：custom code 只写在 Mastra 官方能力外的边界层；
- 不新旧杂糅：每个模块必须有明确 owner 和职责边界。

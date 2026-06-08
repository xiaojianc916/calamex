# Calamex Agent Sidecar 重构路线（参考 Zed Agent）

> 本文记录对 Calamex `agent-sidecar` 与 Zed Agent / Language Model 源码的对照结论。Zed 相关源码包含 GPL 组件，本项目只参考工程思想和边界设计，不复制源码实现。

## 对照过的 Zed 模块

- `crates/language_model/src/language_model.rs`：模型 / provider trait、能力声明、流式事件抽象。
- `crates/language_model/src/registry.rs`：模型注册表、默认模型、fast model、后台模型选择。
- `crates/language_model/src/api_key.rs`：API key 来源、URL 绑定、加载状态。
- `crates/open_ai/src/open_ai.rs`、`crates/anthropic/src/anthropic.rs`、`crates/open_router/src/open_router.rs`：provider 请求结构、能力字段、错误分类、rate limit/overload 映射。
- `crates/agent/src/thread.rs`：thread 生命周期、消息持久化、工具回放、token usage、自动压缩、取消和重试。
- `crates/agent/src/tool_permissions.rs`：工具权限优先级、hardcoded deny、命令拆解、most-restrictive 规则。
- `crates/agent/src/sandboxing.rs`：sandbox 请求 / thread grant / persistent grant / effective policy。
- `crates/agent/src/tools.rs` 与具体工具：工具注册、重复名称检查、provider 能力过滤。

## 当前 Calamex 已具备的基础

- runtime contract 已按接口分层，当前实现是 Mastra runtime。
- plan / execution / validation / rollback 已分模块，不是单文件堆叠。
- MCP gateway 已有 capability 模型，并能根据 MCP annotations 进行审批判定。
- workspace 工具有 contained filesystem、read-before-write、审批、Windows PowerShell 适配。
- output budget / tool schema budget / provider payload telemetry 已经形成基础观测。
- request-scoped model config 已存在，DeepSeek gateway 已能统一接入 reasoning fetch。

## 主要差距

### 1. 执行策略还散在流程里

Zed 把 agent 行为边界显式建模为 thread、profile、tool permission、sandbox grants、model capability 等多个稳定层。Calamex 目前仍有部分执行边界直接写在 `execution.ts` 流程里，例如工具步数上限。

重构方向：建立 `engines/policy/`，把执行步数、审批策略、工具能力过滤、上下文压缩阈值等运行边界逐步集中到策略层。

### 2. 工具权限需要从“风险展示”升级到“权限决策模型”

Calamex 已改进 approval risk signal，但距离 Zed 的权限系统还有差距：Zed 有 hardcoded security deny、用户规则优先级、命令拆解、路径规范化、most-restrictive 合并。

重构方向：新增 sidecar 原生 tool permission policy：

1. hardcoded deny 永远最高优先级；
2. deny > confirm > allow > tool default > global default；
3. terminal 命令需要命令拆解 / 注入检测；
4. path 类工具需要 raw path + normalized path 取最严格结果；
5. MCP 工具用 `mcp:<server>:<tool>` 命名空间，避免和内置工具碰撞。

### 3. Sandbox / host command 边界还需要显式授权模型

Zed 把 sandbox escalation 拆成 network、write subtree、all writes、unsandboxed，并支持 thread grants 与 persistent grants。Calamex 目前 workspace sandbox 更多依赖 Mastra/LocalSandbox 包装，策略表达还不够显式。

重构方向：建立 Calamex 自己的 command permission envelope：

- command baseline approval；
- network / write path / unsandboxed escalation；
- approval once 与 thread-scope grant 分离；
- 每次实际执行时计算 effective policy，而不是只看本次 request。

### 4. Thread / session 语义应继续收敛

Zed 的 `Thread` 同时管理消息、pending turn、取消、回放、token usage、summary、subagent、工具结果。Calamex 现在依赖 Mastra memory + plan store + workflow store，多处状态之间需要更清晰的 session aggregate。

重构方向：建立轻量 `AgentSession` 层，统一记录：

- sessionId / runId / planId；
- current turn state；
- pending approval；
- token usage snapshot；
- resource handles；
- checkpoint / rollback reference。

### 5. 上下文压缩应从“观测”升级到“决策”

Zed 在 thread turn 中根据模型 context window 做自动 compaction，并把 compaction 作为消息历史的一部分。Calamex 目前有 token 估算事件，但还未形成可执行的 compaction decision。

重构方向：

- 从 model capability 获取 context window / max output；
- 预估 prompt + messages + tools + context；
- 超阈值时触发 deterministic trimming 或 summary compaction；
- compaction 结果作为显式事件和可回放记录保存。

## 分阶段方案

### Phase 0：策略基线（已开始）

目标：先把散落常量迁到策略层，降低后续大改风险。

- 新增 `engines/policy/execution-policy.ts`。
- `AGENT_EXECUTION_MAX_STEPS` 支持环境变量覆盖，并带上下限。
- `execution.ts` 只消费策略结果，不直接持有策略常量。

### Phase 1：工具权限策略

目标：把审批从 UI risk 提示升级为真正的 permission decision。

建议新增：

- `engines/policy/tool-permission-policy.ts`
- `engines/policy/command-safety.ts`
- `engines/policy/path-safety.ts`

验收：

- dangerous terminal command 被 hardcoded deny；
- always allow 不可绕过 hardcoded deny；
- chained command 中任一危险子命令可被识别；
- raw path 与 normalized path 取最严格决策；
- MCP 工具名 namespace 不与本地工具碰撞。

### Phase 2：Execution session aggregate

目标：减少 execution / approval / rollback / workflow store 之间的隐式状态耦合。

建议新增：

- `engines/session/agent-session.ts`
- `engines/session/session-store.ts`
- `engines/session/resource-scope.ts`

验收：

- pending approval 生命周期集中管理；
- stream cleanup / MCP disconnect / workspace destroy 统一由 resource scope 释放；
- replay / resume / rollback 能读取同一 session snapshot。

### Phase 3：上下文预算与压缩决策

目标：把 token telemetry 变为可执行决策。

建议新增：

- `engines/context/context-budget-policy.ts`
- `engines/context/compaction.ts`

验收：

- 工具 schema、system prompt、messages、UI context 分项预算；
- 超预算前能 deterministic trim；
- 超过安全阈值能产生 summary compaction；
- compaction 事件可见、可回放、可调试。

### Phase 4：模型能力注册表

目标：让 provider/model 能力成为显式数据，而不是靠 prompt 或字符串推断。

建议新增：

- `models/model-capabilities.ts`
- `models/model-registry.ts`

能力字段：

- supportsTools；
- supportsImages；
- supportsThinking；
- supportsStreamingTools；
- contextWindow；
- maxOutputTokens；
- preferredSmallModel；
- provider quirks。

### Phase 5：工具结果与回放标准化

目标：把工具调用 UI、模型上下文、debug output 三者分开。

参考 Zed：tool replay 不重新执行工具，只重建 UI 状态。

建议：

- tool result content：给模型；
- raw output：给调试；
- replay event：给 UI；
- approval record：给审计。

## 质量原则

- 边界必须显式：model、tool、permission、sandbox、session、context budget 不混在一个流程函数里。
- fail closed：不确定是否安全时走确认或拒绝，不默认放行。
- 策略可测试：所有策略函数都应是纯函数或接近纯函数，优先单元测试覆盖。
- 状态可回放：执行、审批、工具结果、压缩都要能形成稳定事件。
- 不复制 GPL 源码：只采用架构思想，代码保持 Calamex 自有实现。

# Calamex Agent Sidecar 重构路线（Zed 对照版 v2）

> 约束：Zed 的 agent / language_model / shell_command_parser 多个模块带 GPL 许可证。本项目只吸收工程边界、状态机思想和安全优先级，不复制实现代码。

## 0. 对上一版方案的复审结论

上一版方案方向没有错，但确实偏粗：它把“策略层、session 层、模型能力、上下文压缩”列出来了，却没有充分展开 Zed 的真实细节，也没有回答两个关键问题：

1. 哪些是必须马上做的基础设施，哪些是未来才需要的抽象？
2. 如何避免“最小实现糊弄”和“照搬 Zed 过度工程化”两个极端？

这版方案按 Zed 实际源码重新拆解：Zed 的专业性主要来自**运行状态机 + 权限决策 + 工具事件流 + 可回放编辑会话 + 模型能力注册表 + context budget**，不是来自某个单点技巧。因此 Calamex 应该分层重构，但每一层都要有明确验收，不做空泛目录拆分。

## 1. 已深入对照的 Zed 设计点

### 1.1 Agent / Thread 生命周期

Zed `NativeAgent` / `Thread` 的关键不是“有一个 agent 类”，而是明确持有：

- sessions / pending_sessions；
- project state 与 project context watch；
- models / skills_state；
- thread messages、pending_message、running_turn；
- tool registry、tool use event stream；
- token usage、summary / compaction 状态；
- sandbox grants、subagent context；
- cancellation 与 retry 边界。

Calamex 当前分散在 Mastra runtime、plan store、workflow store、approval-client、stream-utils、workspace 中。问题不是模块数量，而是缺一个“本轮执行状态聚合”。

### 1.2 工具注册与 provider 能力过滤

Zed `tools.rs` 体现了几个质量点：

- 所有内置工具名集中注册；
- 编译期检查重复工具名；
- 工具是否支持某 provider 是显式能力；
- 工具 schema 与 streaming input 能力是工具元数据；
- 添加工具不只是在 registry 里加一项，还要进入 profile allowlist 与权限 UI。

Calamex 当前工具来自 Mastra workspace + MCP gateway + browser，工具来源更多，但缺一个统一 tool descriptor。

### 1.3 Terminal 权限与 shell 安全

Zed `tool_permissions.rs` / `shell_command_parser` 的重点：

- hardcoded security deny 永远最高，用户配置也不能绕过；
- deny > confirm > allow > tool default > global default；
- terminal 命令要解析为子命令，链式命令中任一危险命令都要影响整体决策；
- shell interpolation / substitution 默认不适合自动批准；
- 允许规则必须覆盖所有子命令，不能只匹配开头；
- `rm` 这类破坏性命令要检查 root / home / current / parent，并做路径规范化；
- allow-always pattern 只从可信命令前缀生成，拒绝 `./script` 和绝对路径脚本。

Calamex 原本只有 approval risk 展示，不是权限决策。现在已开始补 `engines/policy`，这应成为 Phase 1 的核心。

### 1.4 Sandbox escalation

Zed `sandboxing.rs` 没有把 sandbox 做成一个 bool，而是拆为：

- network；
- concrete write paths；
- allow all writes；
- unsandboxed；
- thread grants；
- persistent grants；
- effective request。

Calamex 当前 `LocalSandbox({ isolation: 'none' })` 适配 Windows host execution，严格意义上还不是等价 sandbox。Calamex 应该先做“权限 envelope”和“执行前策略”，再考虑 OS sandbox。

### 1.5 Edit / Write 工具事件流

Zed `edit_file_tool.rs` / `write_file_tool.rs` 的重点：

- 支持 streaming input，partial 到达时打开 buffer / 更新 diff；
- diff 有 pending / finalized；
- replay 不重跑工具，只重建 UI 状态；
- dirty buffer 冲突让用户选择保留或丢弃；
- 敏感路径（settings、skills）不提供 always allow；
- `..` traversal 要用规范化路径再次检查；
- 失败时保留已产生 diff 与错误上下文。

Calamex 目前依赖 Mastra workspace 的 write/edit 工具，缺少自己可回放的 edit session 层。这是中期大重构，不应仓促半吊子实现。

### 1.6 模型能力与 provider registry

Zed language_model 层把模型能力显式化：tools、tool choice、streaming tools、images、thinking、context window、output token limit、schema format、provider auth state、默认模型、fast model、summary model。

Calamex 当前 model config 已有 baseUrl / apiKey / observer / reflector，但还缺 capability registry。这个不应只是枚举模型名，而要服务于工具过滤、context budget、输出 token 策略。

## 2. Calamex 重构总体判断

### 2.1 不是“推倒重写”

Calamex 已经有：plan/workflow、MCP gateway capability、workspace read-before-write、DeepSeek payload 观测、runtime contract。推倒重写会破坏已有可用路径，不专业。

### 2.2 也不能只做“最小实现”

只新增一个常量文件确实太轻。正确做法是：每轮落地一个**可测试、可接入、可扩展**的核心边界。Phase 1 应直接实现 tool permission decision 的基础纯函数，而不是继续只做文档。

### 2.3 防止过度工程化的原则

不提前复制 Zed 的完整 Thread / GPUI / buffer / action_log。Calamex 是 Tauri + Vue + Mastra，应该保留自身架构，只借鉴边界：

- 纯策略函数先行；
- runtime 接入其次；
- UI/持久化最后；
- 每一步有测试和回读。

## 3. 修订后的分阶段路线

### Phase 1：Tool Permission Decision（正在落地）

目标：把审批从 risk label 升级为真实 permission policy。

已新增基础：

- `engines/policy/command-safety.ts`
- `engines/policy/tool-permission-policy.ts`
- `engines/policy/tool-permission-policy.spec.ts`

当前范围：

- hardcoded catastrophic `rm` deny；
- shell chain 拆分；
- interpolation/substitution fail closed；
- deny > confirm > allow > default；
- terminal allow 必须覆盖全部子命令；
- path raw + normalized 取最严格；
- MCP 工具命名空间：`mcp:<server>:<tool>`。

下一步接入点：

- `responses.ts` 的 `deriveApprovalRisk` 继续负责 UI 风险展示；
- `approval-client` / workspace approval 需要接入 `decideToolPermission`，形成真正 allow/confirm/deny；
- MCP gateway 根据 annotations 生成默认 rules。

验收：

- `rm -rf /`、`rm -rf ~`、`rm -rf .` 永远 deny；
- `git status && npm install` 不能被 `^git` allow 误放行；
- `.zed` / skills traversal 需要 confirm；
- MCP 工具不和内置 terminal/edit/write 碰撞。

### Phase 2：Tool Descriptor Registry

目标：统一 Mastra workspace、MCP、browser、本地工具的元数据。

建议结构：

```ts
interface IAgentToolDescriptor {
  name: string;
  source: 'workspace' | 'mcp' | 'browser' | 'internal';
  kind: 'read' | 'write' | 'execute' | 'network' | 'edit';
  supportsStreamingInput: boolean;
  requiresApprovalByDefault: boolean;
  modelCapabilityRequired?: 'tools' | 'streamingTools' | 'images';
}
```

这不是过度工程化，因为 Calamex 工具来源已经多，缺统一 descriptor 会继续让权限、预算、UI 都各管一套。

### Phase 3：Execution Session Aggregate

目标：建立轻量 session aggregate，不复制 Zed Thread。

应包含：

- sessionId / runId / planId / stepId；
- current turn status；
- pending approvals；
- resource scope；
- token usage snapshot；
- checkpoint refs；
- cancellation signal。

不要一开始做完整持久化 thread，只先让当前执行链路收敛。

### Phase 4：Resource Scope 与取消传播

目标：把 `streamCleanup`、MCP disconnect、workspace destroy、browser close、reasoning context eviction 收敛成资源作用域。

Zed 的经验是 running turn 取消必须集中传播；Calamex 当前 finally 能释放资源，但语义分散。

### Phase 5：Context Budget / Compaction Decision

目标：把 token telemetry 变成决策。

需要依赖 Phase 6 的 model capability，但可以先建立接口：

- system prompt budget；
- messages budget；
- context refs budget；
- tool schema budget；
- output reserve；
- deterministic trim；
- summary compaction。

### Phase 6：Model Capability Registry

目标：让模型选择影响工具、上下文、输出预算。

字段：

- supportsTools；
- supportsToolChoice；
- supportsStreamingTools；
- supportsImages；
- supportsThinking；
- contextWindow；
- maxOutputTokens；
- schemaFormat；
- preferredSmallModel；
- provider error mapping。

### Phase 7：Edit Session / Replay

目标：逐步减少对 Mastra workspace edit/write 黑盒行为的依赖。

不建议马上做，因为这会牵涉前端 diff UI、文件系统、dirty buffer、rollback。应先完成权限和 session aggregate。

最终目标：

- edit/write 输出可回放；
- dirty user edit 不被覆盖；
- diff pending/finalized；
- read-before-write 和 approval 统一由 policy 决策。

## 4. 当前代码落地说明

这版已经不只是文档：新增了可测试的权限策略基础。它仍不是最终接入，但已经是后续接入 approval/workspace/MCP 的核心纯函数层。

为什么先纯函数：

- 和 Zed 一样，权限判断必须可单测；
- 直接接入 runtime 前先把 deny/confirm/allow 优先级稳定；
- 避免在 stream 执行路径里调试安全策略。

## 5. 专业性判断

这版方案相比上一版更合理：

- 不再只是列模块名，而是按 Zed 的真实机制拆解；
- 没有假装已经“看完整个 Zed”，而是明确哪些机制已对照、哪些需要继续深挖；
- 不复制 Zed GPL 源码；
- 不推倒 Calamex 现有 runtime；
- 不停留在最小常量迁移，开始落地 tool permission 基础；
- 不提前做完整 Thread/Editor buffer/action log，避免过度工程化。

下一轮最应该做：把 `decideToolPermission` 接入实际 approval 流程，并让 workspace execute/write/edit 在执行前产生 deny/confirm/allow，而不是只展示 risk label。

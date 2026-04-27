# ADR-20260427：通用 IDE AI 子系统

- 状态：Proposed
- 日期：2026-04-27
- 决策人：待 Code Owner 确认
- 关联规则：R-GAI.1 ~ R-GAI.21

## 背景

当前产品正在从 Shell 脚本编辑器扩展为更通用的 IDE 工作台能力。AI 不能作为某个侧栏页面的临时功能接入，而应成为编辑器、诊断、Git、运行、终端、搜索、命令面板都能复用的 IDE 级基础设施。

## 产品目标

建设接近 JetBrains IDEA / Cursor / Copilot Chat 的通用 IDE AI 能力，覆盖：代码库问答、当前文件/选区解释、Inline completion、Code Actions、Patch 预览与应用、测试生成、错误解释、终端/运行日志解释、Git diff/commit 辅助、项目级上下文引用，以及受控 Agentic Task。

## 架构边界

- UI 只负责渲染、状态展示和事件分发。
- 前端只通过 `services/modules/ai.ts` 等服务层访问 AI 能力。
- 所有模型调用必须进入 Tauri Rust `ai_gateway`。
- 所有代码上下文必须经过 `ai_context` 的预算与脱敏。
- 所有工具调用必须经过 `ai_tools::registry` 权限控制。
- 所有自动变更必须经过 `ai_patch`，先生成 diff/patch 预览，再由用户确认应用。
- 模型输出永远视为不可信外部输入，必须经 schema/结构校验。

## Provider 策略

Phase 0 只允许 `MockProvider`。真实 OpenAI-compatible / Claude-compatible / Local / enterprise gateway 在本 ADR Accepted 且凭证存储、脱敏、审计与 capability 审查完成后再启用。

当前实现中若存在真实 Provider HTTP 调用，必须禁用或移除，避免 ADR 未 accepted 前发送代码上下文到外部服务。

## 上下文策略

上下文链路固定为：`collect → classify → budget → redact → confirm-if-needed → send`。

默认禁止上传整个项目。Chat 默认只使用用户显式引用、当前文件摘要、当前选区与最近诊断。Agent 默认使用项目树摘要、搜索结果与相关文件片段，并受预算裁剪。

## Code Index 策略

Phase 0 只提供接口和 Mock/空实现。后续文件索引必须遵守 `.gitignore`、项目 ignore 配置、二进制过滤、大文件阈值和敏感文件规则。Embedding 索引必须单独 ADR。

## Tool Calling 策略

工具必须登记名称、入参 schema、出参 schema、`readOnly`、`destructive`、`requiresConfirmation`。

第一版默认启用只读工具与 `propose_patch`，默认禁用 `apply_patch`、`run_command`、`stage_file`、`create_commit`。

## Patch Apply 策略

模型只能提出 patch。应用前必须校验 `originalHash`，展示 diff 预览，用户确认后应用。多文件 patch 必须支持失败回滚；失败时保留原文件。

## Inline Completion 策略

Inline completion 必须支持防抖、取消旧请求、光标移动取消、Tab 接受、Esc 拒绝、最大请求频率和开关。不得自动接受，不得保存文件，不得污染 undo 栈。

## Agent Runtime 策略

Phase 0/1 只允许只读工具 + patch 生成。写文件、运行命令、安装依赖、Git 操作、读取大量文件和访问敏感路径必须显式确认。

## 权限与 capability

AI capability 拆分为：

- `ai.json`：配置、MockProvider、chat、completion 等基础能力。
- `ai-index.json`：索引能力。
- `ai-tools-readonly.json`：只读工具。
- `ai-tools-write.json`：写工具，默认不启用或必须单独确认。

写能力不得和只读能力混用。

## 凭证存储

API Key、token、secret、refresh token 禁止进入前端 store。真实 Provider 启用前必须接入 Tauri Stronghold 或系统 keyring。Phase 0 使用 `CredentialStore mock`，不保存真实凭证。

## 审计日志

必须记录 AI 配置、chat、inline、code action、agent、tool、patch、index 等事件，但不得包含 prompt 原文、completion 原文、API Key、文件全文、完整 diff 或完整 terminal output。

## 回滚方案

- Provider 层通过配置退回 MockProvider。
- Patch 应用失败时由 `ai_patch::rollback` 保留/恢复原文件。
- 前端功能可通过 `store/ai.ts` 关闭 chat、inline completion、agent。
- capability 可拆分回收写能力而保留只读 AI 能力。

## 当前决策

在本 ADR Accepted 前：

1. 只实现 Phase 0 架构基线。
2. 只允许 MockProvider。
3. 不接入真实外部模型 Provider。
4. 不持久化密钥。
5. 不自动修改文件。

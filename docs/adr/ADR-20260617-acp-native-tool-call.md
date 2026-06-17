# ADR-20260617 · ACP-native 工具调用接入与 thread VM 归一

- 状态：已采纳（Accepted）
- 日期：2026-06-17
- 相关：ADR-20260614（ask_user / HITL，复用其 `request_permission`→approval 同源结论）；
  本 ADR 同时**正式 consolidate** 此前散落在 `src/types/ai/thread/*` 代码注释里、
  但从未落盘的「thread 协议模型」决策（注释中以 `ADR-0011 / 0012 / 0013` 指代，
  `docs/adr/` 下并无对应文件）。自此 thread 协议 VM 以本 ADR 为准。

## 背景

我们用 ACP（Agent Client Protocol）把 Kimi 等外部 coding agent 接入 calamex。
ACP 的 `session/update` 会推送 `tool_call` / `tool_call_update`，自带：

- `toolCallId`（稳定标识，贯穿 started → update → completed）
- `kind`（`read` / `edit` / `delete` / `move` / `search` / `execute` / `fetch` / `think` / `switch_mode` …）
- `status`（`pending` / `in_progress` / `completed` / `failed`）
- 结构化 `content[]`（判别联合 `{ type: 'content' | 'diff' | 'terminal' }`）
- `locations[]`、`rawInput`、`rawOutput`

现状三处断点（已逐一对源码核实）：

1. **后端丢弃**：`src-tauri/src/acp/ui_event.rs` 对 `tool_call` / `tool_call_update` / `plan`
   一律 `return None`，ACP 富信息在宿主层即被丢弃（此前被取消的那版是「压成纯文本 preview」，
   现行 committed 版本则是直接丢）。
2. **两套 VM 并存且漂移**：
   - `src/types/ai/thread/*`（`tool-call.schema.ts` 等）是 **kind 驱动**的协议 VM
     （`id` = ACP `toolCallId`、`kind` 带 `.catch('other')`、`content` 判别联合 `content|diff|terminal`、
     `rawInput` / `rawOutput`），但**从未接进实时渲染链路**。
   - `src/components/business/ai/thread/projection/entry-types.ts` 是 **icon/name 驱动**的渲染 VM，
     **没有 `kind` 字段**，靠 `buildZedToolLabel` 正则猜工具语义——这是组件实际消费的那套。
3. **工具目录封闭**：Kimi 是 openWorld，工具名不在自研目录 → 全量 fallback，图标/标签错位。

根因不是「渲染层不分派」（`AiThreadToolCall.vue` 已按 `content` 类型分派 raw/text/terminal/diff），
而是 **上游没把 ACP 富信息送上来 + 中游两套 VM 没合一**。

## 决策

### D1 · ACP 作为平级「第二语言」，不塞进 Mastra 契约

`TAgentRuntimeEvent`（`src/types/ai/sidecar.ts`）是 **Mastra 自家遥测契约**（编译期穷尽断言 +
高漂移告警区）。ACP 与 Mastra 是两套语义体系，**不得**把 ACP 形状硬塞进 `agent_event` /
`TAgentRuntimeEvent`。改为在 `TAgentUiEvent` 判别联合上**新增平级变体**
`tool_call` / `tool_call_update`，直接引用 `@agentclientprotocol/sdk` 的类型。

> 依赖名以 `package.json` 为准：**`@agentclientprotocol/sdk`（无连字符）`^0.26.0`**。
> 复用其 `ToolCall` / `ToolCallUpdate` / `ToolCallContent`，不要自造结构体。

### D2 · Rust host 最小透传，不伪造 base 字段

`ui_event.rs` 把 ACP `tool_call(_update)` 原样投影为新 UI 事件，携带
`toolCallId / title / kind / status / content[] / locations[] / rawInput / rawOutput`。
**不伪造** `runId / agentId / timestamp / seq / schemaVersion / redacted` 等 Mastra 遥测专属字段
（那些是 `agent_event` 才有的契约）。移除该文件顶部的 `#![allow(dead_code)]`。

### D3 · thread VM 归一到协议模型（两套合一）

采用「彻底」方案：渲染链路从 `IAiChatMessage → projection/entry-types.ts` 渲染 VM
**迁移到** `src/types/ai/thread` 协议 VM（`ThreadEntry` / `aiThreadToolCallSchema`）。
`entry-types.ts` 的渲染 VM 与 `buildZedToolLabel` 退役为兼容垫片，最终删除。
协议 VM 自此为 thread 渲染的唯一 SoT。

### D4 · 防腐层（ACL）：双 adapter → 统一协议 VM

投影边界做防腐层，**两个 adapter、一个出口**：

- Mastra adapter：`TAgentRuntimeEvent[]`（`agent.tool.started/progress/completed` + diff/terminal
  运行时事件）→ 协议 VM。
- ACP adapter：`tool_call` / `tool_call_update` → 协议 VM。

下游（store / 组件）**只认协议 VM**，不再感知事件来源。归约以 **ACP `toolCallId` 为合并键**
（不是 `toolName`），把 started → update(N) → completed 收敛为同一条 `ThreadEntry`
（`projection/reconcile-thread-entries.ts` 已有骨架，按此键改写）。

### D5 · content 判别联合驱动渲染；kind 驱动开放目录

- 渲染按 `content[]` 的 `type` 分派：`diff` → code-block(merge 视图) / `terminal` → ai-elements `Terminal`
  / `content`(text) → markdown。`AiThreadToolCall.vue` 现有分派保留，改为消费协议 VM 的 `content`。
- 工具图标/标签改为 **`kind` 驱动的开放目录**：未知工具按 `kind` 兜底（`.catch('other')`），
  `mapSidecarToolNameToAiToolName` 由「决定项」降级为「增强层」（命中则美化，未命中不致错）。

### D6 · 权限：ACP `request_permission` → 既有 approval

ACP `request_permission` 复用 `src/components/ai-elements/approval` 与 `acp/approval-bridge.ts`
的 allow-once / reject-once 通道（与 ADR-20260614 同源），不另起 UI。

## 数据契约（新增 UI 事件变体）

在 `src/types/ai/sidecar.ts`（手写 SoT）与 `src/types/ai/sidecar.schema.ts`（zod 镜像）**同步**新增：

```ts
// TAgentUiEvent 联合新增两支（字段引用 @agentclientprotocol/sdk 类型）
| { type: 'tool_call'; toolCall: ToolCall }            // 首次出现
| { type: 'tool_call_update'; update: ToolCallUpdate } // 同 toolCallId 的增量
```

`ToolCall` / `ToolCallUpdate` 关键字段：`toolCallId`、`title`、`kind`、`status`、
`content: ToolCallContent[]`（`{ type: 'content' | 'diff' | 'terminal'; … }`）、`locations`、
`rawInput`、`rawOutput`。协议 VM（`aiThreadToolCallSchema`）以这些字段为入参做归一。

## 落地清单（自底向上，可独立合并）

- [ ] **契约层**：`sidecar.ts` + `sidecar.schema.ts` 新增 `tool_call` / `tool_call_update` 变体（引用 SDK 类型）
- [ ] **Rust host**：`ui_event.rs` 透传 ACP tool_call(_update)；接线 host emit；删 `#![allow(dead_code)]`；`cargo test`
- [ ] **前端 ACL**：新增 ACP→协议 VM adapter + 改造 Mastra→协议 VM adapter；`reconcile-thread-entries.ts` 改为按 `toolCallId` 归并；单测
- [ ] **渲染迁移**：`AiThreadTimeline.vue` / `AiThreadToolCall.vue` 改吃协议 VM；`kind` 驱动图标/标签；`content` 分派 terminal/diff/web
- [ ] **退役**：`projection/entry-types.ts` 渲染 VM + `buildZedToolLabel` 转垫片→删除；`mapSidecarToolNameToAiToolName` 降级为增强层
- [ ] **权限**：ACP `request_permission` 接 `ai-elements/approval`
- [ ] **质量门**：`pnpm lint && pnpm typecheck && pnpm test`（大改跑 `guard` / `size-limit`）；`cd src-tauri && cargo clippy && cargo test`；覆盖率 ≥80% 全局 / ≥90% 核心

## 取舍

- 选「彻底归一」而非「增量并存」：一次性消除两套 VM 漂移、让 ACP 与 Mastra 投影到同一协议模型；
  代价是动 reduce / store / 全部 thread 组件，改动面大，故自底向上分步可合并以控风险。
- ACP 平级新增而非复用 `tool_start` / `tool_result`：保留 ACP 富信息（kind / 结构化 content / locations），
  不被旧的扁平 input/output 契约稀释。
- Rust 只透传不规整：宿主层薄、防腐归一收敛在前端 ACL 单点，便于演进与测试。

# ADR-0013：流式 reduce 与工具调用状态机（对标 push_assistant_content_block / upsert_tool_call / sync_entry）

- **状态（Status）**: Proposed（待 Code Owner 评审）
- **登记日期**: 2026-06-14
- **责任人 / Code Owner**: @xiaojianc
- **父 ADR**: ADR-0011（重构总览）；依赖 ADR-0012（数据模型）
- **关联文件**:
  - 现状：`src/composables/ai/sidecar-events.ts`（约 56KB，命令式增量）、`src/composables/ai/sidecar-stream-listener.ts`、`src/composables/ai/sidecar-orchestrate.ts`、`src/composables/ai/useAiAssistant.ts`（约 78KB）、`src/store/aiConversation.ts`
  - 目标新增：`src/store/aiThread/reduce.ts`（纯函数）、`src/store/aiThread/reduce.spec.ts`（事件回放单测）、`src/store/aiThread/index.ts`（Pinia store 薄封装）
- **参照源码**: `zed-industries/zed` `crates/acp_thread/src/acp_thread.rs`（`push_assistant_content_block`、`upsert_tool_call`、session-update 分发）
- **关联规则**: ADR-0009（前端只消费结果、不内联编排真源；reduce 纯函数、无 I/O）

## 背景（Context）

现状把“流式事件 → 改消息”的逻辑铺在 `sidecar-events.ts`（56KB）与 `useAiAssistant.ts`（78KB）里：命令式、巨型、与 I/O 和 UI 交织，没有统一 reduce 真源，也没有稳定 key 与显式状态机。结果是每次事件容易触发大范围重写、状态切换硬切、难单测。

Zed 的做法是把 session-update 事件归约进线程：

- `SessionUpdate::AgentMessageChunk(content) → push_assistant_content_block(content, false)`
- `SessionUpdate::AgentThoughtChunk(content) → push_assistant_content_block(content, true)`
- `SessionUpdate::ToolCall(tool_call) → upsert_tool_call(tool_call)`（按 id upsert）

## 决策（Decision）

### 1) 纯函数 reducer 作为唯一写入真源

```ts
// 形状示意
function reduceThread(state: Thread, event: ThreadEvent): Thread
```

- `ThreadEvent` 是 ACP `SessionUpdate` 的前端镜像（Zod 校验），至少覆盖：`user_message`、`assistant_message_chunk`、`assistant_thought_chunk`、`tool_call`（新建/更新）、`tool_call_update`、`plan`、`stream_start/stop/cancel/error`。
- reducer **纯函数、无 I/O、无副作用**：输入旧 `Thread` + 事件，输出新 `Thread`（结构共享，未变 entry 保持原引用）。I/O 仍在 `src/services/` 与边车监听（`sidecar-stream-listener.ts`）里，监听器只负责“解析事件 → 调 reducer → 提交 store”。

### 2) 合并规则（对标 push_assistant_content_block）

- `assistant_message_chunk`：找到当前 assistant entry 的最后一个 `chunk`；若它是 `type:'message'` 则把文本 delta 合并进其 `block`，否则**新开**一个 `message` chunk。
- `assistant_thought_chunk`：同理但作用于 `type:'thought'` chunk。
- 由此正文与思维链按到达顺序交织成同一条 `chunks` 流（ADR-0012）。
- 若当前没有“进行中”的 assistant entry（例如紧跟用户消息后的首个 chunk），则先 append 一个新的 `assistant_message` entry 再合并。

### 3) upsert（对标 upsert_tool_call）

- `tool_call` / `tool_call_update`：按 `id` 在 `entries` 中查找已有 `tool_call` entry；命中则**原地更新** `status` / `content` / `rawOutput`，否则 append 新条目。**绝不**对同一 id 重复 append。
- 工具调用作为**独立 entry** 插入到 entries 流中（与 assistant_message 同级），保持时间序。

### 4) 工具调用状态机

合法转移（其余转移记 warning 并忽略，保证鲁棒）：

```
pending → in_progress → completed
                      → failed
pending|in_progress → canceled
```

- 终态（completed/failed/canceled）不可再回退到非终态。
- `stream_cancel` / `stream_error`：把所有非终态 tool_call 收敛到 `canceled` / `failed`，并把进行中的 assistant chunk 标记收尾——对齐现状 `normalizeHydratedMessage` 把中断流收敛为 `cancelled` 的既有语义。

### 5) 稳定 key

- entry key：entry 的 `id`（user/assistant 消息 id、`ToolCallId`）。
- chunk key：`assistantEntryId + ':' + chunkIndex`（chunk 在其消息内的稳定序号）。
- 这些 key 是 ADR-0014 渲染层“只复用、不重挂载”的依据，等价于 Zed `sync_entry` 的 index 对账 + variant 匹配复用。

### 6) Store 仅薄封装

`src/store/aiThread/` 持有 `entries` 响应式状态，action 一律走 `reduceThread`；不再在 store / composable 内联增量逻辑。逐步把 `sidecar-events.ts` 中的增量分支迁出为 reducer 分支，最终瘦身该文件。

## 边界约束（Constraints）

- reducer 必须纯函数、可在 Node 单测中脱离 Vue/Tauri 运行。
- 必须有**事件回放单测**：录制一段真实 ACP 事件序列，断言 reduce 后的 `entries` 形状与状态机轨迹（含中断/取消/错误路径）。
- 不得绕过 reducer 直接 mutate `entries`（杜绝现状的分散写入）。
- 遵守 ADR-0009：reducer 无 I/O，网络/模型调用仍在 `src/services/` 与边车侧。

## 待确认问题（Open Questions）

- `ThreadEvent` 与边车实际事件（`sidecar-events.ts` 现有枚举）的逐项映射表需在实现前补全，确认 thought / diff / terminal / plan 都已透传。
- 同帧多 delta 的合并：在 reducer 层逐事件合并，还是在监听层用 rAF 批量喂给 reducer？建议监听层 rAF 批处理（见 ADR-0014 性能小节），reducer 保持逐事件纯函数。
- 历史超长线程（现状 `AI_CONVERSATION_HISTORY_LIMIT = 200`）下 entries 增长的内存/性能需在 perf 单测（参考现有 `aiConversation.perf.store.spec.ts`）中设预算。

## 结果（Consequences）

- ✅ 写入路径收敛到单一可单测纯函数，状态切换有显式状态机，跳动/重复渲染的根因消除。
- ✅ `sidecar-events.ts` / `useAiAssistant.ts` 的体量与职责显著下降。
- ✅ 与 Zed 的 push/upsert 范式同构，便于对照与扩展。
- ⚠️ 迁移期 reducer 与旧增量逻辑并存，需以回放单测守住等价性，再逐步删除旧分支。

# ADR-0011：AI 会话流式渲染的重构（对标 Zed acp_thread 架构）

- **状态（Status）**: Proposed（待 Code Owner 评审）
- **登记日期**: 2026-06-14
- **责任人 / Code Owner**: @xiaojianc
- **关联文件**:
  - 现状：`src/store/aiConversation.ts`、`src/types/ai/`、`src/types/ai/conversation.schema.ts`、`src/composables/ai/sidecar-events.ts`、`src/composables/ai/useAiAssistant.ts`、`src/composables/ai/sidecar-orchestrate.ts`、`src/components/ai-elements/`、`src/services/session/store.ts`
  - 目标新增：`src/types/ai/thread/`（Zod 真源）、`src/store/aiThread/reduce.ts`（纯函数 reduce）、`src/components/ai-elements/thread/`（entry→组件映射）
- **参照源码（外部，只读参考，不抄代码）**: `zed-industries/zed`
  - `crates/acp_thread/src/acp_thread.rs`（线程/消息/工具调用数据模型 + session-update 分发）
  - `crates/agent_ui/src/entry_view_state.rs`（数据 entry → 视图对象的增量对账）
- **关联 ADR**: ADR-0009（三套 AI 栈边界：前端 I/O 唯一出口 `src/services/`，前端只消费结果不内联编排真源）
- **本 ADR 是入口**：三层细节分别见 ADR-0012（协议/数据模型层）、ADR-0013（reduce/状态机层）、ADR-0014（渲染层 + 迁移）。

## 背景（Context）

当前 AI 对话的流式渲染“僵硬”（生硬、跳动、状态切换硬切、偶发输入被打断），与专业软件（如 Zed、参考截图中的丝滑思维链 UI）差距明显。结合代码现状，根因不在 markdown 渲染器，而在**数据模型与编排范式**：

1. **消息模型是扁平大字符串**。`src/types/ai` 的 `IAiChatMessage.content` 是单个 `string`，线程是 `messages: IAiChatMessage[]`（见 `src/store/aiConversation.ts` 的 `IAiConversationThread.messages`）。没有“entry / chunk”模型，没有独立的“工具调用条目”，没有“正文 / 思维链”分流。流式时只能不断重写同一个字符串字段。
2. **增量编排逻辑庞大且命令式**。`src/composables/ai/sidecar-events.ts`（约 56KB）与 `useAiAssistant.ts`（约 78KB）把“事件 → 改消息”的逻辑摊开成巨型过程式代码，缺少统一的 reduce 真源与稳定 key，难以做“只改该改的”。
3. **缺过渡与状态机**。工具调用没有显式状态机（pending/in_progress/completed/failed/canceled），UI 状态切换无过渡；思维链没有作为一等结构，无法自然交织与自动跟随。

> 注：`markstream-vue` 本身是“整条消息全量渲染”的 markdown 渲染器，本次**保留不替换**。这恰恰要求外层做对：把全量渲染的代价隔离到“当前正在流式的那一个 chunk”，已完成的 entry / chunk 必须冻结，不随新 token 重渲染（详见 ADR-0014）。

## 参照：Zed 的范式（带出处）

以下事实来自实读 Zed 源码，作为本重构“不自创逻辑”的依据：

- 线程是**扁平的 entry 列表**：`AgentThreadEntry { UserMessage, AssistantMessage, ToolCall, CompletedPlan, ContextCompaction }`（`acp_thread.rs`）。
- 助手消息是 **chunk 流**：`AssistantMessage { chunks: Vec<AssistantMessageChunk> }`，`AssistantMessageChunk { Message { block }, Thought { block } }` —— 正文与思维链是同一条流的两种 variant。
- 工具调用是**带显式状态机的独立条目**：`ToolCall { id, label, kind, status, content }`，`ToolCallStatus { Pending, InProgress, Completed, Failed, Canceled }`，`ToolCallContent { ContentBlock, Diff, Terminal }`。
- 流式更新是 **reduce**：`AgentMessageChunk → push_assistant_content_block(content, false)`、`AgentThoughtChunk → push_assistant_content_block(content, true)`、`ToolCall → upsert_tool_call(...)`（按 id upsert，不是 append）。
- 视图是**按 index 对账**：`entry_view_state.rs` 的 `sync_entry(index, ...)` 只在 variant 匹配时复用已有视图对象，否则才新建；用户消息编辑器“仅未聚焦时回写”；工具子视图按 id 缓存“只插入新的”；助手消息按 chunk 持有滚动句柄，最后一个 chunk 是思维链时自动滚到底。

## 决策（Decision）

采用与 Zed 同构的**三层单向数据流**，重写 AI 会话的数据模型与流式编排（重构级，不是小修补），渲染层复用现有 `ai-elements-vue` 与保留的 `markstream-vue`：

1. **协议 / 数据模型层**（ADR-0012）：以 Zod 为单一真源，定义 `ThreadEntry`（UserMessage / AssistantMessage / ToolCall / Plan / ...），`AssistantChunk{ type:'message'|'thought', block }`，`ToolCall{ id, label, kind, status, content }`，`ToolCallStatus` 字面量联合，`ContentBlock` 联合。字段语义对齐 ACP / Zed，不另造命名。
2. **reduce / 状态机层**（ADR-0013）：纯函数 reducer 把流式事件归约进 `entries`——文本/思维 delta 合并进最后一个同类 chunk；工具调用按 id upsert；稳定 key（消息 id / ToolCallId / chunk index）。与 ADR-0009 一致：reduce 是纯函数真源，前端不内联业务编排。
3. **渲染层**（ADR-0014）：`entry → ai-elements-vue 组件`映射；`message` chunk 交给 `markstream-vue`（保留），`thought` 交给 Reasoning/ChainOfThought；工具调用用 Tool + Diff/Terminal。复刻对账细节：稳定 key、未聚焦不回写、子视图只插入新的、思维链自动滚底、`<TransitionGroup>` 过渡、status 状态机驱动样式、rAF 批处理合并同帧多 delta。

## 边界约束（Constraints）

- **保留 markstream-vue**：不引入第二个 markdown 渲染器；平滑由“外层稳定 key + 冻结已完成 chunk + rAF 批处理”实现，而非改渲染器。
- **遵守 ADR-0009**：所有模型 / 网络 I/O 仍经 `src/services/`；reduce 层是纯函数，不做 I/O；前端不内联编排真源。
- **可回退、双轨迁移**：新模型与旧 `IAiChatMessage` 在迁移期并存，逐步切换，期间提供适配器；小步 conventional commits；不留 `.bak`。
- **不自创逻辑**：数据形状、reduce 规则、对账规则均 1:1 对照 Zed 上述出处；偏离需在对应 ADR“待确认问题”登记理由。

## 待确认问题（Open Questions）

- 持久化迁移：现有 `aiConversationPersistSchema` / `salvageHydratedThreads`（逐条救援）如何对接新 entry 模型？建议新增 schema 版本 + 一次性 `migrateLegacyMessages` 升级（详见 ADR-0014）。
- ACP 事件来源：当前流式入口在 `sidecar-events.ts` / `sidecar-stream-listener.ts`，需确认其事件枚举与 ACP `SessionUpdate` 的映射是否完备（thought / tool_call / plan / diff / terminal 是否都已透传）。
- 思维链 UI 形态：截图风格的“域名 chips + 找到的图片 + 流式文本”与 `ai-elements-vue` 的 Sources / InlineCitation / Image / Reasoning 组件映射需在 ADR-0014 final 化。

## 结果（Consequences）

- ✅ 渲染“僵硬”有了结构性解法：单一数据源 + 稳定 key 对账 + 显式状态机 + 过渡，丝滑来自范式而非补丁。
- ✅ 巨型 `sidecar-events.ts` / `useAiAssistant.ts` 的编排职责下沉到可单测的纯函数 reduce，复杂度与回归风险下降。
- ✅ 与 ADR-0009 边界一致；与 Zed 范式同构，后续新增 part 类型成本低。
- ⚠️ 状态为 Proposed：三层细节待 Code Owner 评审 ADR-0012/0013/0014 后再转 Accepted；转 Accepted 前不就地重写为既成事实。
- ⚠️ 迁移期存在新旧两套模型并存的临时复杂度，必须按 ADR-0014 的步骤收敛并删除旧路径。

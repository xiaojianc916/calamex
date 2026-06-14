# ADR-0012：会话数据模型——ThreadEntry / Chunk（Zod 单一真源，对标 Zed acp_thread）

- **状态（Status）**: Proposed（待 Code Owner 评审）
- **登记日期**: 2026-06-14
- **责任人 / Code Owner**: @xiaojianc
- **父 ADR**: ADR-0011（重构总览）
- **关联文件**:
  - 现状：`src/types/ai/`、`src/types/ai/conversation.schema.ts`、`src/store/aiConversation.ts`（`IAiConversationThread` / `IAiChatMessage`）
  - 目标新增：`src/types/ai/thread/entry.schema.ts`、`src/types/ai/thread/content-block.schema.ts`、`src/types/ai/thread/tool-call.schema.ts`、`src/types/ai/thread/index.ts`
- **参照源码**: `zed-industries/zed` `crates/acp_thread/src/acp_thread.rs`
- **关联规则**: Zod 单一真源（运行时校验与 TS 类型同源 `z.infer`），不手写与 schema 漂移的并行接口。

## 背景（Context）

现状消息模型把一条消息压成单个字符串：`IAiChatMessage.content: string` + `stream.status`，线程为 `messages: IAiChatMessage[]`。这导致：

- 正文、思维链、工具调用、来源/引用、图片、diff、终端**全部挤在一条 string 或零散字段里**，无法分别寻址与稳定 key。
- 已有 Zod（`aiChatMessageSchema` 等）只服务“持久化校验”，且 `aiConversation.ts` 顶部注释已自陈“长期方案：把 `IAiChatMessage` 改为 `z.infer<typeof aiChatMessageSchema>”——即当前手写接口与 schema 存在已知漂移。

Zed 的对应模型是**扁平 entry + chunk 流 + 结构化工具调用**（见 ADR-0011 出处）。本 ADR 把它落成 calamex 的 Zod 真源。

## 决策（Decision）

### 1) 单一真源：Zod + z.infer

所有会话结构以 `src/types/ai/thread/*.schema.ts` 的 Zod schema 为唯一真源，类型一律 `export type X = z.infer<typeof xSchema>`。**禁止**再手写与 schema 并行的 `interface`（终结现状的 `IAiChatMessage` 漂移问题）。

### 2) ThreadEntry（对标 `AgentThreadEntry`）

扁平的判别联合（discriminated union），`type` 为判别字段：

```ts
// 形状示意（最终以 schema 为准）
ThreadEntry =
  | { type: 'user_message';      id; createdAt; content: ContentBlock[]; ... }
  | { type: 'assistant_message'; id; createdAt; chunks: AssistantChunk[]; indented?; isSubagentOutput? }
  | { type: 'tool_call';         id; ... ToolCall }
  | { type: 'plan';              id; entries: PlanEntry[] }       // 对标 CompletedPlan
  | { type: 'context_compaction'; id; ... }                      // 对标 ContextCompaction
```

- 线程：`Thread { id, title, titleStatus, createdAt, updatedAt, entries: ThreadEntry[], scrollState? }`，沿用现有 `aiConversation.ts` 的线程元信息（title/titleStatus/scrollState）以最小化迁移面。
- entry 必带稳定 `id`（用于 ADR-0013 的对账 key）。

### 3) AssistantChunk（对标 `AssistantMessageChunk`）

```ts
AssistantChunk =
  | { type: 'message'; block: ContentBlock }
  | { type: 'thought'; block: ContentBlock }
```

正文与思维链是**同一条 `chunks` 流的两种 variant**，保证两者按到达顺序自然交织（这是截图中思维链体验的结构前提）。

### 4) ToolCall（对标 `ToolCall` / `ToolCallStatus` / `ToolCallContent`）

```ts
ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled'
ToolCall = {
  type: 'tool_call'
  id: string            // 对标 acp::ToolCallId，reduce 按它 upsert
  title: string         // 对标 label（预解析展示名）
  kind: ToolKind        // 'read' | 'edit' | 'execute' | 'think' | 'search' | 'other' 等，对齐 acp::ToolKind
  status: ToolCallStatus
  content: ToolCallContent[]
  rawInput?: unknown
  rawOutput?: unknown
}
ToolCallContent =
  | { type: 'content'; block: ContentBlock }
  | { type: 'diff'; diff: DiffPayload }       // 对标 ToolCallContent::Diff
  | { type: 'terminal'; terminalId: string }  // 对标 ToolCallContent::Terminal
```

- `status` 必须是上面五态字面量联合，**包含 `pending`**（已展示但未开始执行），与 Zed 注释一致。
- `content` 是数组，允许一个工具调用产出多块（文本 + diff + 终端混合）。

### 5) ContentBlock（对标 `ContentBlock`）

判别联合，覆盖截图所需的富块：

```ts
ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; src; alt? }
  | { type: 'resource_link'; uri; title? }
  | { type: 'source'; url; title?; favicon? }   // 域名 chips / 引用来源
```

> diff / terminal 不放进 ContentBlock，而是作为 `ToolCallContent` 的独立 variant，与 Zed 一致（它们由专门的子视图承载，见 ADR-0014）。

## 边界约束（Constraints）

- 字段命名对齐 ACP / Zed 语义（`chunks`、`thought`、`tool_call`、`status` 五态、`ToolCallContent` 三态），偏离须在“待确认问题”登记理由。
- schema 必须可用于运行时校验（hydrate / 边车事件入口），并通过 `z.infer` 导出类型；不得新增手写并行接口。
- 旧 `IAiChatMessage` 在迁移期保留，但仅经适配器与新模型互转（见 ADR-0014），不得在新代码路径直接使用。

## 待确认问题（Open Questions）

- `ToolKind` 取值清单：以边车实际产出的工具类型为准对齐 `acp::ToolKind`，需在实现前枚举核对。
- `Plan` / `context_compaction` 是否当前边车会产生？若暂不产生，可先定义 schema 但不渲染（保留扩展位），避免 YAGNI 过度建模——需 Code Owner 确认。
- 持久化形状：新 `Thread.entries` 的持久化 schema 版本号与迁移策略（详见 ADR-0014）。

## 结果（Consequences）

- ✅ 一处定义（Zod）同时供校验与类型，消除现状 `IAiChatMessage` 与 schema 的漂移。
- ✅ 正文/思维/工具/来源/图片各自可寻址、可稳定 key，是 ADR-0013 reduce 与 ADR-0014 渲染的地基。
- ⚠️ 模型扩面带来一次性迁移成本；通过适配器 + schema 版本迁移控制风险。

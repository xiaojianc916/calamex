# ADR-0014：渲染层映射与迁移（entry → ai-elements-vue / markstream-vue，复刻 entry_view_state 对账）

- **状态（Status）**: Proposed（待 Code Owner 评审）
- **登记日期**: 2026-06-14
- **责任人 / Code Owner**: @xiaojianc
- **父 ADR**: ADR-0011（总览）；依赖 ADR-0012（数据模型）、ADR-0013（reduce/状态机）
- **关联文件**:
  - 现状：`src/components/ai-elements/`（已挂载 `ai-elements-vue`）、`markstream-vue`（保留）、`src/store/aiConversation.ts`（持久化/hydrate/救援）、`src/composables/ai/useAiWebSources.ts`、`src/composables/ai/useAiDiffPreview.ts`
  - 目标新增：`src/components/ai-elements/thread/ThreadView.vue`、`AssistantMessageEntry.vue`、`ToolCallEntry.vue`、`UserMessageEntry.vue`、`src/components/ai-elements/thread/entry-component-map.ts`
- **参照源码**: `zed-industries/zed` `crates/agent_ui/src/entry_view_state.rs`（`sync_entry`、`Entry`/`ViewEvent`、聚焦回写、子视图缓存、思维链自动滚底）
- **关联规则**: ADR-0009（组件不直接 I/O，经 `src/services/`）；保留 markstream-vue，不引入第二个 markdown 渲染器。

## 背景（Context）

`markstream-vue` 是**整条消息全量渲染**的 markdown 渲染器（用户明确保留、不替换）。“全量渲染”本身没问题——前提是外层把全量渲染的代价**隔离到“当前正在流式的那一个 message chunk”**，其余已完成的 entry / chunk 必须冻结、保持组件实例与 DOM 不动。这正是 Zed `entry_view_state.rs` 做的事：按 index/variant 复用视图对象，只对变化处重建。

## 决策（Decision）

### 1) entry → 组件映射

`ThreadView.vue` 用 `v-for` 遍历 `thread.entries`，以 ADR-0013 的稳定 key 绑定 `:key`，按 `entry.type` 映射：

| entry / chunk | 组件 |
| --- | --- |
| `user_message` | `ai-elements-vue` Message |
| `assistant_message`.chunks 中 `type:'message'` | **markstream-vue**（保留） |
| `assistant_message`.chunks 中 `type:'thought'` | `ai-elements-vue` Reasoning / ChainOfThought |
| `tool_call` | `ai-elements-vue` Tool（status 驱动徽标） |
| `tool_call.content` 的 `diff` | 复用 `useAiDiffPreview` / code-block |
| `tool_call.content` 的 `terminal` | 现有终端视图（`src/terminal`）/ terminal 组件 |
| `content_block` 的 `source` | Sources + InlineCitation（域名 chips） |
| `content_block` 的 `image` | Image |
| 加载态 | Loader / Shimmer |

### 2) 复刻 entry_view_state 的对账细节（关键，别省）

- **稳定 key + variant 复用**：相同 key 且 type 不变 → Vue 复用组件实例，不重挂载（等价 `sync_entry` 的“variant 匹配才复用”）。type 变了才让 key 变以强制重建。
- **全量渲染隔离**：每个 `message` chunk 是独立 `markstream-vue` 实例并带稳定 key；新 token 只改“最后一个进行中 chunk”的 `block.text`，已完成 chunk 的 props 引用不变 → 不重渲染。已完成的 assistant entry 整体冻结。
- **未聚焦才回写**：用户消息可编辑态时，若输入框聚焦则不让 store 回写覆盖（对齐 Zed UserMessage“仅未聚焦时重写编辑器”）。
- **子视图只插入新的**：工具调用的 diff / terminal 子视图用 `Map<id, instance>` 缓存，已存在的不动，只挂新的（对齐 ToolCall 的 `HashMap<EntityId, AnyEntity>` + `or_insert_with`）。
- **思维链自动滚底**：当最后一个 chunk 是 `thought` 且处于流式时，`watch` 其内容把该 chunk 滚到底（对齐 `AssistantMessageEntry::sync` 的 scroll-to-bottom）；用户手动上滚时暂停自动跟随。

### 3) 过渡与状态机（现状缺失项）

- entry / tool_call 的进出用 `<TransitionGroup>`，做 enter/leave + 高度淡入，消除“硬插入”。
- `ToolCallStatus` 驱动徽标与样式，pending→in_progress→completed/failed 用 CSS transition 软化。
- 同帧多 delta：在边车监听层（`sidecar-stream-listener.ts`）用 `requestAnimationFrame` 批处理，把一帧内多个 delta 合并成一次 store 提交，再触发一次渲染（reducer 仍逐事件纯函数，见 ADR-0013）。

### 4) 持久化与迁移

- 新增持久化 schema 版本（`Thread.entries`），在 `aiConversation.ts` 的 `afterHydrate` 增加“旧 `messages: IAiChatMessage[]` → 新 `entries`”的一次性迁移（沿用并扩展现有 `migrateLegacyMessages` / `salvageHydratedThreads` 的逐条救援思路，绝不因单条坏数据清空整库）。
- 适配器：`legacyMessageToEntries(message): ThreadEntry[]` 与（迁移期可选）反向适配，保证旧快照可读、新写入为 entries。

## 迁移步骤（落地，可回退、小步提交）

1. **协议层**：落 ADR-0012 的 Zod schema（`src/types/ai/thread/`）+ 类型，纯新增，不接线。
2. **reduce 层**：落 ADR-0013 的 `reduceThread` 纯函数 + 事件回放单测；不接 UI。
3. **适配器 + 双轨 store**：新增 `aiThread` store；提供 legacy↔entries 适配器；旧 UI 仍走旧 store。
4. **渲染层**：新建 `ThreadView.vue` 及映射组件，在功能开关后用新 store 渲染（旧实现并存）。
5. **接线边车**：`sidecar-stream-listener.ts` 解析事件 → `reduceThread` → `aiThread` store；加 rAF 批处理。
6. **对账细节 + 过渡**：补稳定 key、未聚焦不回写、子视图只插入新的、思维链自动滚底、TransitionGroup、status 过渡。
7. **持久化迁移**：`afterHydrate` 增加 legacy→entries 升级 + 救援；perf 单测设预算。
8. **收敛删除**：确认等价（回放单测 + 手测）后，删除 `sidecar-events.ts` / `useAiAssistant.ts` 中被取代的旧增量逻辑与旧渲染路径，移除功能开关。保持无 `.bak`。

## 边界约束（Constraints）

- 保留 markstream-vue；丝滑靠稳定 key + 冻结已完成 chunk + rAF 批处理，不靠换渲染器。
- 组件不直接 `invoke` / `fetch`（ADR-0009）；diff/terminal 复用既有 `src/services/` 与 `src/terminal` 能力。
- 每步独立可回退，迁移期新旧并存但有明确删除收尾；不长期双轨。

## 待确认问题（Open Questions）

- `ai-elements-vue` 各组件（Reasoning/ChainOfThought/Sources/InlineCitation/Tool/Image/Loader/Shimmer）的具体 props 以官方文档为准对齐（开箱即用，无需读其源码）。
- 截图风格（域名 chips + 找到的图片 + 流式文本 + 折叠思维链）到组件的最终视觉映射，需 final 化一版设计。
- 自动滚底与“用户上滚暂停跟随”的阈值，复用现有 `IAiConversationScrollState`（`distanceFromBottom`）的判定。

## 结果（Consequences）

- ✅ 全量渲染的代价被隔离到单个进行中 chunk，已完成内容冻结，流式不再整体抖动。
- ✅ 对账细节 + 过渡 + 状态机补齐，达成截图级丝滑，且不更换 markstream-vue。
- ✅ 迁移分步可回退，最终删除旧巨型路径，复杂度净下降。
- ⚠️ 迁移期存在功能开关与双轨渲染的临时成本，需按步骤收尾。

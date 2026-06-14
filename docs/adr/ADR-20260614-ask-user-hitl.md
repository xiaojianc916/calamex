# ADR-20260614 · AI 反向提问（ask_user / Human-in-the-Loop）

- 状态：已采纳（Accepted）
- 日期：2026-06-14
- 相关：#9811（Mastra tool-suspend 文档）、ADR-20260422（窗口缩放）

## 背景

需要让 Agent 在信息不足时「反向」向用户提问，由用户在对话输入区以
多选 / 单选的方式作答后再继续。要求：

1. 仅在 agent / plan 模式启用。
2. 使用 Mastra 原生 Human-in-the-Loop（真正的挂起 / 恢复），不手搓状态机。
3. 交互：1-5 个问题，每题 3-4 个选项，可单选或多选；每题最后一个选项
   固定为「自由填写」，用户可输入任意内容。
4. UI：主输入框「生长」为问卷（同一容器形变，非弹出新框）；提交后在对话
   流中插入一张居中的「问题 + 回答」卡片。
5. 提问框与回答卡片的边框样式必须与项目主输入框**完全一致**。

## 决策

### 引擎：可挂起工具 `ask_user`

采用 **工具级 HITL**：用 `@mastra/core/tools` 的 `createTool` 暴露 `ask_user`，
在 `execute` 内 `await suspend(payload)` 挂起，等待 `/resume` 注入用户答案。
相比「把 HITL 工作流再包进工具」，工具级挂起更直接，并规避 #11015
（嵌套 suspend 工作流的 Studio 体验问题）。

注册位置：`agent-sidecar/src/engines/tools/tools.ts` 的 `rawTools`
（经 `createToolErrorCircuitBreaker` 包装），与 `read_current_file` 等同级。

### 传输：另起 `agent/ask-user` + `/resume`

不复用既有 `plan/orchestrate` + `/resume` 与 `agent/chat` + `/resolve`，
**另起独立方法名** `agent/ask-user`（命名空间 `calamex.dev`），恢复用配套
`/resume`。理由：语义清晰、与既有审批 / 编排通道解耦、便于独立演进。

### UI：复用 InputGroup 保证边框一致

`src/components/ai-elements/question/QuestionPrompt.vue` 的容器直接复用
`@/components/ui/input-group` 的 `InputGroup`，因此边框 / 圆角 / 阴影 /
聚焦环与主输入框（`PromptInput → InputGroup`）天然一致；提交后的
问答卡片同样沿用该容器样式。组件为纯展示 + 键鼠交互，经 services /
composable 走 IPC，不在组件内直接做 I/O。

## 数据契约

挂起负载（suspend）：

```ts
{
  kind: 'user_question',
  questions: Array<{
    id: string;
    prompt: string;
    multiple: boolean;
    options: Array<{ id: string; label: string; description?: string; kind?: 'choice' | 'free-text' }>;
  }>; // 1-5 题
}
```

恢复负载（resume）：

```ts
{
  answers: Array<{ questionId: string; optionIds: string[]; text?: string }>;
  cancelled?: boolean;
}
```

前端类型见 `src/components/ai-elements/question/types.ts`，
sidecar 侧 zod schema 应与之一一对应。

## 落地清单（后续提交）

- [x] 前端组件 `question/{QuestionPrompt.vue,types.ts,index.ts}`
- [ ] sidecar `ask_user` 可挂起工具 + zod suspend/resume schema
- [ ] 在 `tools.ts` 的 `rawTools` 注册 `ask_user`
- [ ] 传输方法 `agent/ask-user` + `/resume`（`ext-methods.ts` / `acp/agent.ts`）
- [ ] Rust host 透传（`src-tauri/src/acp/*`）
- [ ] 前端 composables / services 接线 + 重新生成 bindings
- [ ] 单测 / 覆盖率（core ≥ 90%）

## 取舍

- 引擎用工具级挂起而非工作流，换取更简单的调用与恢复路径。
- 传输另起而非复用，短期多一套方法，长期解耦更清晰。
- 「恢复模式手动 / 自动」一度被列为待确认项，经评审与 UX 无关，已删除。

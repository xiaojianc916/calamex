# ADR-20260427：AI Chat 代码块渲染

## 状态

Accepted。

## 背景

通用 IDE AI 的 Chat Assistant 需要在对话流中渲染模型输出的 fenced code block。代码块既是展示内容，也是复制、折叠、Patch 预览、文件跳转等 IDE 行为入口。模型输出不可信，渲染层不得直连模型或绕过 patch_engine 修改文件。

## 决策

1. Markdown 解析使用 `markdown-it`，配置 `html: false`，不启用 raw HTML 插件。
2. Markdown HTML 注入前使用 `DOMPurify` 白名单净化。
3. fenced code block 不作为普通 HTML 注入，而解析为结构化 `IAiCodeBlock`，由 Vue 组件 `AiCodeBlock` 渲染。
4. 语言识别采用：fence 标注、上下文、shebang、关键词、启发式、plaintext 回落。白名单外语言全部降级为 `plaintext`。
5. 高亮选型为 Shiki。首版允许高亮失败时降级为 escaped plaintext；后续接入本地 Aster 主题资源和可见区分片高亮。
6. Chat 中不嵌入 Monaco 实例，不运行代码。
7. 代码块的复制、折叠、换行状态留在前端会话态，不持久化代码原文。
8. Apply 能力必须通过 `ai_propose_patch` → `AiPatchPreview` → `ai_apply_patch`，不得直接写编辑器 buffer。

## 选型对比

- Shiki：TextMate 语法，与 VS Code / Monaco 主题源更一致，适合 IDE 视觉统一。缺点是 WASM 与语言加载需要性能预算。
- highlight.js：启发式方便，但视觉与编辑器主题一致性弱。
- Prism：轻量，但语言覆盖和 TextMate 一致性不足。
- Monaco tokenize：不在聊天气泡中嵌 Monaco，避免重量与职责越界。

## 安全模型

- fence info 只接受 `^[a-zA-Z0-9_+-]{0,32}$` 的语言段。
- 代码块内容不进入审计日志、运行日志或遥测。
- HTML 关闭 raw input 并经 DOMPurify 白名单。
- 白名单外语言不传入 Shiki。

## 性能预算

首版目标：常规代码块渲染不阻塞对话滚动；高亮失败或超时降级为 plaintext。完整预算登记到后续 `docs/performance-budget.md`。

## 回滚方案

如 Shiki 或 Markdown pipeline 出现风险，可保留 `AiMarkdown` 分段能力，将所有 code block 降级为 plaintext + monospace，禁用 Apply 与 path 跳转入口。

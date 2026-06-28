# ADR 0001：提示词系统改用 Handlebars 模板 + 强类型上下文

- 状态：已采纳
- 日期：2026-06-14

## 背景

旧的 `engines/prompts/system-prompt.ts` 用扁平字符串数组拼接系统提示词，文案与
组装逻辑混杂、段落漏拼不会报错、UI 上下文直接塞进 ```text 围栏缺乏防注入约束。

我们以 Zed 的 agent 提示词架构为工程参考（`crates/agent/src/templates.rs`、
`crates/agent/src/templates/system_prompt.hbs`、`crates/prompt_store/src/prompts.rs`）：
模板与逻辑分离、强类型渲染上下文、Handlebars 严格模式（缺字段即报错）、对不可信
内容做转义防注入、能力驱动的条件段落。

## 决策

1. 引入 `handlebars` 运行时依赖，使用隔离环境（`Handlebars.create()`）+ `strict`
   + `noEscape` 编译模板。strict 复刻 Zed 的 strict_mode；noEscape 因提示词是
   Markdown 纯文本而非 HTML。
2. 提示词上下文强类型化为 `ISystemPromptContext`，布尔标志预计算（对齐 Zed 的
   `has_rules`/`has_skills`）。装配（domain）与渲染（templates）彻底分离。
3. 不可信 UI 上下文在装配阶段防注入：动态选择代码围栏长度（标准 CommonMark 做法）
   避免 ``` 提前闭合；标签经清洗折叠换行/反引号。
4. 目录按领域分层：`prompts/{domain,render,templates}`，`render` 为公共基础层。
5. 对外 API（`buildSystemPrompt`、`extractVisibleAgentResultText`）保持不变，
   调用方无需改动。

## 影响

- 提示词段落引用缺失字段时在渲染期立即抛错，而非静默劣化。
- 新增 `handlebars` 依赖；拉取后需 `pnpm install`。
- 本轮范围仅"提示词系统"。后续阶段在此基础上推进：消息级上下文注入（把 UI
  引用从系统提示词剥离为消息级上下文 + token 预算选择）、Zed 风格压缩/摘要接线。
- 本轮按用户决定暂不读取 workspace 规则文件（AGENTS.md/.rules 等），留待后续阶段。

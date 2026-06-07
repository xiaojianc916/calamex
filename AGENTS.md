# AGENTS.md

本文是 Calamex 的质量基线。要达到这里的标准才能提交。

## 一、先想后做
- 明确需求与验收标准再动手；有歧义**先停下问**，不猜。
- 需求有多种解读全部列出；有更简洁的方案主动提出。
- 多步任务先给计划 + 每步验收点；改动闭环自验，不把未验证的代码丢给人。

## 二、架构铁律（违反即不合格）
- 前端 I/O **唯一出口是** `src/services/`；组件/视图禁止直接 `invoke`/`fetch`/读写存储。
- 禁 `any`、`@ts-ignore`、`!` 非空断言；一切外部输入经 Zod 校验后才进入类型系统。
- `src/bindings`、`src/generated`、`tauri.contracts.ts` 由 tauri-specta 生成，**不准手改**；要改契约去改 Rust 命令再生成。
- 文件/进程/网络等系统能力必经 Rust 命令；密钥走 keyring，禁入 `localStorage`；`capabilities/` 按域最小授权，CSP 不开 `unsafe-*`。
- 不改对外 IPC 契约、状态机/协议语义；所有“开”都要有对应的“关/退出”清理路径。

## 三、代码标准
- **简洁优先**：只实现需求内功能，不预设扩展/配置点，不为不可能的分支写防御代码。
- **优先复用**现有实现与服务，合并重复逻辑，不造第二套轮子。
- **精准修改**：不顺手重构无关代码/改风格；沿用现有风格；发现无关死代码只标注不删。
- 只清理**本次改动产生的**废弃导入/变量/函数。
- 按域拆模块，拒绝“上帝文件”；资深工程师看了觉得繁杂就重构。

## 四、质量门槛
- 提交前本地绿灯：`pnpm lint` + `pnpm typecheck` + `pnpm test`；改 Rust 加 `src-tauri/` 内 `cargo clippy && cargo test`；大改跑 `pnpm guard`。
- 覆盖率：全局 ≥ 80%，核心域 ≥ 90%；新逻辑必补测试，改动同步更新受影响的用例。
- 性能改动附前后对比数据，不超 `docs/performance-budget.md`；体积由 `pnpm size-limit` 守护。

## 五、提交与决策
- 单分支 `main`（trunk-based），squash 合入；Conventional Commits（lefthook + commitlint 强制）。
- 关键决策沉淀为 ADR（`docs/adr/`）；已 accepted 的 ADR 不就地重写。
- 冲突优先级：**安全 > 类型安全 > 可测性 > 可维护性 > 性能 > 风格**；缺数据先停下确认，不猜测


\---

name: karpathy-guidelines

description: Behavioral guidelines to reduce common LLM coding mistakes: think before coding, simplicity first, surgical changes, goal-driven execution

\---



Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.



\*\*Tradeoff:\*\* These guidelines bias toward caution over speed. For trivial tasks, use judgment.



\## 1. Think Before Coding



\*\*Don't assume. Don't hide confusion. Surface tradeoffs.\*\*



Before implementing:

\- State your assumptions explicitly. If uncertain, ask.

\- If multiple interpretations exist, present them - don't pick silently.

\- If a simpler approach exists, say so. Push back when warranted.

\- If something is unclear, stop. Name what's confusing. Ask.



\## 2. Simplicity First



\*\*Minimum code that solves the problem. Nothing speculative.\*\*



\- No features beyond what was asked.

\- No abstractions for single-use code.

\- No "flexibility" or "configurability" that wasn't requested.

\- No error handling for impossible scenarios.

\- If you write 200 lines and it could be 50, rewrite it.



Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.



\## 3. Surgical Changes



\*\*Touch only what you must. Clean up only your own mess.\*\*



When editing existing code:

\- Don't "improve" adjacent code, comments, or formatting.

\- Don't refactor things that aren't broken.

\- Match existing style, even if you'd do it differently.

\- If you notice unrelated dead code, mention it - don't delete it.



When your changes create orphans:

\- Remove imports/variables/functions that YOUR changes made unused.

\- Don't remove pre-existing dead code unless asked.



The test: Every changed line should trace directly to the user's request.



\## 4. Goal-Driven Execution



\*\*Define success criteria. Loop until verified.\*\*



Transform tasks into verifiable goals:

\- "Add validation" → "Write tests for invalid inputs, then make them pass"

\- "Fix the bug" → "Write a test that reproduces it, then make it pass"

\- "Refactor X" → "Ensure tests pass before and after"



For multi-step tasks, state a brief plan:

```

1\. \[Step] → verify: \[check]

2\. \[Step] → verify: \[check]

3\. \[Step] → verify: \[check]

```



Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.



\---



\*\*These guidelines are working if:\*\* fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

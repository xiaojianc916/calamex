# 工程 SSoT

**代码**：单个文件的行数不允许超过1000行，不要把好几个代码模块写在一个文件中，要拆分为多个文件，方便维护

冲突优先级：安全 > 类型安全 > 可测性 > 可维护性 > 性能 > 风格。歧义 MUST 取保守方案；缺数据 MUST 停下提问，MUST NOT 猜测。偏离任一 MUST / MUST NOT MUST 走 ADR。

**全局**：源码 MUST UTF-8 / LF / 2 空格；前端 MUST TS strict，桌面 MUST Rust + Tauri 2.x;MUST NOT 手改 lock；

**架构**：依赖方向 MUST 单向 UI → composables/store/services → Rust；组件 MUST NOT 直接 `fetch` / `invoke` / 读写存储；I/O MUST 经 `services/` 唯一出口，作为反腐层。

**类型**：MUST NOT 使用 `any` / `@ts-ignore` / 非空断言 `!`；外部输入 MUST 经 Zod 校验；IPC 类型 MUST 由 `tauri-specta` 生成，MUST NOT 手改。

**样式**：Tailwind MUST 采用 CSS-first；主题 MUST 单一源 `shadcn-theme.css`；UI 组件 MUST 经 Shadcn CLI 生成，MUST NOT 混用其他 UI 库；MUST NOT 使用 `!important` 或硬编码主题色。

**状态**：MUST 使用 Pinia setup store 按域拆分；持久化字段 MUST 显式列举，MUST NOT 全量持久化；敏感数据 MUST 走 stronghold / keyring，MUST NOT 入 localStorage。

**Tauri**：能力清单 MUST 按域拆分并最小授权；CSP MUST 禁 `unsafe-inline` / `unsafe-eval`；文件操作 MUST 经 Rust 命令，MUST NOT 前端裸路径；产物 MUST OS 签名，updater MUST 签名校验。

**质量**：性能改动 MUST 附前后对比数据；覆盖率全局 MUST ≥80%、核心域 MUST ≥90%；分支 MUST trunk-based，提交 MUST Conventional Commits，合入 MUST squash；关键决策 MUST 沉淀为 ADR，`accepted` ADR MUST NOT 就地重写。

**桌面 IDE**：Monaco / xterm MUST 单例托管；ShellCheck / shfmt MUST 由 Rust 承担；`useWorkbench` MUST 为视图与 store 间唯一 façade，视图 MUST ≤120 行，façade MUST ≤400 行；终端域 MUST 经 registry + 显式 session，MUST NOT 模块级可变共享；主题派生 MUST 唯一原点 `compose(base, override)`，store MUST NOT 直接写 `document` CSS 变量；Rust 命令 MUST 按域拆模块，`commands/mod.rs` MUST ≤80 行；每功能目录 MUST 附 `MATURITY.md`（green / yellow / red），red 模块 MUST NOT 进入生产可见路径。
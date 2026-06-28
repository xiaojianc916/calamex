# ADR-0009：三套 AI 栈的边界与归属

- **状态（Status）**: Proposed（待 Code Owner 评审）
- **登记日期**: 2026-06-03
- **责任人 / Code Owner**: @xiaojianc
- **关联文件**: `src/composables/ai/`、`src/copilotkit/`、`src/services/`、`src-tauri/src/ai/`、`src-tauri/src/commands/builtin_agent.rs`、`src-tauri/src/builtin_agent/mod.rs`、`builtin-agent/`、`builtin-agent/MATURITY.md`
- **关联规则**: 架构铁律（前端 I/O 唯一出口 `src/services/`；密钥走 keyring；系统能力必经 Rust 命令）

## 背景（Context）

本 ADR 以**当前代码现状**为唯一依据，目的是固化「为什么存在三套 AI 相关栈、各自边界与归属在哪」，避免职责漂移与重复造轮子。

现状下 AI 能力分布在三处，并非冗余，而是按「时延 / 工具生态 / 信任边界」拆分：

1. **前端 AI 编排层**（`src/composables/ai/`、`src/copilotkit/`，经 `src/services/` 出口）
   - 职责：对话 UI、计划「分类 → 生成 → 审批 → 执行」流转、前端工具注册（CopilotKit `useFrontendTool`）、AG-UI 协议适配。
   - 约束：**不**直连模型 / 网络；一切调用经 `src/services/` 反腐层 → Rust IPC 或经 Rust 桥接的边车接口。

2. **Rust AI 命令层**（`src-tauri/src/ai/`、`commands/ai*`、`commands/builtin_agent`）
   - 职责：经 `async-openai` 直连模型，承载**轻量 / 短时**能力（如内联补全、任务分类），用本地 `tokenizers` 计量上下文；并作为系统能力出口持有模型密钥（keyring）。
   - 同时**拥有边车生命周期**：启动 / 健康检查 / 端口 / 随包资源解析的宿主侧桥接由 `commands/builtin_agent` 与 `builtin_agent/mod.rs` 统一负责（见 ADR 关联文件中的打包闭环改造）。

3. **Node Mastra 边车**（`builtin-agent/`）
   - 职责：**重型 / 多步**智能体编排与工具生态——经 MCP 接入顺序思考、Context7、Tavily 网络搜索、TypeScript 语言服务等；计划与记忆基于 libSQL；对外提供 OpenAI 兼容的 HTTP / 流式接口。
   - 归属：进程独立，由 Rust 侧 `commands/builtin_agent` 桥接生命周期；成熟度见 `builtin-agent/MATURITY.md`（推进中）。

## 决策（Decision）

确认上述三层划分，并固化以下边界规则：

- **信任边界**：模型密钥仅存在于 Rust / 边车侧，走 keyring；**禁止**任何密钥或模型直连出现在前端 / `localStorage`。
- **I/O 出口**：前端所有 AI 调用必经 `src/services/`；组件 / 视图禁止直接 `invoke` / `fetch`。
- **能力归属**：
  - 同步、短时、与 IDE 紧耦合的 AI（补全、计量、分类）→ Rust `async-openai`。
  - 长时、多步、需 MCP 工具生态与会话记忆的 agent 编排 → Node Mastra 边车。
  - 二者**不重复实现**同一编排逻辑；前端只消费结果，不内联业务编排真源。
- **边车归属唯一**：边车的发现、随包优先解析、运行期可写目录、日志与端口，统一由 `builtin_agent/mod.rs` 拥有；其他模块不得各自再造解析路径。
- **契约**：前后端 IPC 由 tauri-specta 生成，不手改；改契约改 Rust 命令再生成。

## 边界约束（Constraints）

- 新增 AI 能力前，先判定归属层级（前端编排 / Rust 直连 / 边车），并在本 ADR 登记；跨层调用必须经既有出口。
- 边车为推进中状态，启用任何边车新能力都要有对应的「关 / 退出」清理路径（呼应架构铁律）。

## 待确认问题（Open Questions）

- README「技术栈」提到前端集成了 `ai` SDK。需确认该 SDK 是否存在**从前端直连模型**的代码路径；若有，与「前端 I/O 唯一出口 `src/services/`」铁律存在张力，应收敛到 Rust / 边车侧或明确豁免理由。
- Rust `async-openai` 直连与边车各自覆盖的能力清单需逐项核对，确保无重叠编排。

## 结果（Consequences）

- ✅ 三套 AI 栈的存在理由与边界有据可查，降低职责漂移与重复实现风险。
- ✅ 与 ADR-0008 一致，治理记录以代码现状为准绳。
- ⚠️ 状态为 Proposed：待 Code Owner 核对「待确认问题」后再转 Accepted；转 Accepted 前不就地重写为既成事实。

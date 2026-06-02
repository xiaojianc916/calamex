<div align="center">

# Calamex

**面向 Windows 的 Linux Shell 脚本编辑器 / 轻量 IDE，执行环境由 WSL2 统一驱动。**

在 Windows 上以原生体验编写、格式化、诊断并运行 Shell 脚本——编辑在本地，执行在 WSL2。

[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![Vue](https://img.shields.io/badge/Vue-3.5-4FC08D?logo=vue.js&logoColor=white)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-2021-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%2B%20WSL2-0078D6?logo=windows&logoColor=white)](#运行环境要求)
[![License](https://img.shields.io/badge/License-Apache%202.0-D22128?logo=apache&logoColor=white)](LICENSE)

</div>

---

## 简介

**Calamex** 是一款桌面应用，目标是在 Windows 上为 Shell（`sh` / `bash`）脚本提供接近原生 Linux 的开发体验：编辑器、终端、诊断、格式化、语言服务、Git、远程（SSH/SFTP）以及 AI 辅助集成在同一个工作台中。所有脚本的执行环境统一交由 **WSL2** 承载，避免 Windows 与 Linux Shell 语义之间的差异。

- **产品名**：Calamex（`com.xiaojianc.Calamex`）
- **定位**：开发者工具（Developer Tool）
- **文件关联**：`.sh` / `.bash`
- **分发形态**：Windows 安装包（NSIS）

> 前端通过 Vite 构建并由 Tauri WebView 承载，重负载与系统能力（文件、进程、PTY、Git、网络）全部下沉到 Rust 后端，经类型安全的 IPC 暴露给前端。

## 核心特性

| 能力 | 说明 |
| --- | --- |
| 🖊️ **代码编辑器** | 基于 CodeMirror 6，支持 Bash、Rust、JS/TS、Python、Go、JSON、Markdown 等多语言高亮，内置差异（merge）视图、搜索、自动补全。 |
| 🖥️ **集成终端** | 基于 xterm.js + Rust `portable-pty`，提供真正的 PTY 会话，按 registry + 显式 session 管理，支持 WebGL 渲染、搜索与链接识别。 |
| 🧪 **Shell 工具链** | 集成 **ShellCheck** 静态诊断与 **shfmt** 格式化，并接入 **bash-language-server** 提供 LSP 能力（补全、悬浮、诊断）。 |
| 🌳 **语法解析** | 使用 tree-sitter / tree-sitter-bash 进行结构化解析，支撑高亮与代码理解。 |
| 🔭 **全文 / 结构搜索** | Rust 侧基于 ripgrep 系组件（`grep-searcher`、`globset`、`ignore`）与 `ast-grep`、`nucleo` 模糊匹配，提供高性能项目内搜索。 |
| 🌿 **Git 集成** | 基于 `gix`（gitoxide）实现状态、差异、版本信息等仓库操作。 |
| 🔐 **SSH / SFTP** | 基于 `russh` / `russh-sftp` 的远程连接与文件传输，连接池化管理。 |
| 🤖 **AI 辅助** | 前端集成 CopilotKit、AG-UI 协议与 `ai` SDK，支持脚本理解、补全与对话式辅助；Rust 侧 `async-openai` 调用模型，本地 `tokenizers` 计量上下文。 |
| 🧩 **AI Agent 边车** | 独立的 Node 边车 `agent-sidecar/`，基于 **Mastra** 编排智能体与工具（顺序思考、Context7、Tavily 网络搜索、TypeScript 语言服务等），经 MCP 接入。状态推进中，详见 `agent-sidecar/MATURITY.md`。 |
| 📁 **工作区** | 安全的文件系统命令与实时文件监听（`notify`），所有 I/O 经 Rust 命令出口。 |

## 技术栈

**前端**
- Vue 3.5 + TypeScript（`strict`）
- Vite 8 构建，Vue Router 路由，Pinia（setup store，按域拆分）状态管理
- Tailwind CSS 4（CSS-first）+ Shadcn / reka-ui 组件体系，主题单一源
- CodeMirror 6（编辑器）、xterm.js 6（终端）
- 校验与表单：Zod、vee-validate

**桌面 / 后端**
- Tauri 2.x（`tray-icon`、dialog、store 插件）
- Rust（edition 2021），按域拆分的命令模块（terminal / lsp / git / ssh / search / workspace / ai / shell_tools / script_run / agent_sidecar / window / contracts 等）
- IPC 类型由 `tauri-specta` 自动生成，前后端契约强类型对齐
- 异步运行时 Tokio

**AI 边车（`agent-sidecar/`，Node）**
- 基于 Mastra 的智能体运行时，经 MCP 集成顺序思考、Context7、Tavily、TypeScript 语言服务等工具
- 模型走 OpenAI 兼容接口（`@ai-sdk/openai-compatible`），对外提供 HTTP / 流式服务
- 会话与记忆基于 libSQL；当前为推进中状态（见 `agent-sidecar/MATURITY.md`）

**工程化**
- 包管理：pnpm（workspace）
- 代码质量：Biome（lint/format）、Knip（死代码）、commitlint（Conventional Commits）、lefthook（git hooks）
- 测试：Vitest（单测 + 覆盖率）、Playwright（E2E + a11y）
- 体积守护：size-limit

## 架构概览

依赖方向严格单向，UI 不直接触碰系统能力，所有 I/O 经 `services/` 作为反腐层（ACL）汇聚后调用 Rust：

```
┌─────────────────────────────────────────────┐
│                   Vue 视图层                   │
│            views / components (UI)             │
└───────────────┬───────────────────────────────┘
                │  仅调用
┌───────────────▼───────────────────────────────┐
│   composables / store / services / router       │
│  (Pinia 域 store、façade、类型安全 IPC、CopilotKit) │
└───────────────┬───────────────────────────────┘
                │  tauri-specta 生成的强类型 IPC
┌───────────────▼───────────────────────────────┐
│                  Rust 后端                      │
│  commands: terminal · lsp · git · ssh(+pool) ·  │
│  search · workspace_fs · workspace_watcher ·    │
│  ai · shell_tools · script_run · agent_sidecar ·│
│  window(+stage) · contracts                     │
└───────────────┬───────────────────────────────┘
                │  PTY / WSL 调用
┌───────────────▼───────────────────────────────┐
│              WSL2 / Linux 执行环境               │
│          (脚本与 shell 工具链在此运行)            │
└─────────────────────────────────────────────────┘
```

> AI Agent 能力由独立的 Node 边车 `agent-sidecar/` 承载，Rust 侧经 `commands/agent_sidecar` 桥接其生命周期与 HTTP / 流式接口。

**约束要点**
- 组件 **不** 直接 `fetch` / `invoke` / 读写存储；I/O 唯一出口为 `services/`。
- 不使用 `any` / `@ts-ignore` / 非空断言；外部输入经 Zod 校验；IPC 类型由 `tauri-specta` 生成，不手改。
- 敏感数据走 keyring，不进入 `localStorage`。
- CSP 以 `default-src 'self'` 为基线：脚本源仅允许 `wasm-unsafe-eval`（禁用动态 `eval`），样式因 Tailwind 运行时注入保留 `unsafe-inline`；能力清单按域最小授权；文件操作必须经 Rust 命令。

## 目录结构

```text
.
├── src/                      # 前端（Vue 3 + TS）
│   ├── components/           # UI 组件（含 Shadcn / reka-ui）
│   ├── composables/          # 组合式逻辑
│   ├── copilotkit/           # CopilotKit / AG-UI 集成
│   ├── store/                # Pinia 域 store
│   ├── services/             # IPC / shell / terminal / session 等服务（反腐层）
│   ├── views/                # 页面视图（如 ShellWorkbenchView）
│   ├── layouts/              # 布局组件
│   ├── router/               # Vue Router 路由
│   ├── terminal/             # 终端前端集成（xterm.js）
│   ├── themes/               # 主题派生
│   ├── styles/               # 全局样式（Tailwind）
│   ├── constants/            # 常量定义
│   ├── lib/                  # 通用库 / 封装
│   ├── utils/                # 工具函数
│   ├── types/                # 前端类型定义
│   ├── bindings/             # tauri-specta 生成的类型绑定
│   ├── generated/            # 其他生成产物（如 shell 命令目录）
│   ├── __tests__/            # 前端单元测试
│   ├── App.vue               # 根组件
│   └── main.ts               # 应用入口
├── src-tauri/                # 桌面 / Rust 后端
│   ├── src/
│   │   ├── commands/         # 按域拆分的 Tauri 命令
│   │   ├── terminal/         # PTY / 终端后端
│   │   ├── ai/               # AI 集成（async-openai 等）
│   │   ├── agent_sidecar/    # AI 边车的宿主侧桥接
│   │   ├── assets/           # 后端内置资源
│   │   ├── bin/              # 辅助二进制（如导出 IPC 绑定）
│   │   ├── main.rs           # 应用入口
│   │   └── tauri_bindings.rs # tauri-specta 绑定导出
│   ├── capabilities/         # Tauri 能力清单（最小授权）
│   ├── gen/                  # Tauri 生成产物
│   ├── icons/                # 应用图标
│   ├── resources-bundle/     # 打包随附资源
│   ├── build.rs              # 构建脚本
│   └── tauri.conf.json       # Tauri 配置
├── agent-sidecar/            # 基于 Mastra 的 AI Agent 边车（Node）
│   ├── src/
│   │   ├── engines/          # 智能体 / 编排引擎
│   │   ├── tools/            # MCP 工具（顺序思考、Context7、Tavily 等）
│   │   ├── models/           # 模型接入（OpenAI 兼容）
│   │   ├── http/             # HTTP 服务
│   │   ├── streaming/        # 流式响应
│   │   ├── schemas/          # 数据校验 schema
│   │   ├── web/              # Web 相关能力
│   │   ├── types/            # 类型定义
│   │   └── server.ts         # 边车服务入口
│   └── MATURITY.md           # 成熟度 / 推进状态说明
├── e2e/                      # Playwright 端到端测试
├── scripts/                  # 构建与开发辅助脚本
├── schemas/                  # JSON Schema 等
├── resources/                # 应用资源
├── assets/                   # 仓库静态资源
└── vendor/                   # 第三方内置依赖
```

## 运行环境要求

- **操作系统**：Windows 10/11
- **WSL2**：已安装并配置可用的 Linux 发行版（脚本执行环境）
- **Node.js** ≥ 26
- **pnpm** 11.4（推荐 `corepack enable && corepack prepare pnpm@latest --activate`）
- **Rust** 工具链（通过 [rustup](https://rustup.rs)）
- WSL 内建议具备 `shellcheck`、`shfmt`、`bash-language-server` 以获得完整体验

> 国内网络环境下，建议在 `.cargo/config.toml` 配置 rsproxy 镜像，并设置 `git-fetch-with-cli = true` 以规避 Windows 下的 TLS 握手问题。`pnpm tauri:dev` 启动前会自动运行 `scripts/check-dev-env.mjs` 进行环境自检。

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 启动桌面应用（开发模式，含环境自检）
pnpm tauri:dev
```

仅调试前端（浏览器，不含原生能力）：

```bash
pnpm dev   # http://localhost:1420
```

## 构建

```bash
# 构建 Windows 安装包（NSIS）
pnpm tauri:build

# 仅构建前端产物
pnpm build
```

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 生成 shell 命令目录并启动 Vite 前端开发服务器 |
| `pnpm tauri:dev` | 启动 Tauri 桌面应用（开发模式） |
| `pnpm tauri:build` | 打包桌面安装包 |
| `pnpm lint` | Biome 代码检查 |
| `pnpm format` | Biome 自动修复 / 格式化 |
| `pnpm typecheck` | `vue-tsc` 类型检查 |
| `pnpm test` | Vitest 单元测试 |
| `pnpm test:coverage` | 单测 + 覆盖率 |
| `pnpm test:e2e` | Playwright 端到端测试 |
| `pnpm guard` | 运行全部工程守护检查 |
| `pnpm size-limit` | 构建产物体积守护 |

## 测试与质量

- 全局测试覆盖率 ≥ **80%**，核心域 ≥ **90%**。
- 性能相关改动需附前后对比数据，并设定明确的性能预算。
- 单文件代码行数控制在合理范围，避免“上帝文件”，按域拆分模块。

## 开发约定

- **分支模型**：trunk-based，统一在 `main` 上协作。
- **提交规范**：Conventional Commits；合入采用 squash。
- **关键决策**：沉淀为 ADR，已 `accepted` 的 ADR 不就地重写。
- **冲突优先级**：安全 > 类型安全 > 可测性 > 可维护性 > 性能 > 风格；存在歧义取保守方案，缺数据先停下确认而非猜测。

更多工程规范见仓库根目录 `AGENTS.md`。

## 许可证

本项目以 [Apache License 2.0](LICENSE) 授权发布。

版权所有 © 2026 xiaojianc。

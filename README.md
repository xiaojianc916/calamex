# Calamex

> 面向 WSL2 的 Shell 脚本编辑器——在 Windows 上以原生体验编写、格式化、诊断并运行 Shell 脚本，执行环境统一由 WSL2 驱动。

Calamex（仓库包名 `sh-editor-desktop`）是一款基于 **Tauri 2 + Vue 3 + CodeMirror 6** 构建的桌面应用。它把现代编辑器体验（多语言高亮、LSP、格式化、诊断、模糊搜索）与 Windows 上的 WSL2 执行环境打通，让你在 Windows 原生窗口中编写与运行 Linux Shell 脚本。

## ✨ 功能特性

- **专为 Shell 脚本优化**：针对 `.sh` / `.bash` 的编辑与运行，系统级文件关联。
- **现代编辑器**：基于 CodeMirror 6，内置 Bash、Python、Rust、Go、JS/TS、JSON、Markdown、SQL、HTML/CSS/XML、Vue 等多语言高亮与智能补全。
- **语言智能**：集成 `bash-language-server`（LSP）、`shellcheck`（静态诊断）与 `shfmt`（格式化，以 WASM 运行）。
- **集成终端**：基于 xterm.js + `portable-pty`，直接在 WSL2 中运行命令，支持 WebGL 渲染、搜索与链接识别。
- **AI 辅助**：内置基于 AG-UI / CopilotKit 的 AI 交互能力，辅助脚本编写与理解。
- **Git 集成**：基于 `gix` 的纯 Rust 实现，提供状态与差异查看。
- **强大的搜索**：基于 ripgrep 同源组件（`grep-searcher`）的全文搜索 + `nucleo` 模糊匹配 + `ast-grep` 结构化搜索/替换。
- **远程访问**：内置 SSH/SFTP（`russh` / `russh-sftp`）。
- **原生体验**：无边框自绘窗口、托盘图标，通过 NSIS 生成 Windows 安装包。

## 🧩 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Vue 3 · Vite 8 · TypeScript · Tailwind CSS 4 · Pinia · Vue Router · CodeMirror 6 · xterm.js |
| 后端 | Rust · Tauri 2 · tokio · tonic（gRPC）· tree-sitter · ast-grep · gix |
| Windows ↔ WSL2 | 通过 vsock + gRPC 与 WSL2 内的 `wsl-link` 代理通信，由 `proto/` 下的 protobuf 定义接口 |
| 工具链 | pnpm · Biome（格式化/Lint）· Vitest（单测）· Playwright（E2E）· lefthook · commitlint |

> WebView 可视化托管依赖定制的 `wry` / `tauri-runtime` 分支（见 `src-tauri/Cargo.toml` 中的 `[patch.crates-io]`）。

## 🏗️ 架构概览

Calamex 采用双端架构：

- **Windows 主进程**：Tauri（Rust）+ WebView（Vue）提供 UI 与编辑器。
- **WSL2 代理（`wsl-link` agent）**：在 WSL2 内运行，负责实际的文件访问、PTY 与命令执行。
- 两端通过 **vsock + tonic gRPC** 通信，接口定义位于 `proto/wsl-link/v1`。

这样编辑体验跑在 Windows 原生窗口，而脚本的运行与工具链（bash、shellcheck 等）始终在 Linux（WSL2）环境中执行。

## 📦 环境要求

- **Windows 10/11** 并已启用 **WSL2**
- **Node.js** ≥ 20
- **pnpm** 11.4+（仓库已锁定 `pnpm@11.4.0`）
- **Rust** 工具链（用于构建 Tauri 后端）
- **protoc**（gRPC 代码生成，构建时会自动使用 vendored 版本）

## 🚀 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 检查开发环境（WSL2 / 工具链）
pnpm run check:env

# 3. 启动桌面应用（开发模式）
pnpm run tauri:dev

# 仅启动前端（不拉起 Tauri 壳）
pnpm run dev
```

构建产物：

```bash
# 构建前端产物
pnpm run build

# 构建桌面安装包（NSIS）
pnpm run tauri:build
```

## 🛠️ 常用脚本

| 脚本 | 说明 |
| --- | --- |
| `pnpm dev` | 启动 Vite 开发服务器（1420 端口） |
| `pnpm tauri:dev` | 启动完整桌面应用（开发模式） |
| `pnpm build` | 生成 shell 命令目录 + 类型检查 + 构建前端 |
| `pnpm tauri:build` | 构建桌面安装包 |
| `pnpm test` | 运行 Vitest 单元测试 |
| `pnpm test:e2e` | 运行 Playwright 端到端测试 |
| `pnpm test:coverage` | 运行单测并生成覆盖率报告 |
| `pnpm lint` / `pnpm format` | Biome 检查 / 自动修复 |
| `pnpm typecheck` | `vue-tsc` 类型检查 |
| `pnpm guard` | 运行仓库全部守卫检查 |

## 📁 项目结构

```
.
├─ src/            # 前端（Vue 3 + CodeMirror + 终端 UI）
├─ src-tauri/      # Tauri / Rust 后端（文件、PTY、Git、搜索、LSP 等）
├─ proto/          # gRPC / protobuf 接口定义（wsl-link）
├─ e2e/            # Playwright 端到端测试
├─ scripts/        # 构建与开发辅助脚本
└─ docs/           # 项目文档与 ADR
```

## 📏 开发规范

本仓库以 `AGENTS.md` 为工程唯一事实源（SSoT），核心约束：

- **主干开发 + PR**：不直接推送受保护的 `main`；在分支上开发后提 PR，使用 squash 合并。
- **提交规范**：遵循 Conventional Commits（由 commitlint + lefthook 校验）。
- **代码质量**：TypeScript strict，禁用 `any` / `@ts-ignore` / 非空断言 `!`；单文件建议 < 1000 行，超出需拆分模块。
- **优先级**：安全 > 类型安全 > 可测性 > 可维护性 > 性能 > 风格。性能改动需附前后对比数据。
- **测试覆盖率**：全局 ≥ 80%，核心模块 ≥ 90%。
- **重要决策**：以 ADR 形式记录。

## 📄 许可证

当前为私有项目（`private`），尚未公开授权许可证。

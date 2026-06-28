# Agent Sidecar 打包闭环方案

> 状态：已实现 (Implemented) — 2026-06-03 经基于源码的架构评审核实，步骤 1–5 已在 `main` 落地
> 目标：将 `builtin-agent` 从 `MATURITY.md` 的 **yellow** 推进到“可随安装包交付” ✅ 已达成
> 适用平台：Windows / NSIS（`src-tauri/tauri.conf.json > bundle.targets = ["nsis"]`）

## 0. 落地核实（2026-06-03，以代码为唯一事实源）

本方案不再是草案：步骤 1–5 均已在代码中落地。核实证据（均取自源码，而非文档自述）：

- **步骤 1（`bundled_resource_roots()` 提升为共享工具）✅**：`commands/shell_tools.rs` 中已声明为 `pub(crate) fn bundled_resource_roots()`，注释写明“同时供 builtin_agent 复用”，并被 `builtin_agent/mod.rs` 与 `commands/lsp/discovery.rs` 实际复用。
- **步骤 2（sidecar root 随包优先分支）✅**：`builtin_agent/mod.rs::resolve_builtin_agent_root()` 已在 env 覆盖之后、源码树兜底之前探测 `bundled_resource_roots()/builtin-agent`（以 `package.json` 存在为有效）。
- **步骤 3（Node 可执行文件随包优先）✅**：`resolve_node_executable()` 已把 `bundled_resource_roots()/node/{node.exe,node}` 排在系统候选（`ProgramFiles`、`PATH`）之前。
- **步骤 4（可写状态迁移到用户目录）✅（实现细节略有调整）**：运行时可写目录由 `builtin_agent_runtime_dir()` 统一解析为 `LOCALAPPDATA/com.xiaojianc.Calamex/builtin-agent`（缺失时回退系统临时目录），`builtin-agent.log` 与 `NODE_COMPILE_CACHE` 均落于其下；prod 密钥走 keyring（`current_sidecar_model_config()` + `CredentialStore`），`.env` 仅作 dev 兜底注入。与原方案相比，落地时直接使用 `LOCALAPPDATA` 而非 Tauri 的 `app_log_dir()/app_cache_dir()`，二者皆为用户级可写目录，目标一致。
- **步骤 5（产物布局契约化 + 打包 smoke 校验）✅**：`scripts/prepare-bundle-resources.ts` 头注释声明“产物布局必须与 Rust 的 `bundled_resource_roots()` 拼接路径对齐”，并对 Node、`builtin-agent/dist/server.js`、tsx 启动器、bash-language-server CLI、shellcheck 二进制逐项 `fail()` 断言（即打包后 smoke 校验）。

**遗留（不在本方案范围）**：`MATURITY.md` 原缺口 (2)「危险工具执行的 Rust 后端实现」仍按其自身 ADR 推进，且未在本次架构评审中复核。

---

> 以下为原始方案正文（草案阶段撰写，保留供追溯）。

---

## 1. 背景

`builtin-agent` 是基于 Node + Mastra 的第三个运行时。`MATURITY.md` 自评为 yellow，明确两条缺口：

1. 边车二进制/运行时尚未真正接入 Tauri 打包交付；
2. 危险工具执行仍缺 Rust 侧实现。

本方案聚焦缺口 (1)：打通“**打包 staging → 运行时随包定位**”的闭环。缺口 (2) 另立后续 ADR。

## 2. 现状盘点（基于源码核实，非推测）

### 打包侧——已成熟 ✅

`scripts/prepare-bundle-resources.ts`（由 `build.beforeBundleCommand` 调用）已经做到：

- `stageNode()`：内置 Node 运行时 → `resources-bundle/node/node.exe`（pin 到执行脚本的 node，即 `engines.node>=26`）。
- `stageSidecar()`：复制 `package.json` + `src`，在 staging 目录做自包含 `npm install`（含运行时需要的 tsx），并预编译 `dist/server.js` → `resources-bundle/builtin-agent/{package.json,src,dist,node_modules}`。
- 另内置 bash-language-server / shellcheck / shfmt。

`tauri.conf.json > bundle.resources = ["resources-bundle/**/*"]` 会把上述产物打进安装包。

### 运行时侧——部分闭环 ⚠️

`commands/shell_tools.rs` 已有 `bundled_resource_roots()`：用 `current_exe().parent()` 定位安装目录内的 `resources-bundle`，实现“随包优先 → 系统兼底”。**因此 shellcheck / shfmt / bash-language-server 是闭环的**。

### 缺口（精确定位）🔴

`src-tauri/src/builtin_agent/mod.rs`：

- `resolve_builtin_agent_root()` 只有两条路径：env `XIAOJIANC_BUILTIN_AGENT_ROOT` 覆盖，或 `CARGO_MANIFEST_DIR/../builtin-agent`（**源码树路径**）。**没有 `bundled_resource_roots()` 分支** → 安装后无源码树，定位失败。
- `resolve_node_executable()` 只有 env `XIAOJIANC_NODE_EXE` / `ProgramFiles/nodejs` / `PATH` 三条 → **忽略随包的 `resources-bundle/node/node.exe`**，把“用户自备 Node≥…26”变成隐性前置条件。

即：`prepare-bundle-resources.ts` 头注释承诺的“与 `builtin_agent/mod.rs` 对齐”在 **Node 与 sidecar 这两项上尚未兼现**。

### 可写状态问题 🔴

运行时把 `builtin-agent.log`、`.node-compile-cache`、读取 `.env` 都落在 `sidecar_root`。安装目录（Program Files）只读 → 日志/缓存写入会失败或静默回退 `Stdio::null()`（丢诊断），且 `.env` 不应随包分发。

## 3. 闭环方案

### 步骤 1：`bundled_resource_roots()` 提升为共享工具

把 `bundled_resource_roots()` 从 `shell_tools.rs` 上提到共享位置（如 `commands/mod.rs` 或新建 `commands/bundled_paths.rs`），lsp / shell_tools / builtin_agent 三处复用，消除重复实现。

### 步骤 2：sidecar root 增加“随包优先”分支

在 `resolve_builtin_agent_root()` 的 env 覆盖之后、源码树兼底之前，插入对 `bundled_resource_roots()/builtin-agent` 的探测（存在 `package.json` 即视为有效）。

### 步骤 3：Node 可执行文件优先随包

在 `resolve_node_executable()` 候选列表**最前**加入 `bundled_resource_roots()/node/node.exe`，实现真正“随包优先 → 系统兼底”，去掉对系统 Node 的硬依赖。

### 步骤 4：运行时可写状态迁移到用户目录

- 日志：`app.path().app_log_dir()` 下的 `builtin-agent.log`（进程已注入 `AppHandle`，可取）。
- 编译缓存：`app_cache_dir()/builtin-agent/.node-compile-cache`。
- `.env`：仅 dev 读取；prod 密钥已走 keyring + `current_sidecar_model_config()` 注入，无需随包 `.env`。

### 步骤 5：产物布局契约化

把“`resources-bundle/` 布局 ↔ `bundled_resource_roots()` 拼接路径”收敛为单一来源（Rust 常量与脚本常量互相引用注释），并加一个打包后 smoke 校验：断言 `resources-bundle/node/node.exe` 与 `resources-bundle/builtin-agent/dist/server.js` 存在。

## 4. 验收标准

- 在干净、**未安装 Node** 的 Windows 机器上安装 NSIS 包，首启 AI：sidecar 能用随包 Node 拉起并 `/health` 达到 Ready。
- 安装目录只读时，日志与缓存写入用户目录成功，不再回退 `Stdio::null()` 丢诊断。
- `tauri dev` 行为不变（随包目录不存在 → 候选被 `is_file()` 过滤，回退源码树）。
- 新增单测：`resolve_builtin_agent_root` / `resolve_node_executable` 的随包分支命中与回退顺序。

## 5. 风险与回滚

- **体积**：随包 Node + sidecar `node_modules` 会显著增大安装包；可后续用 SEA/单文件或裁剪 `node_modules` 优化，本期不做。
- **回滚**：以上均为“在候选列表追加分支 + 路径迁移”，不改协议/契约；若打包异常可临时用 env 覆盖（`XIAOJIANC_BUILTIN_AGENT_ROOT` / `XIAOJIANC_NODE_EXE`）兜底。

## 6. 与 MATURITY 的关系

本方案落地后，`MATURITY.md` 缺口 (1) 可清；缺口 (2)（危险工具的 Rust 实现）仍须单独 ADR 推进，不在本范围。

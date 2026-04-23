# ADR-20260423-vendor-wry-visual-hosting

- **日期**：2026-04-23
- **状态**：`accepted`
- **决策者**：@xiaojianc

---

## 背景

Windows 上 Tauri 2 当前经 `tauri-runtime-wry` / Wry 使用 WebView2 windowed hosting。该路径会创建可见 child HWND，并在 `WM_SIZE` 后更新 WebView2 controller bounds。拖拽 resize 时，宿主窗口边框与 WebView2 内容不属于同一个 DirectComposition visual tree，DWM present 可能错帧，表现为白边、黑带或内容滞后一帧。

此前 ADR-20260422 的「底色对齐 + resize 期间抑制动画」只能降低颜色突兀感，不能消除两个合成面的时序差。继续靠 CSS、背景色或非公开环境变量会掩盖根因，因此本 ADR 将治理点上移到宿主层。

## 决策

在本仓库 vendor 并 pin Tauri/Wry 相关运行时 crate，新增 Windows-only WebView2 Visual/Composition Hosting 路径：

1. `vendor/wry` 增加 `visual-hosting` cargo feature 与 `src/webview2/visual_host.rs`，使用 `CreateCoreWebView2CompositionControllerWithOptions` / Direct3D11 / DirectComposition 创建 WebView2 visual，并挂到宿主 HWND 的 DComp tree。
2. `vendor/tauri-runtime` 增加 `visual-hosting` cargo feature。feature 开启时，仅 `label == "main"` 的主窗口设置 `WebviewAttributes.visual_hosting = true`；feature 关闭时默认保持 windowed hosting。
3. `vendor/tauri-runtime-wry` 将 `WebviewAttributes.visual_hosting` 透传到 `wry::WebViewBuilderExtWindows::with_visual_hosting(true)`。
4. `src-tauri/tauri.conf.json` **不**使用自定义 `visualHosting` 字段，避免官方 Tauri JSON schema / npm Tauri CLI 将其判定为 unknown property。启用开关改为 cargo feature：`visual-hosting`。
5. visual hosting 路径补齐鼠标、pointer、focus、DPI、窗口位置通知与 UI Automation provider；键盘与 IME 不手动转发，保持由 WebView2 hidden input HWND 和 `MoveFocus(PROGRAMMATIC)` 接管，避免重复输入。

## Pin 信息

| crate | 版本 | 本地路径 | 偏离点 |
|---|---:|---|---|
| `wry` | 0.54.4 | `vendor/wry` | `visual-hosting` feature、DComp visual host、输入转发、UIA provider |
| `tauri-runtime` | 2.10.1 | `vendor/tauri-runtime` | `WebviewAttributes.visual_hosting` 与主窗口 feature gate |
| `tauri-runtime-wry` | 2.10.1 | `vendor/tauri-runtime-wry` | attributes → Wry builder 透传 |
| `tauri-utils` | 2.8.3 | `vendor/tauri-utils` | 兼容配置结构与 `generate_context!()` token 输出 |

工作区根 `Cargo.toml` 使用 `[patch.crates-io]` 指向上述 vendor 路径。禁止改为 git URL / 分支依赖；同步上游时必须保持 pinned 版本或提交哈希可审计。

## 考虑的备选

| 备选 | 优点 | 缺点 | 否决原因 |
|---|---|---|---|
| 继续沿用 CSS / 背景色缓解 | 代价低 | 两个合成面仍错帧，快速 resize 仍可见撕裂 | 不能根治 |
| WebView2 非公开环境变量强制切 hosting mode | 看似改动小 | WebView2 Loader 未公开该契约，Wry 也不会切 API | no-op，禁止使用 |
| snapshot / overlay 兜底 | 可掩盖部分拖拽画面 | 输入、IME、DPI、多屏、性能复杂度高 | 本期不做遮罩式方案 |
| 等上游 Wry/Tauri 支持 | 维护成本最低 | 无法解决当前产品 resize 质量问题 | 暂不可接受 |

## 影响

- **正面影响**：主窗口 WebView 内容与宿主窗口共享 DComp visual tree，resize 时不再依赖 child HWND bounds 同步。
- **负面影响 / 代价**：需要维护 vendor fork；WebView2 SDK、Wry、Tauri runtime 升级时存在 drift。
- **输入风险**：visual hosting 需要宿主转发 mouse/pointer，并正确处理 focus、DPI、parent position changed、UIA；这些路径已纳入验证矩阵。
- **关联规则**：R-0.2.2、R-16.3.3、R-17.2、R-18.1、R-15.3、G-5。

## 启用与回退

启用：

```powershell
cargo build -p sh-editor --features visual-hosting
pnpm tauri:build -- --features visual-hosting
```

回退：

```powershell
cargo build -p sh-editor --no-default-features
```

若需要完全回到 crates.io 路径，移除工作区根 `Cargo.toml` 的 `[patch.crates-io]` 中四个 vendor patch，并执行 `cargo update -p wry -p tauri-runtime -p tauri-runtime-wry -p tauri-utils`。

## 同步策略

1. 每次 Tauri/Wry 发布后检查上游是否已有 visual hosting / composition controller 支持。
2. 安全补丁优先 cherry-pick 到 vendor fork，并在 PR 描述单列「上游同步」章节。
3. 每月至少一次运行 `cargo tree -p wry` 与 `pnpm tauri info`，确认实际构建仍命中 vendor patch 且 Tauri CLI 配置校验通过。
4. 若 upstream Wry/Tauri 暴露稳定 visual hosting API 与 Tauri config/API，立刻新建 ADR 退出 vendor fork。

## 验证矩阵

- `cargo check -p sh-editor --all-features`
- `cargo clippy -p sh-editor --all-features -- -D warnings`
- `cargo test -p sh-editor --all-features`
- `cargo build --release -p sh-editor --features visual-hosting`
- `cargo build --release -p sh-editor --no-default-features`
- `pnpm tauri info` 必须通过，证明 `tauri.conf.json` 不再含 schema 不认识的自定义字段。
- Spy++ / Win32 枚举：主窗口下不得出现可见 `WRY_WEBVIEW`，`Chrome_WidgetWin_0` 若存在必须为 `0x0`，`TAURI_DRAG_RESIZE_BORDERS` 仅作为 Tauri 无边框 resize 命中测试窗口。
- 人工验证：快速拖拽 resize、中文 IME、Alt-Tab 焦点恢复、多 DPI 显示器移动、鼠标/滚轮/右键、触控/笔（有设备时）、屏幕阅读器 UIA 树。

## 退出条件

满足以下任一条件时，新建 ADR 迁移回官方依赖：

1. Wry 官方提供稳定 visual hosting API，且 Tauri runtime 可在主窗口创建前透传。
2. Tauri 官方配置 schema/API 支持 Windows WebView2 visual hosting。
3. WebView2 windowed hosting 上游修复 resize 错帧问题，并经本项目 240fps resize 录屏验证无撕裂。

---

> 如需推翻本 ADR，MUST 新建新 ADR 并在本文末尾标注 `superseded by ADR-XXXX`，禁止就地修改历史决策。

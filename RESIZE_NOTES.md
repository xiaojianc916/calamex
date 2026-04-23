# Resize Visual Hosting Notes

## 当前实现

Windows 主窗口通过本地 vendor fork 启用 WebView2 Visual/Composition hosting，目标是消除 windowed hosting 下 child HWND 与宿主窗口 resize present 不同步的问题。

- 启用提交：`32d4624 feat(window): enable WebView2 visual hosting for resize`
- 收口 ADR：`docs/architecture/ADR-20260423-vendor-wry-visual-hosting.md`
- 工作区根 `Cargo.toml` 通过 `[patch.crates-io]` 指向 `vendor/wry`、`vendor/tauri-runtime`、`vendor/tauri-runtime-wry`、`vendor/tauri-utils`
- `src-tauri/tauri.conf.json` 不再放 `visualHosting` 自定义字段；该字段不属于 Tauri 官方 schema，会让 npm Tauri CLI 校验失败。

## 如何切换

启用 visual hosting：

```powershell
cargo build -p sh-editor --features visual-hosting
pnpm tauri:build -- --features visual-hosting
```

关闭 visual hosting，回到 windowed hosting 基线：

```powershell
cargo build -p sh-editor --no-default-features
```

完全回退到 crates.io 依赖：移除工作区根 `Cargo.toml` 的四个 `[patch.crates-io]` vendor patch，并执行：

```powershell
cargo update -p wry -p tauri-runtime -p tauri-runtime-wry -p tauri-utils
```

## Spy++ / Win32 验证

验证目标不是颜色是否一致，而是确认 WebView 内容不再由可见 child HWND 承载：

1. 启动 `target/release/sh-editor.exe`（使用 `--features visual-hosting` 构建）。
2. 找到主窗口 class `Tauri Window`。
3. 展开子窗口：
   - 不应出现 `WRY_WEBVIEW` 容器。
   - 允许出现 WebView2 runtime 创建的 `Chrome_WidgetWin_0`，但它必须是 `0x0` 尺寸；该窗口不是内容合成面。
   - `TAURI_DRAG_RESIZE_BORDERS` 是 Tauri 无边框 resize 命中测试窗口，非 WebView 内容。
4. 快速拖拽 resize 或用脚本循环 `SetWindowPos`，进程必须保持响应，画面不得出现 WebView 内容滞后宿主边框的白边/黑带。

## 输入与可访问性回归点

visual hosting 不再依赖可见 child HWND 承载内容，因此必须覆盖以下手工回归：

- 鼠标：点击、拖选、滚轮、右键菜单。
- Pointer：触控/笔（有设备时）tap、drag、pinch。
- 键盘/IME：输入框、Ctrl+A/C/V、Microsoft Pinyin 候选框位置与提交。
- 焦点：Alt-Tab 离开再回来，caret 可见。
- DPI：100% ↔ 150% 显示器间移动，无模糊或错位。
- UI Automation：Inspect.exe / Narrator 能看到 WebView 内容树。

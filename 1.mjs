// scripts/fix-resize-bleed-webview2-default-bg.mjs
// 用法: node scripts/fix-resize-bleed-webview2-default-bg.mjs
// 作用: 原生层把 WebView2 controller.DefaultBackgroundColor 显式设为应用底色 #fafafa,
//       消除窗口上下拖拽时上/下缘露出的白色漏底。仅 Windows 生效,依赖已在 Cargo.toml。
//       改后需 `cargo build`(或 pnpm tauri dev)重新编译 Rust 侧验证。
// 兼容 CRLF/LF;锚点仅匹配 with_webview 那一行,容忍缩进与行尾差异。
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src-tauri/src/main.rs';
const src = readFileSync(FILE, 'utf8');
const EOL = src.includes('\r\n') ? '\r\n' : '\n';

// 只锚定这一行(最稳定),插到它后面。\w+ 容忍变量名,[ \t]* 容忍空白差异。
const OPEN_RE =
  /^[ \t]*let\s+\w+\s*=\s*webview_window\.with_webview\(move \|webview\| unsafe \{[ \t]*$/m;

const BODY = [
  `        // ── 窗口 resize 漏底根因修复(原生层)────────────────────────────────`,
  `        // resize 时原生 HWND 随 OS 拖拽同步变大,但 WebView2 合成面重绘慢至少一帧;未被新帧`,
  `        // 覆盖的那条,显示的是 controller 的 DefaultBackgroundColor —— 其默认值为白 #ffffff,`,
  `        // 并非 tauri.conf backgroundColor / set_background_color 的 #fafafa(那是原生 HWND`,
  `        // 刷子色,在合成器间隙里不生效)。编辑器内容恰为 #ffffff → 左右拖拽右缘露出与内容`,
  `        // 同色、不可见;上/下缘紧贴的 chrome(标题栏/状态栏/侧栏)为 #fafafa → 白露出与之反差`,
  `        // → 仅上下拖拽可见漏底。显式把 DefaultBackgroundColor 设为应用底色 #fafafa(与`,
  `        // --app-bg / set_background_color 同源),上下缘露出即与 chrome 同色而消隐。`,
  `        {`,
  `            use webview2_com::Microsoft::Web::WebView2::Win32::{`,
  `                COREWEBVIEW2_COLOR, ICoreWebView2Controller2,`,
  `            };`,
  `            use windows_core::Interface;`,
  `            if let Ok(controller) = webview.controller().cast::<ICoreWebView2Controller2>() {`,
  `                let _ = controller.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {`,
  `                    A: 255,`,
  `                    R: 250,`,
  `                    G: 250,`,
  `                    B: 250,`,
  `                });`,
  `            }`,
  `        }`,
].join(EOL);

if (src.includes('SetDefaultBackgroundColor')) {
  console.log('[skip] 已设置 DefaultBackgroundColor,无需重复修改');
} else {
  const m = src.match(OPEN_RE);
  if (!m) {
    console.error('[fail] 未匹配到 with_webview 锚点行;请确认 harden_webview_settings 是否仍在 main.rs');
    process.exit(1);
  }
  const openLine = m[0];
  const out = src.replace(OPEN_RE, openLine + EOL + BODY);
  writeFileSync(FILE, out);
  console.log('[ok] main.rs 已注入 WebView2 DefaultBackgroundColor = #fafafa');
  console.log('     下一步: cd src-tauri && cargo build  (或 pnpm tauri dev) 重新编译验证');
}
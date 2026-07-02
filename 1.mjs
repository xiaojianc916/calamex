#!/usr/bin/env node
// startup reveal-first：把「显示纯色窗口」提到 托盘构建 / WebView 加固 / 孤儿收割线程 之前。
// migrate_legacy_storage 与 mount_events 仍保留在 show() 之前（存储正确性 / 事件竞态安全）。
// 纯启动顺序调整，零 UI / 行为语义改动。CRLF/LF 均安全（读入归一化匹配，写回保持原行尾）。
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src-tauri/src/main.rs';
const raw = readFileSync(FILE, 'utf8');
const isCRLF = raw.includes('\r\n');
const src = isCRLF ? raw.replace(/\r\n/g, '\n') : raw;

const OLD = `            let tray_started_at = Instant::now();
            setup_system_tray(app)?;
            emit_startup_step("tauri.setup.tray-ready", app_started_at, tray_started_at);

            timed_step!("tauri.setup.webview-settings-ready", app_started_at, {
                for webview_window in app.webview_windows().into_values() {
                    harden_webview_settings(&webview_window);
                }
            });

            timed_step!("tauri.setup.window-state-ready", app_started_at, {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.unminimize();
                }
            });

            // 孤儿会话收割：启动后台线程，周期性回收页面重载 / 崩溃后被前端遗弃（长时间无心跳）
            // 且无活动运行的交互终端会话，终止其 PTY，避免遗留无人照管的 wsl.exe 进程。只做拆解、
            // 零误杀（带活动运行的会话交由退出清理）。对照 VSCode ptyService.ts 的 orphan 回收。
            {
                let reaper_app = app.handle().clone();
                let reaper_state = app.state::<TerminalSessionState>().inner().clone();
                spawn_orphan_terminal_session_reaper(reaper_app, reaper_state);
            }

            // 原生秒显（对齐 VS Code / Zed / Electron backgroundColor 范式）：窗口配置
            // visible:false，由 Rust 在 setup 阶段直接把原生底色设为应用底色 #fafafa 后立即
            // show()——首帧即一块纯色原生窗口，不依赖前端跑到哪一步、也绝不画任何假骨架。真实
            // UI 壳由 Vue 挂载后作为第一个内容帧无缝接管。这样彻底移除了旧「Rust 等前端 reveal、
            // 前端隐藏态又跑不动」的死锁与 2.5s 兜底轮询。
            timed_step!("tauri.setup.window-revealed", app_started_at, {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ =
                        window.set_background_color(Some(tauri::window::Color(250, 250, 250, 255)));
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });`;

const NEW = `            // window-state 插件在建窗时已恢复尺寸/位置/最大化；此处只补一次 unminimize
            // （保存态为最小化时），保持在 show() 之前，避免「先显示再取消最小化」的闪跳。
            timed_step!("tauri.setup.window-state-ready", app_started_at, {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.unminimize();
                }
            });

            // 原生秒显（对齐 VS Code / Zed / Electron backgroundColor 范式）：窗口配置
            // visible:false，由 Rust 在 setup 阶段直接把原生底色设为应用底色 #fafafa 后立即
            // show()——首帧即一块纯色原生窗口，不依赖前端跑到哪一步、也绝不画任何假骨架。真实
            // UI 壳由 Vue 挂载后作为第一个内容帧无缝接管。这样彻底移除了旧「Rust 等前端 reveal、
            // 前端隐藏态又跑不动」的死锁与 2.5s 兜底轮询。
            //
            // reveal-first：托盘构建、WebView 加固、孤儿收割线程都不影响首帧，且各自有可测的原生
            // 开销（托盘建菜单/图标、harden 走 COM 访问 controller）。故把 show() 提到它们之前，
            // 纯色窗口更早上屏；这些非首帧工作紧随其后在同一 setup 内完成。
            timed_step!("tauri.setup.window-revealed", app_started_at, {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ =
                        window.set_background_color(Some(tauri::window::Color(250, 250, 250, 255)));
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });

            // ↓↓↓ 以下均为非首帧工作，已挪到 show() 之后 ↓↓↓
            let tray_started_at = Instant::now();
            setup_system_tray(app)?;
            emit_startup_step("tauri.setup.tray-ready", app_started_at, tray_started_at);

            timed_step!("tauri.setup.webview-settings-ready", app_started_at, {
                for webview_window in app.webview_windows().into_values() {
                    harden_webview_settings(&webview_window);
                }
            });

            // 孤儿会话收割：启动后台线程，周期性回收页面重载 / 崩溃后被前端遗弃（长时间无心跳）
            // 且无活动运行的交互终端会话，终止其 PTY，避免遗留无人照管的 wsl.exe 进程。只做拆解、
            // 零误杀（带活动运行的会话交由退出清理）。对照 VSCode ptyService.ts 的 orphan 回收。
            {
                let reaper_app = app.handle().clone();
                let reaper_state = app.state::<TerminalSessionState>().inner().clone();
                spawn_orphan_terminal_session_reaper(reaper_app, reaper_state);
            }`;

if (src.includes('以下均为非首帧工作，已挪到 show() 之后')) {
  console.log(`[skip] ${FILE} 已应用 reveal-first。`);
  process.exit(0);
}
const hits = src.split(OLD).length - 1;
if (hits !== 1) {
  console.error(`[abort] ${FILE} 期望 1 处 setup 顺序锚点，实际 ${hits} 处（已归一化行尾）。本地或与 GitHub main 有差异，请贴出 setup(move |app|{...}) 那段。`);
  process.exit(1);
}
const out = src.replace(OLD, NEW);
writeFileSync(FILE, isCRLF ? out.replace(/\n/g, '\r\n') : out, 'utf8');
console.log(`[ok] ${FILE}：window-revealed 已提前到 tray / harden / reaper 之前（行尾 ${isCRLF ? 'CRLF' : 'LF'} 保持）。`);
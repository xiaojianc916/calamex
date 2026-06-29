#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "acp_client")]
mod acp;
mod ai;
mod assets;
#[macro_use]
mod commands;
mod process_guard;
mod storage_paths;
mod tauri_bindings;
mod terminal;

use ai::edit::AiEditState;
use commands::LspManager;
use commands::WorkspaceWatcher;
use commands::{
    TerminalSessionState, shutdown_all_terminal_sessions, spawn_orphan_terminal_session_reaper,
};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use tauri::{
    Manager, WindowEvent,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ICON_ID: &str = "main-tray";
const TRAY_MENU_SHOW_ID: &str = "tray.show-main-window";
const TRAY_MENU_QUIT_ID: &str = "tray.quit-app";
const TRAY_TOOLTIP: &str = "Calamex";

// === 启动日志 ============================================================

fn elapsed_ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn emit_startup_event(event: &str, app_started_at: Instant) {
    tracing::info!(
        scope = "startup",
        event,
        elapsed_ms = elapsed_ms(app_started_at)
    );
}

fn emit_startup_step(event: &str, app_started_at: Instant, step_started_at: Instant) {
    tracing::info!(
        scope = "startup",
        event,
        elapsed_ms = elapsed_ms(app_started_at),
        duration_ms = elapsed_ms(step_started_at)
    );
}

macro_rules! timed_step {
    ($event:expr_2021, $app_started_at:expr_2021, $body:block) => {
        let __step_started_at = std::time::Instant::now();
        $body
        emit_startup_step($event, $app_started_at, __step_started_at);
    };
}

/// 初始化全局 tracing 订阅者：统一结构化日志经 fmt 层输出到 stderr（与原 eprintln 渠道一致）。
/// 启用 env-filter，默认 info 级，可用 RUST_LOG 覆盖；默认的 tracing-log 桥接会捕获 log::* 调用（如 workspace_watcher），不再被静默丢弃。
/// try_init 失败（已存在全局订阅者，如测试）时静默跳过，避免 panic。
fn init_tracing() {
    use tracing_subscriber::{EnvFilter, fmt};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}

// === 生命周期 ============================================================

#[derive(Default)]
struct AppLifecycleState {
    is_quitting: AtomicBool,
    cleanup_done: AtomicBool,
}

impl AppLifecycleState {
    fn mark_quitting(&self) {
        self.is_quitting.store(true, Ordering::SeqCst);
    }

    fn is_quitting(&self) -> bool {
        self.is_quitting.load(Ordering::SeqCst)
    }

    /// 抢占退出清理权：首次调用返回 true，其后恒返回 false，
    /// 保证统一清理逻辑在多入口触发下也只真正执行一次。
    fn begin_cleanup(&self) -> bool {
        self.cleanup_done
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

fn reveal_main_window<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    let Some(window) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// 统一退出清理：幂等地收口所有后台资源（终端会话、LSP、SSH 连接池、ACP 宿主连接）。
/// 由用户主动退出（托盘 / 快捷键 → request_app_exit）与运行时退出事件
/// (RunEvent::ExitRequested / Exit) 共同入口，begin_cleanup 的 CAS 保证只执行一次。
fn run_exit_cleanup<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    let lifecycle = app_handle.state::<AppLifecycleState>();
    lifecycle.mark_quitting();
    if !lifecycle.begin_cleanup() {
        return;
    }

    // 1) 终端会话（同步收口 PTY 子进程）
    let terminal_state = app_handle.state::<TerminalSessionState>();
    if let Err(error) = shutdown_all_terminal_sessions(terminal_state.inner()) {
        tracing::error!("failed to shutdown terminal sessions: {error}");
    }

    // 2) LSP 服务与 SSH 连接池（异步，阻塞等待其优雅退出，
    //    避免遗留 bash-language-server / SSH 子进程与连接）
    let lsp_manager = app_handle.state::<LspManager>();
    tauri::async_runtime::block_on(async move {
        if let Err(error) = commands::lsp_stop(lsp_manager).await {
            tracing::error!("failed to stop LSP server: {error}");
        }
        commands::shutdown_ssh_pool().await;
    });

    // 3) ACP 宿主连接（feature `acp_client`）：关停常驻 stdio 连接，子进程随之回收。
    //    对齐 Zed「连接实体 drop 即关停」语义；幂等，未建立时为空操作。
    //    自此 ACP stdio 宿主是唯一的 sidecar 进程，旧 HTTP sidecar 已移除，无需额外清理。
    #[cfg(feature = "acp_client")]
    app_handle.state::<acp::AcpRuntime>().shutdown();
}

fn request_app_exit<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    run_exit_cleanup(app_handle);
    app_handle.exit(0);
}

// === 系统托盘 ============================================================

fn setup_system_tray<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let show_item = MenuItemBuilder::with_id(TRAY_MENU_SHOW_ID, "显示主窗口").build(app)?;
    let quit_item = MenuItemBuilder::with_id(TRAY_MENU_QUIT_ID, "退出").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let Some(icon) = app.default_window_icon().cloned() else {
        tracing::warn!("missing default window icon, tray setup skipped");
        return Ok(());
    };

    TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(icon)
        .tooltip(TRAY_TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            TRAY_MENU_SHOW_ID => reveal_main_window(app_handle),
            TRAY_MENU_QUIT_ID => request_app_exit(app_handle),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

// === WebView 平台相关 ====================================================

#[cfg(windows)]
fn harden_webview_settings<R: tauri::Runtime>(webview_window: &tauri::WebviewWindow<R>) {
    let label = webview_window.label().to_string();
    let label_for_inner = label.clone();
    let access_result = webview_window.with_webview(move |webview| unsafe {
        let outcome = webview
            .controller()
            .CoreWebView2()
            .and_then(|core| core.Settings())
            .and_then(|settings| {
                // 只关闭默认右键菜单，保留 F12 / Ctrl+Shift+I 等浏览器调试快捷键。
                // Ctrl+S 的白屏问题不能靠关闭所有浏览器加速键来规避，否则会破坏调试入口。
                settings.SetAreDefaultContextMenusEnabled(false)?;
                Ok(())
            });
        if let Err(error) = outcome {
            tracing::warn!(
                "failed to harden WebView2 settings for window {label_for_inner}: {error}"
            );
        }
    });
    if let Err(error) = access_result {
        tracing::warn!("failed to access platform webview for window {label}: {error}");
    }
}

#[cfg(not(windows))]
fn harden_webview_settings<R: tauri::Runtime>(_webview_window: &tauri::WebviewWindow<R>) {}

// === main ================================================================

fn main() {
    // === WebView2 原生遮挡计算修复（Windows）==============================
    // 现象：启动几秒后（有时一进入即触发）整窗点击全部失效——侧边栏、编辑器、
    // 右上角 GitHub 登录同时点不动；但 :hover 仍有反馈、原生窗口仍可拖动/缩放，
    // 控制台无任何报错、无递归更新告警、运行时诊断抓不到现场，rAF=0 而主线程空闲。
    //
    // 根因：并非 JS 死循环 / 覆盖层 / pointer-events / resize 帧泵（均已逐条排除），
    // 而是 Chromium/WebView2 的 CalculateNativeWinOcclusion（原生窗口遮挡计算）在
    // Windows 上把 WebView 子 HWND 误判为“被遮挡”——尤其在窗口由隐藏态(visible:false)
    // show() 之后或一次 resize 之后——于是暂停合成器与计时器(rAF 归零)、停止向“隐藏”
    // 页面派发输入；而 :hover 走合成器缓存、拖窗/缩放走 OS 层故仍有反应，主线程未被
    // 占住故探针测得“线程空闲”，全程不走 JS 错误通道故控制台干净、warnHandler 不触发。
    // 本工程窗口正是 visible:false 延迟显示（见下方 setup 内 fallback-reveal 注释，
    // 作者已记录 WebView2 在不可见窗口下挂起渲染/计时），最易触发该误判。
    //
    // 修复：在任何 WebView2 环境创建之前关闭该特性。必须在 app.build() 之前设置，
    // wry 创建 WebView2 环境时会读取该环境变量。零行为副作用，仅 Windows 生效。
    #[cfg(windows)]
    {
        // SAFETY: main() 的第一条语句，进程刚由 OS 启动，只有主线程存在，
        // 尚未初始化任何 tracing subscriber / async runtime / 后台线程。
        // Rust 2024 edition 中 set_var 成为 unsafe 操作，此处显式标注 unsafe 块。
        unsafe {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                "--disable-features=CalculateNativeWinOcclusion",
            );
        }
    }

    init_tracing();

    // 进程树崩溃兜底（Windows）：把当前进程加入 KILL_ON_JOB_CLOSE 的 Job Object，使本进程
    // 一旦非优雅消失（崩溃 / 被强杀）时，OS 连带终结其后派生的全部子孙进程（node 边车 /
    // wsl.exe / LSP / ssh），作为既有 run_exit_cleanup 优雅清理之外的兜底。须在任何子进程
    // 派生前安装；本工程子进程均为懒派生，故此处足够早。失败仅降级记日志，不中断启动。
    process_guard::install_kill_on_close_job();

    let app_started_at = Instant::now();
    emit_startup_event("tauri.main.start", app_started_at);

    // specta 绑定 builder 在 debug / release 都需要构造(用于 mount_events);
    // 仅在 debug 模式 export TS 文件
    let specta_bindings = tauri_bindings::builder();

    #[cfg(debug_assertions)]
    tauri_bindings::export(&specta_bindings);

    let builder_started_at = Instant::now();
    let app = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("favicon", |context, request, responder| {
            let app_handle = context.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let response = assets::favicon::handle_protocol_request(&app_handle, request).await;
                responder.respond(response);
            });
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .manage(AiEditState::default())
        .manage(AppLifecycleState::default())
        .manage(TerminalSessionState::default())
        .manage(WorkspaceWatcher::default())
        .manage(LspManager::new())
        .on_window_event(|window, event| {
            let WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }
            let app_handle = window.app_handle();
            if app_handle.state::<AppLifecycleState>().is_quitting() {
                return;
            }
            api.prevent_close();
            if let Err(error) = window.hide() {
                tracing::error!("failed to hide main window to tray: {error}");
            }
        })
        .invoke_handler(specta_bindings.invoke_handler())
        .setup(move |app| {
            let setup_started_at = Instant::now();
            emit_startup_event("tauri.setup.start", app_started_at);

            // ACP 宿主连接（feature `acp_client`）：注册进程级托管状态持有者。连接本身按 Zed
            // 做法懒建立（首个 AI 请求经 AcpRuntime::get_or_spawn 时才派生 stdio 子进程），
            // 此处仅登记持有者，App 启动期不派生任何额外子进程。
            #[cfg(feature = "acp_client")]
            app.manage(acp::AcpRuntime::default());

            // 统一本地存储：首启把历史分散目录迁移到 .calamex 根（幂等、绝不阻断启动）。
            storage_paths::migrate_legacy_storage();

            // 挂载 specta 强类型事件;让前端 events.workspaceFsEvent.listen(...) 拿到 typed payload
            specta_bindings.mount_events(app);

            let tray_started_at = Instant::now();
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

            // 兜底显示：窗口配置 visible:false，正常路径由前端 App.vue 挂载后调用
            // apply_window_stage 显示窗口。但若前端在隐藏态停滞（如 WebView2 在不可见
            // 窗口下挂起渲染/计时，导致 reveal 始终不执行），窗口会永远滞留系统托盘、
            // 从托盘强制打开则是白屏。此处兜底：约 2.5s 后若主窗口仍不可见，则由 Rust
            // 主动显示，打破“Rust 等前端、前端隐藏态又跑不动”的死锁。show 幂等，前端
            // 正常路径提前显示时此处自动跳过。
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    let Some(window) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) else {
                        return;
                    };
                    if window.is_visible().unwrap_or(false) {
                        return;
                    };
                    tracing::warn!(
                        scope = "startup",
                        event = "tauri.window.fallback-reveal",
                        "main window still hidden ~2500ms after setup; revealing from native side"
                    );
                    // 兜底前先把原生底色同步为应用底色(#fafafa)，尽量减小首帧纯白。
                    let _ =
                        window.set_background_color(Some(tauri::window::Color(250, 250, 250, 255)));
                    let _ = window.show();
                    let _ = window.set_focus();
                });
            }

            emit_startup_step("tauri.setup.done", app_started_at, setup_started_at);
            Ok(())
        });

    emit_startup_step("tauri.builder.ready", app_started_at, builder_started_at);

    emit_startup_event("tauri.run.start", app_started_at);
    let app = match app.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            tracing::error!("failed to run SH editor: {error}");
            std::process::exit(1);
        }
    };

    // 兜底：即使退出路径未经过 request_app_exit（如外部信号、最后一个窗口关闭），
    // 也在运行时退出事件中触发统一清理；begin_cleanup 的 CAS 保证不会重复执行。
    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            run_exit_cleanup(app_handle);
        }
    });
}

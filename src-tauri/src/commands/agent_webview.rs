//! 内置浏览器的「原生承载」实现(阶段1:后端骨架)。
//!
//! 方案:用 Tauri 官方 multiwebview 能力(`Window::add_child`,需 `tauri/unstable`)
//! 把侧边栏内置浏览器做成主窗口的一个**子 webview**;配合**独立 user-data-folder**
//! 让它跑在独立的 WebView2 进程/环境里,并通过 `additional_browser_args` 打开
//! **独立的 CDP 远程调试端口**(默认绑 127.0.0.1)。这样:
//!   - CDP 端口只存在于 agent 浏览器进程上,主 UI 进程没有调试端口 → agent 物理上够不到主 UI(硬隔离);
//!   - 全程走框架配置,**不手写 COM**;
//!   - agent-sidecar 用 Playwright/Mastra `connectOverCDP(ws://127.0.0.1:<port>)` 驱动它。
//!
//! 门控:真实实现编译在 `native_webview` feature 之下;默认构建编译为「返回错误」的 stub,
//! 因此命令可无条件注册(生成的 TS 绑定始终存在),而默认 `main` 构建零影响、整步可逆。

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

/// 内置浏览器子 webview 的唯一 label(全应用范围内唯一)。
#[cfg(feature = "native_webview")]
const AGENT_WEBVIEW_LABEL: &str = "agent-browser";

/// 宿主主窗口 label(与 main.rs 的 MAIN_WINDOW_LABEL 保持一致)。
#[cfg(feature = "native_webview")]
const HOST_WINDOW_LABEL: &str = "main";

/// wry 注入的默认 WebView2 参数。
/// 注意:设置 `additional_browser_args` 会**整体覆盖** wry 默认值,不带上会触发
/// WebView2 白屏(tauri#13092 / WebView2Feedback#3704),所以必须把默认值一起追加回去。
#[cfg(feature = "native_webview")]
const WRY_DEFAULT_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

#[derive(Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebviewCreateInput {
    /// 初始加载的 URL。
    pub url: String,
    /// CDP 远程调试端口(默认绑 127.0.0.1)。agent-sidecar 用它 connectOverCDP。
    pub remote_debugging_port: u16,
    /// 相对宿主窗口左上角的逻辑横坐标(CSS 像素),来自前端占位元素 getBoundingClientRect。
    pub x: f64,
    /// 相对宿主窗口左上角的逻辑纵坐标(CSS 像素)。
    pub y: f64,
    /// 逻辑宽度(CSS 像素)。
    pub width: f64,
    /// 逻辑高度(CSS 像素)。
    pub height: f64,
}

#[derive(Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebviewBoundsInput {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebviewVisibleInput {
    pub visible: bool,
}

#[derive(Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebviewNavigateInput {
    pub url: String,
}

/// 通过设置顶层 `location` 实现导航。
/// `Webview` 句柄没有 `navigate()`,但 `eval` 是宿主级 JS 注入,对跨域页面同样生效。
/// 用 serde_json 序列化 URL,避免 JS 注入。
#[cfg(feature = "native_webview")]
fn navigate_via_eval(webview: &tauri::webview::Webview, url: &str) -> Result<(), String> {
    let encoded = serde_json::to_string(url).map_err(|e| format!("serialize url failed: {e}"))?;
    let js = format!("window.location.href = {encoded};");
    webview
        .eval(js.as_str())
        .map_err(|e| format!("navigate eval failed: {e}"))
}

/// 创建(或复用)内置浏览器子 webview。
/// 幂等:若已存在则只更新位置/尺寸并导航,不重复创建。
#[tauri::command]
#[specta::specta]
pub async fn agent_webview_create(
    app: AppHandle,
    input: AgentWebviewCreateInput,
    trace_id: Option<String>,
) -> Result<(), String> {
    #[cfg(feature = "native_webview")]
    {
        use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};

        let trace = trace_id.as_deref().unwrap_or("unavailable");
        tracing::info!(
            event = "agent_webview.create",
            url = input.url.as_str(),
            port = input.remote_debugging_port,
            traceId = trace,
        );

        // 已存在 -> 复用:更新 bounds + 导航,避免重复创建。
        if let Some(existing) = app.get_webview(AGENT_WEBVIEW_LABEL) {
            existing
                .set_position(LogicalPosition::new(input.x, input.y))
                .map_err(|e| format!("set_position failed: {e}"))?;
            existing
                .set_size(LogicalSize::new(input.width, input.height))
                .map_err(|e| format!("set_size failed: {e}"))?;
            navigate_via_eval(&existing, &input.url)?;
            return Ok(());
        }

        // WebviewWindow 没有公开的 window() 方法(window 是私有字段);
        // 直接用 Manager::get_window(label) 拿宿主 Window 用于 add_child。
        let window = app
            .get_window(HOST_WINDOW_LABEL)
            .ok_or_else(|| format!("host window `{HOST_WINDOW_LABEL}` not found"))?;

        // 独立 user-data-folder -> 独立 WebView2 进程/环境 -> CDP 端口只开在该进程上,
        // 主 UI 进程没有调试端口,实现与主 UI 的硬隔离。
        let profile_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("resolve app_local_data_dir failed: {e}"))?
            .join("agent_webview_profile");

        let url = input
            .url
            .parse()
            .map_err(|e| format!("invalid url `{}`: {e}", input.url))?;

        // 必须把 wry 默认参数一起追加(否则白屏);
        // --remote-debugging-port 默认绑 127.0.0.1;--remote-allow-origins=* 让 CDP 客户端可连(Chromium 111+ 要求)。
        let browser_args = format!(
            "{WRY_DEFAULT_BROWSER_ARGS} --remote-debugging-port={} --remote-allow-origins=*",
            input.remote_debugging_port
        );

        let builder = tauri::webview::WebviewBuilder::new(AGENT_WEBVIEW_LABEL, WebviewUrl::External(url))
            .data_directory(profile_dir)
            .additional_browser_args(browser_args.as_str());

        window
            .add_child(
                builder,
                LogicalPosition::new(input.x, input.y),
                LogicalSize::new(input.width, input.height),
            )
            .map_err(|e| format!("add_child failed: {e}"))?;

        Ok(())
    }

    #[cfg(not(feature = "native_webview"))]
    {
        let _ = (&app, &input, &trace_id);
        Err("native_webview feature is disabled; rebuild with `--features native_webview`".to_string())
    }
}

/// 同步子 webview 的位置/尺寸(阶段2 由前端占位元素 ResizeObserver 驱动)。
#[tauri::command]
#[specta::specta]
pub async fn agent_webview_set_bounds(
    app: AppHandle,
    input: AgentWebviewBoundsInput,
    trace_id: Option<String>,
) -> Result<(), String> {
    #[cfg(feature = "native_webview")]
    {
        use tauri::{LogicalPosition, LogicalSize, Manager};
        let _ = &trace_id;
        let webview = app
            .get_webview(AGENT_WEBVIEW_LABEL)
            .ok_or_else(|| "agent webview not found".to_string())?;
        webview
            .set_position(LogicalPosition::new(input.x, input.y))
            .map_err(|e| format!("set_position failed: {e}"))?;
        webview
            .set_size(LogicalSize::new(input.width, input.height))
            .map_err(|e| format!("set_size failed: {e}"))?;
        Ok(())
    }

    #[cfg(not(feature = "native_webview"))]
    {
        let _ = (&app, &input, &trace_id);
        Err("native_webview feature is disabled; rebuild with `--features native_webview`".to_string())
    }
}

/// 显示/隐藏子 webview(切走侧边栏、最小化、关闭时用)。
#[tauri::command]
#[specta::specta]
pub async fn agent_webview_set_visible(
    app: AppHandle,
    input: AgentWebviewVisibleInput,
    trace_id: Option<String>,
) -> Result<(), String> {
    #[cfg(feature = "native_webview")]
    {
        use tauri::Manager;
        let _ = &trace_id;
        let webview = app
            .get_webview(AGENT_WEBVIEW_LABEL)
            .ok_or_else(|| "agent webview not found".to_string())?;
        if input.visible {
            webview.show().map_err(|e| format!("show failed: {e}"))?;
        } else {
            webview.hide().map_err(|e| format!("hide failed: {e}"))?;
        }
        Ok(())
    }

    #[cfg(not(feature = "native_webview"))]
    {
        let _ = (&app, &input, &trace_id);
        Err("native_webview feature is disabled; rebuild with `--features native_webview`".to_string())
    }
}

/// 导航到新 URL(地址栏 / 前进后退用)。
#[tauri::command]
#[specta::specta]
pub async fn agent_webview_navigate(
    app: AppHandle,
    input: AgentWebviewNavigateInput,
    trace_id: Option<String>,
) -> Result<(), String> {
    #[cfg(feature = "native_webview")]
    {
        use tauri::Manager;
        let _ = &trace_id;
        let webview = app
            .get_webview(AGENT_WEBVIEW_LABEL)
            .ok_or_else(|| "agent webview not found".to_string())?;
        navigate_via_eval(&webview, &input.url)
    }

    #[cfg(not(feature = "native_webview"))]
    {
        let _ = (&app, &input, &trace_id);
        Err("native_webview feature is disabled; rebuild with `--features native_webview`".to_string())
    }
}

/// 销毁子 webview(整步可逆:关闭即回到无原生承载状态)。幂等:不存在则视作成功。
#[tauri::command]
#[specta::specta]
pub async fn agent_webview_destroy(
    app: AppHandle,
    trace_id: Option<String>,
) -> Result<(), String> {
    #[cfg(feature = "native_webview")]
    {
        use tauri::Manager;
        let _ = &trace_id;
        if let Some(webview) = app.get_webview(AGENT_WEBVIEW_LABEL) {
            webview.close().map_err(|e| format!("close failed: {e}"))?;
        }
        Ok(())
    }

    #[cfg(not(feature = "native_webview"))]
    {
        let _ = (&app, &trace_id);
        Err("native_webview feature is disabled; rebuild with `--features native_webview`".to_string())
    }
}

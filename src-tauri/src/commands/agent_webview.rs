//! Built-in browser native hosting + CDP control plane.
//!
//! Hosting: Tauri multiwebview child webview (Window::add_child, needs tauri/unstable)
//! with an isolated user-data-folder and a CDP remote-debugging port.
//!
//! CDP control plane (final design): after the webview is created, the backend opens a
//! persistent chromiumoxide connection (Browser::connect(http://127.0.0.1:<port>) auto-resolves
//! the webSocketDebuggerUrl from /json/version). It powers:
//!   - back/forward = Page.getNavigationHistory + Page.navigateToHistoryEntry (real history),
//!   - reload = Page.reload,
//!   - console = subscribe Runtime.consoleAPICalled + Log.entryAdded,
//!   - navigation state = subscribe Page.frameNavigated -> recompute url + canGoBack/canGoForward,
//!   - select = Overlay.setInspectMode + Overlay.inspectNodeRequested -> element context.
//! The CDP connection is initiated from Rust (frontend never touches ws://, CSP unchanged).
//!
//! Gating: real impl compiles under `native_webview`; default build is an error stub.
//! Event structs compile unconditionally so generated TS bindings always exist.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

#[cfg(feature = "native_webview")]
const AGENT_WEBVIEW_LABEL: &str = "agent-browser";

#[cfg(feature = "native_webview")]
const HOST_WINDOW_LABEL: &str = "main";

// Default wry browser args; additional_browser_args overrides defaults entirely, so we must
// re-append them or WebView2 white-screens.
#[cfg(feature = "native_webview")]
const WRY_DEFAULT_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

#[derive(Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebviewCreateInput {
    pub url: String,
    pub remote_debugging_port: u16,
    pub x: f64,
    pub y: f64,
    pub width: f64,
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

// === CDP event payloads (compiled unconditionally for TS bindings) ===

/// Main-frame navigation completed -> push latest url + back/forward availability.
#[derive(Debug, Clone, Deserialize, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebviewNavigatedEvent {
    pub url: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

/// One console line (console.* call or browser-level log entry).
#[derive(Debug, Clone, Deserialize, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebviewConsoleEvent {
    /// "log" | "warn" | "error"
    pub level: String,
    pub message: String,
    /// epoch milliseconds
    pub timestamp: f64,
}

/// User picked an element via the select/inspect tool -> element context for the AI.
#[derive(Debug, Clone, Deserialize, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebviewElementPickedEvent {
    /// Page URL the element was picked from.
    pub url: String,
    /// Short "tag#id.class" label for display.
    pub label: String,
    /// Truncated outerHTML for AI context.
    pub outer_html: String,
    /// PNG screenshot (base64, no data: prefix), cropped to the element. May be empty.
    pub screenshot_base64: String,
}

// === CDP session (native_webview only) ===

#[cfg(feature = "native_webview")]
struct CdpSession {
    // Keep the connection alive; dropping Browser closes CDP.
    _browser: chromiumoxide::Browser,
    page: chromiumoxide::Page,
    // handler driver + listener tasks; aborted on teardown.
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

#[cfg(feature = "native_webview")]
fn cdp_session() -> &'static tokio::sync::Mutex<Option<CdpSession>> {
    static SESSION: std::sync::OnceLock<tokio::sync::Mutex<Option<CdpSession>>> =
        std::sync::OnceLock::new();
    SESSION.get_or_init(|| tokio::sync::Mutex::new(None))
}

#[cfg(feature = "native_webview")]
fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

// Map console.* type -> frontend level via serde string (avoids depending on enum variant idents).
#[cfg(feature = "native_webview")]
fn map_console_level(
    ty: &chromiumoxide::cdp::js_protocol::runtime::ConsoleApiCalledType,
) -> &'static str {
    match serde_json::to_value(ty)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .as_deref()
    {
        Some("error") | Some("assert") => "error",
        Some("warning") => "warn",
        _ => "log",
    }
}

#[cfg(feature = "native_webview")]
fn map_log_level(level: &chromiumoxide::cdp::browser_protocol::log::LogEntryLevel) -> &'static str {
    match serde_json::to_value(level)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .as_deref()
    {
        Some("error") => "error",
        Some("warning") => "warn",
        _ => "log",
    }
}

// Join console args into one line via serialized JSON (stable CDP keys).
#[cfg(feature = "native_webview")]
fn stringify_console_args(
    args: &[chromiumoxide::cdp::js_protocol::runtime::RemoteObject],
) -> String {
    let mut parts = Vec::with_capacity(args.len());
    for arg in args {
        let v = serde_json::to_value(arg).unwrap_or(serde_json::Value::Null);
        let part = if let Some(val) = v.get("value") {
            match val {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            }
        } else if let Some(desc) = v.get("description").and_then(|d| d.as_str()) {
            desc.to_string()
        } else if let Some(ty) = v.get("type").and_then(|t| t.as_str()) {
            ty.to_string()
        } else {
            String::new()
        };
        parts.push(part);
    }
    parts.join(" ")
}

// Query navigation history -> emit navigated event (url + canGoBack/canGoForward).
#[cfg(feature = "native_webview")]
async fn emit_navigated(app: &AppHandle, page: &chromiumoxide::Page) {
    use chromiumoxide::cdp::browser_protocol::page::GetNavigationHistoryParams;
    use tauri_specta::Event;

    if let Ok(resp) = page.execute(GetNavigationHistoryParams::default()).await {
        let hist = resp.result;
        let idx = hist.current_index;
        let len = hist.entries.len() as i64;
        let url = hist
            .entries
            .get(idx.max(0) as usize)
            .map(|e| e.url.clone())
            .unwrap_or_default();
        let _ = AgentWebviewNavigatedEvent {
            url,
            can_go_back: idx > 0,
            can_go_forward: idx + 1 < len,
        }
        .emit(app);
    }
}

// Current main-frame URL (best-effort) from navigation history.
#[cfg(feature = "native_webview")]
async fn current_url(page: &chromiumoxide::Page) -> String {
    use chromiumoxide::cdp::browser_protocol::page::GetNavigationHistoryParams;
    if let Ok(resp) = page.execute(GetNavigationHistoryParams::default()).await {
        let hist = resp.result;
        return hist
            .entries
            .get(hist.current_index.max(0) as usize)
            .map(|e| e.url.clone())
            .unwrap_or_default();
    }
    String::new()
}

// Truncate to `max` chars with an ellipsis (keeps AI/console payloads bounded).
#[cfg(feature = "native_webview")]
fn truncate_str(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}\u{2026}")
    }
}

// Build a short "tag#id.class" label from a serialized DOM.describeNode result (stable CDP keys).
#[cfg(feature = "native_webview")]
fn element_label(returns_value: &serde_json::Value) -> String {
    let node = returns_value.get("node").unwrap_or(returns_value);
    let tag = node
        .get("nodeName")
        .and_then(|v| v.as_str())
        .unwrap_or("node")
        .to_lowercase();
    let mut id = String::new();
    let mut classes = String::new();
    if let Some(arr) = node.get("attributes").and_then(|v| v.as_array()) {
        let mut i = 0;
        while i + 1 < arr.len() {
            let name = arr[i].as_str().unwrap_or("");
            let value = arr[i + 1].as_str().unwrap_or("");
            if name == "id" && !value.is_empty() {
                id = format!("#{value}");
            } else if name == "class" {
                classes = value
                    .split_whitespace()
                    .map(|c| format!(".{c}"))
                    .collect::<String>();
            }
            i += 2;
        }
    }
    format!("{tag}{id}{classes}")
}

// Build a screenshot clip Viewport from a serialized DOM.getBoxModel result (content quad).
#[cfg(feature = "native_webview")]
fn box_model_clip(
    returns_value: &serde_json::Value,
) -> Option<chromiumoxide::cdp::browser_protocol::page::Viewport> {
    use chromiumoxide::cdp::browser_protocol::page::Viewport;
    let content = returns_value.get("model")?.get("content")?.as_array()?;
    let x = content.first()?.as_f64()?;
    let y = content.get(1)?.as_f64()?;
    let x2 = content.get(4)?.as_f64()?;
    let y2 = content.get(5)?.as_f64()?;
    Some(Viewport {
        x,
        y,
        width: (x2 - x).abs().max(1.0),
        height: (y2 - y).abs().max(1.0),
        scale: 1.0,
    })
}

// Gather element context (label + outerHTML + cropped screenshot + url) for a picked node.
#[cfg(feature = "native_webview")]
async fn collect_picked_element(
    page: &chromiumoxide::Page,
    backend_node_id: chromiumoxide::cdp::browser_protocol::dom::BackendNodeId,
) -> Option<AgentWebviewElementPickedEvent> {
    use chromiumoxide::cdp::browser_protocol::dom::{
        DescribeNodeParams, GetBoxModelParams, GetOuterHtmlParams,
    };
    use chromiumoxide::cdp::browser_protocol::page::{
        CaptureScreenshotFormat, CaptureScreenshotParams,
    };

    let url = current_url(page).await;

    let outer_html = match page
        .execute(GetOuterHtmlParams {
            backend_node_id: Some(backend_node_id.clone()),
            ..Default::default()
        })
        .await
    {
        Ok(resp) => serde_json::to_value(&resp.result)
            .ok()
            .and_then(|v| {
                v.get("outerHTML")
                    .and_then(|s| s.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default(),
        Err(_) => String::new(),
    };
    let outer_html = truncate_str(&outer_html, 4000);

    let label = match page
        .execute(DescribeNodeParams {
            backend_node_id: Some(backend_node_id.clone()),
            ..Default::default()
        })
        .await
    {
        Ok(resp) => {
            element_label(&serde_json::to_value(&resp.result).unwrap_or(serde_json::Value::Null))
        }
        Err(_) => String::new(),
    };

    let clip = match page
        .execute(GetBoxModelParams {
            backend_node_id: Some(backend_node_id.clone()),
            ..Default::default()
        })
        .await
    {
        Ok(resp) => {
            box_model_clip(&serde_json::to_value(&resp.result).unwrap_or(serde_json::Value::Null))
        }
        Err(_) => None,
    };

    let screenshot_base64 = match page
        .execute(CaptureScreenshotParams {
            format: Some(CaptureScreenshotFormat::Png),
            clip,
            ..Default::default()
        })
        .await
    {
        Ok(resp) => serde_json::to_value(&resp.result)
            .ok()
            .and_then(|v| v.get("data").and_then(|s| s.as_str()).map(str::to_string))
            .unwrap_or_default(),
        Err(_) => String::new(),
    };

    Some(AgentWebviewElementPickedEvent {
        url,
        label,
        outer_html,
        screenshot_base64,
    })
}

// Establish persistent CDP session (background task, with retries: debug port needs a moment).
#[cfg(feature = "native_webview")]
async fn establish_cdp_session(app: AppHandle, port: u16) {
    use futures::StreamExt;

    // Drop any stale session first.
    {
        let mut guard = cdp_session().lock().await;
        if let Some(old) = guard.take() {
            for t in old.tasks {
                t.abort();
            }
        }
    }

    let url = format!("http://127.0.0.1:{port}");
    let mut connected = None;
    for _ in 0..40 {
        match chromiumoxide::Browser::connect(url.clone()).await {
            Ok(pair) => {
                connected = Some(pair);
                break;
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(250)).await,
        }
    }
    let (browser, mut handler) = match connected {
        Some(pair) => pair,
        None => {
            tracing::warn!(event = "agent_webview.cdp.connect_timeout", port = port);
            return;
        }
    };

    let handler_task = tauri::async_runtime::spawn(async move {
        while handler.next().await.is_some() {}
    });

    let mut page_opt = None;
    for _ in 0..40 {
        if let Ok(pages) = browser.pages().await {
            if let Some(first) = pages.into_iter().next() {
                page_opt = Some(first);
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let page = match page_opt {
        Some(p) => p,
        None => {
            tracing::warn!(event = "agent_webview.cdp.no_page");
            handler_task.abort();
            return;
        }
    };

    // Enable Runtime/Log/Page/DOM/Overlay domains so the events fire.
    let _ = page
        .execute(chromiumoxide::cdp::js_protocol::runtime::EnableParams::default())
        .await;
    let _ = page
        .execute(chromiumoxide::cdp::browser_protocol::log::EnableParams::default())
        .await;
    let _ = page
        .execute(chromiumoxide::cdp::browser_protocol::page::EnableParams::default())
        .await;
    let _ = page
        .execute(chromiumoxide::cdp::browser_protocol::dom::EnableParams::default())
        .await;
    let _ = page
        .execute(chromiumoxide::cdp::browser_protocol::overlay::EnableParams::default())
        .await;

    let mut tasks = vec![handler_task];

    // console.* calls
    {
        let app = app.clone();
        let page = page.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            use tauri_specta::Event;
            if let Ok(mut stream) = page
                .event_listener::<chromiumoxide::cdp::js_protocol::runtime::EventConsoleApiCalled>()
                .await
            {
                while let Some(ev) = stream.next().await {
                    let _ = AgentWebviewConsoleEvent {
                        level: map_console_level(&ev.r#type).to_string(),
                        message: stringify_console_args(&ev.args),
                        timestamp: now_ms(),
                    }
                    .emit(&app);
                }
            }
        }));
    }

    // browser-level log entries (network errors, CSP, deprecations)
    {
        let app = app.clone();
        let page = page.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            use tauri_specta::Event;
            if let Ok(mut stream) = page
                .event_listener::<chromiumoxide::cdp::browser_protocol::log::EventEntryAdded>()
                .await
            {
                while let Some(ev) = stream.next().await {
                    let _ = AgentWebviewConsoleEvent {
                        level: map_log_level(&ev.entry.level).to_string(),
                        message: ev.entry.text.clone(),
                        timestamp: now_ms(),
                    }
                    .emit(&app);
                }
            }
        }));
    }

    // main-frame navigation -> recompute url + canGoBack/canGoForward
    {
        let app = app.clone();
        let page = page.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            use futures::StreamExt;
            if let Ok(mut stream) = page
                .event_listener::<chromiumoxide::cdp::browser_protocol::page::EventFrameNavigated>()
                .await
            {
                while let Some(ev) = stream.next().await {
                    let frame = serde_json::to_value(&ev.frame).unwrap_or(serde_json::Value::Null);
                    let is_main_frame = match frame.get("parentId") {
                        None => true,
                        Some(v) => v.is_null(),
                    };
                    if is_main_frame {
                        emit_navigated(&app, &page).await;
                    }
                }
            }
        }));
    }

    // element pick (inspect mode) -> capture element context for the AI
    {
        let app = app.clone();
        let page = page.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            use chromiumoxide::cdp::browser_protocol::overlay::{
                EventInspectNodeRequested, InspectMode, SetInspectModeParams,
            };
            use futures::StreamExt;
            use tauri_specta::Event;
            if let Ok(mut stream) = page.event_listener::<EventInspectNodeRequested>().await {
                while let Some(ev) = stream.next().await {
                    // one-shot: leave inspect mode as soon as the user picks an element
                    let _ = page
                        .execute(SetInspectModeParams {
                            mode: InspectMode::None,
                            highlight_config: None,
                        })
                        .await;
                    if let Some(payload) =
                        collect_picked_element(&page, ev.backend_node_id.clone()).await
                    {
                        let _ = payload.emit(&app);
                    }
                }
            }
        }));
    }

    // initial state so buttons start correct
    emit_navigated(&app, &page).await;

    let mut guard = cdp_session().lock().await;
    *guard = Some(CdpSession {
        _browser: browser,
        page,
        tasks,
    });
}

// CDP session is established by a background task after the webview is created, so for the
// first moments after create the page handle may not exist yet. Wait (bounded) for it to land
// instead of failing immediately, then return a cloned Page handle so callers operate without
// holding the session lock across CDP round-trips. The ~4s bound stays under the frontend nav
// command timeout (5s); a genuinely failed connect surfaces as a caught error.
#[cfg(feature = "native_webview")]
async fn wait_for_cdp_page() -> Result<chromiumoxide::Page, String> {
    for _ in 0..40 {
        if let Some(session) = cdp_session().lock().await.as_ref() {
            return Ok(session.page.clone());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err("CDP session not ready (browser still connecting)".to_string())
}

// CDP history jump (delta=-1 back, +1 forward). Out-of-range is a silent success.
#[cfg(feature = "native_webview")]
async fn cdp_history_go(delta: i64) -> Result<(), String> {
    use chromiumoxide::cdp::browser_protocol::page::{
        GetNavigationHistoryParams, NavigateToHistoryEntryParams,
    };
    let page = wait_for_cdp_page().await?;
    let resp = page
        .execute(GetNavigationHistoryParams::default())
        .await
        .map_err(|e| format!("getNavigationHistory failed: {e}"))?;
    let hist = resp.result;
    let target = hist.current_index + delta;
    if target < 0 || target >= hist.entries.len() as i64 {
        return Ok(());
    }
    let entry_id = hist.entries[target as usize].id;
    page.execute(NavigateToHistoryEntryParams::new(entry_id))
        .await
        .map_err(|e| format!("navigateToHistoryEntry failed: {e}"))?;
    Ok(())
}

// Webview handle has no navigate(); eval is host-level injection that works cross-origin.
#[cfg(feature = "native_webview")]
fn navigate_via_eval(webview: &tauri::webview::Webview, url: &str) -> Result<(), String> {
    let encoded = serde_json::to_string(url).map_err(|e| format!("serialize url failed: {e}"))?;
    let js = format!("window.location.href = {encoded};");
    webview
        .eval(js.as_str())
        .map_err(|e| format!("navigate eval failed: {e}"))
}

/// Create (or reuse) the child webview and start the CDP control plane. Idempotent.
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

        let window = app
            .get_window(HOST_WINDOW_LABEL)
            .ok_or_else(|| format!("host window `{HOST_WINDOW_LABEL}` not found"))?;

        let profile_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("resolve app_local_data_dir failed: {e}"))?
            .join("agent_webview_profile");

        let url = input
            .url
            .parse()
            .map_err(|e| format!("invalid url `{}`: {e}", input.url))?;

        let browser_args = format!(
            "{WRY_DEFAULT_BROWSER_ARGS} --remote-debugging-port={} --remote-allow-origins=*",
            input.remote_debugging_port
        );

        let builder =
            tauri::webview::WebviewBuilder::new(AGENT_WEBVIEW_LABEL, WebviewUrl::External(url))
                .data_directory(profile_dir)
                .additional_browser_args(browser_args.as_str());

        window
            .add_child(
                builder,
                LogicalPosition::new(input.x, input.y),
                LogicalSize::new(input.width, input.height),
            )
            .map_err(|e| format!("add_child failed: {e}"))?;

        let cdp_app = app.clone();
        let cdp_port = input.remote_debugging_port;
        tauri::async_runtime::spawn(async move {
            establish_cdp_session(cdp_app, cdp_port).await;
        });

        Ok(())
    }

    #[cfg(not(feature = "native_webview"))]
    {
        let _ = (&app, &input, &trace_id);
        Err("native_webview feature is disabled; rebuild with `--features native_webview`".to_string())
    }
}

/// Sync child webview bounds.
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

/// Show/hide the child webview.
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

/// Navigate to a new URL (address bar).
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

/// Back one entry (CDP real history).
#[tauri::command]
#[specta::specta]
pub async fn agent_webview_back(app: AppHandle, trace_id: Option<String>) -> Result<(), String> {
    #[cfg(feature = "native_webview")]
    {
        let _ = (&app, &trace_id);
        cdp_history_go(-1).await
    }

    #[cfg(not(feature = "native_webview"))]
    {
        let _ = (&app, &trace_id);
        Err("native_webview feature is disabled; rebuild with `--features native_webview`".to_string())
    }
}

/// Forward one entry (CDP real history).
#[tauri::command]
#[specta::specta]
pub async fn agent_webview_forward(app: AppHandle, trace_id: Option<String>) -> Result<(), String> {
    #[cfg(feature = "native_webview")]
    {
        let _ = (&app, &trace_id);
        cdp_history_go(1).await
    }

    #[cfg(not(feature = "native_webview"))]
    {
        let _ = (&app, &trace_id);
        Err("native_webview feature is disabled; rebuild with `--features native_webview`".to_string())
    }
}

/// Reload current page (CDP Page.reload).
#[tauri::command]
#[specta::specta]
pub async fn agent_webview_reload(app: AppHandle, trace_id: Option<String>) -> Result<(), String> {
    #[cfg(feature = "native_webview")]
    {
        let _ = (&app, &trace_id);
        let page = wait_for_cdp_page().await?;
        page.reload()
            .await
            .map_err(|e| format!("reload failed: {e}"))?;
        Ok(())
    }

    #[cfg(not(feature = "native_webview"))]
    {
        let _ = (&app, &trace_id);
        Err("native_webview feature is disabled; rebuild with `--features native_webview`".to_string())
    }
}

/// Enter element-pick (inspect) mode. The next element the user clicks is captured and
/// surfaced via AgentWebviewElementPickedEvent.
#[tauri::command]
#[specta::specta]
pub async fn agent_webview_start_select(
    app: AppHandle,
    trace_id: Option<String>,
) -> Result<(), String> {
    #[cfg(feature = "native_webview")]
    {
        use chromiumoxide::cdp::browser_protocol::overlay::{
            HighlightConfig, InspectMode, SetInspectModeParams,
        };
        let _ = (&app, &trace_id);
        let page = wait_for_cdp_page().await?;
        page.execute(SetInspectModeParams {
            mode: InspectMode::SearchForNode,
            highlight_config: Some(HighlightConfig::default()),
        })
        .await
        .map_err(|e| format!("setInspectMode failed: {e}"))?;
        Ok(())
    }

    #[cfg(not(feature = "native_webview"))]
    {
        let _ = (&app, &trace_id);
        Err("native_webview feature is disabled; rebuild with `--features native_webview`".to_string())
    }
}

/// Exit element-pick (inspect) mode without picking.
#[tauri::command]
#[specta::specta]
pub async fn agent_webview_cancel_select(
    app: AppHandle,
    trace_id: Option<String>,
) -> Result<(), String> {
    #[cfg(feature = "native_webview")]
    {
        use chromiumoxide::cdp::browser_protocol::overlay::{InspectMode, SetInspectModeParams};
        let _ = (&app, &trace_id);
        let page = wait_for_cdp_page().await?;
        page.execute(SetInspectModeParams {
            mode: InspectMode::None,
            highlight_config: None,
        })
        .await
        .map_err(|e| format!("setInspectMode failed: {e}"))?;
        Ok(())
    }

    #[cfg(not(feature = "native_webview"))]
    {
        let _ = (&app, &trace_id);
        Err("native_webview feature is disabled; rebuild with `--features native_webview`".to_string())
    }
}

/// Open the given URL in the system default browser (official tauri-plugin-opener, Rust-side).
#[tauri::command]
#[specta::specta]
pub async fn agent_webview_open_external(
    app: AppHandle,
    input: AgentWebviewNavigateInput,
    trace_id: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let _ = &trace_id;
    app.opener()
        .open_url(input.url, None::<&str>)
        .map_err(|e| format!("open_url failed: {e}"))
}

/// Destroy the child webview and tear down the CDP session. Idempotent.
#[tauri::command]
#[specta::specta]
pub async fn agent_webview_destroy(app: AppHandle, trace_id: Option<String>) -> Result<(), String> {
    #[cfg(feature = "native_webview")]
    {
        use tauri::Manager;
        let _ = &trace_id;
        if let Some(webview) = app.get_webview(AGENT_WEBVIEW_LABEL) {
            webview.close().map_err(|e| format!("close failed: {e}"))?;
        }
        let mut guard = cdp_session().lock().await;
        if let Some(session) = guard.take() {
            for t in session.tasks {
                t.abort();
            }
        }
        Ok(())
    }

    #[cfg(not(feature = "native_webview"))]
    {
        let _ = (&app, &trace_id);
        Err("native_webview feature is disabled; rebuild with `--features native_webview`".to_string())
    }
}

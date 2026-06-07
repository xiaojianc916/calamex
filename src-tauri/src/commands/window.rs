use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, window::Color};

#[derive(Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetWindowBackgroundInput {
    #[serde(default)]
    pub label: Option<String>,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    #[serde(default = "default_window_alpha")]
    pub a: u8,
}

fn default_window_alpha() -> u8 {
    255
}

fn resolve_window_label(label: Option<&str>) -> &str {
    label.unwrap_or("main")
}

fn validate_external_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        return Ok(());
    }

    Err("只允许打开 http 或 https 外部链接。".to_string())
}

#[cfg(target_os = "windows")]
fn open_url_with_system_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map_err(|error| format!("打开浏览器失败：{error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_url_with_system_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("打开浏览器失败：{error}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_url_with_system_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("打开浏览器失败：{error}"))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn open_external_url(url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    open_url_with_system_browser(url.trim())
}

#[tauri::command]
#[specta::specta]
pub async fn set_window_background(
    app: AppHandle,
    input: SetWindowBackgroundInput,
    trace_id: Option<String>,
) -> Result<(), String> {
    let label = resolve_window_label(input.label.as_deref());
    let trace_id = trace_id.as_deref().unwrap_or("unavailable");

    tracing::info!(
        event = "window.set_background",
        label = label,
        r = input.r,
        g = input.g,
        b = input.b,
        a = input.a,
        traceId = trace_id,
    );

    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("window `{label}` not found"))?;
    window
        .set_background_color(Some(Color(input.r, input.g, input.b, input.a)))
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{resolve_window_label, validate_external_url};

    #[test]
    fn resolve_window_label_defaults_to_main_when_missing() {
        assert_eq!(resolve_window_label(None), "main");
    }

    #[test]
    fn resolve_window_label_keeps_explicit_label() {
        assert_eq!(resolve_window_label(Some("preview")), "preview");
    }

    #[test]
    fn validate_external_url_allows_http_urls() {
        assert!(validate_external_url("https://github.com/login").is_ok());
        assert!(validate_external_url("http://localhost:1420").is_ok());
    }

    #[test]
    fn validate_external_url_rejects_non_web_urls() {
        assert!(validate_external_url("file:///tmp/a").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
    }
}

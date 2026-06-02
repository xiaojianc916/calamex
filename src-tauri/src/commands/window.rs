use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{window::Color, AppHandle, Manager};

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

    // 让拖拽 / 缩放漏底抑制（window_paint）使用与窗口画刷一致的主题底色。
    crate::commands::window_paint::set_resize_paint_color(input.r, input.g, input.b);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::resolve_window_label;

    #[test]
    fn resolve_window_label_defaults_to_main_when_missing() {
        assert_eq!(resolve_window_label(None), "main");
    }

    #[test]
    fn resolve_window_label_keeps_explicit_label() {
        assert_eq!(resolve_window_label(Some("preview")), "preview");
    }
}

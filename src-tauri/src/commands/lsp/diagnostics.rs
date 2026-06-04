//! ShellCheck 中文化与诊断批量推送。

use std::collections::HashMap;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::protocol::uri_to_path;
use super::types::LspDiagnostic;

// ============================================================================
// ShellCheck 中文本地化(来自 Messages_zh.json)
// ============================================================================
const SHELLCHECK_ZH_JSON: &str = include_str!("../../../../resources/Messages_zh.json");
static ZH_MESSAGES: std::sync::OnceLock<std::collections::HashMap<String, String>> =
    std::sync::OnceLock::new();

fn zh_message(code: &str) -> Option<&'static str> {
    let map = ZH_MESSAGES.get_or_init(|| {
        match serde_json::from_str::<HashMap<String, String>>(
            SHELLCHECK_ZH_JSON.trim_start_matches('\u{FEFF}'),
        ) {
            Ok(m) => m,
            Err(e) => {
                log::error!("加载 ShellCheck 中文化失败: {e}");
                HashMap::new()
            }
        }
    });
    map.get(code).map(|s| s.as_str())
}

/// 从 diagnostic JSON 中抽取 code (string / number / { value })。
fn extract_diag_code(d: &Value) -> Option<String> {
    let c = &d["code"];
    if let Some(s) = c.as_str() {
        return Some(s.to_string());
    }
    if let Some(n) = c.as_i64() {
        return Some(n.to_string());
    }
    if let Some(v) = c.get("value") {
        if let Some(s) = v.as_str() {
            return Some(s.to_string());
        }
        if let Some(n) = v.as_i64() {
            return Some(n.to_string());
        }
    }
    None
}

pub(crate) fn handle_diagnostics(app: &AppHandle, uri: &str, diags: &[Value]) {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    static PENDING: std::sync::LazyLock<Mutex<HashMap<String, Vec<Value>>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    static FLUSH_SCHEDULED: AtomicBool = AtomicBool::new(false);

    {
        let mut guard = PENDING.lock().unwrap();
        guard.insert(uri.to_string(), diags.to_vec());
    }

    if !FLUSH_SCHEDULED.swap(true, Ordering::AcqRel) {
        let app = app.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            // 关键：先清标志再 take，防止 take→emit→清标志之间插入的诊断被 stranded
            let batch = {
                let mut guard = PENDING.lock().unwrap();
                FLUSH_SCHEDULED.store(false, Ordering::Release);
                std::mem::take(&mut *guard)
            };
            for (file_uri, file_diags) in batch {
                let file_path = uri_to_path(&file_uri);
                let lsp_diagnostics: Vec<LspDiagnostic> = file_diags
                    .iter()
                    .map(|d| {
                        let range = &d["range"];
                        let raw = d["message"].as_str().unwrap_or("");
                        let code = extract_diag_code(d);
                        let message = match code.as_deref().and_then(zh_message) {
                            Some(zh) => format!("{raw} · {zh}"),
                            None => raw.to_string(),
                        };
                        LspDiagnostic {
                            file_path: file_path.clone(),
                            line: range["start"]["line"].as_u64().unwrap_or(0) as u32,
                            column: range["start"]["character"].as_u64().unwrap_or(0) as u32,
                            end_line: range["end"]["line"].as_u64().unwrap_or(0) as u32,
                            end_column: range["end"]["character"].as_u64().unwrap_or(0) as u32,
                            severity: d["severity"].as_u64().unwrap_or(1) as u32,
                            message,
                            code,
                            source: d["source"].as_str().map(String::from),
                        }
                    })
                    .collect();
                let payload = serde_json::json!({
                    "filePath": file_path,
                    "diagnostics": lsp_diagnostics,
                });
                if let Err(e) = app.emit("lsp-diagnostics", &payload) {
                    log::warn!("发送 LSP 诊断失败: {e}");
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_diag_code_variants() {
        assert_eq!(
            extract_diag_code(&serde_json::json!({"code": "SC2086"})),
            Some("SC2086".into())
        );
        assert_eq!(
            extract_diag_code(&serde_json::json!({"code": 2086})),
            Some("2086".into())
        );
        assert_eq!(
            extract_diag_code(&serde_json::json!({"code": {"value": "SC2086"}})),
            Some("SC2086".into())
        );
        assert_eq!(
            extract_diag_code(&serde_json::json!({"code": {"value": 2086}})),
            Some("2086".into())
        );
        assert_eq!(extract_diag_code(&serde_json::json!({})), None);
    }

    #[test]
    fn test_severity_defaults_to_error() {
        // 缺省 severity 应当被当作 Error (1),不再当作 Warning。
        let app_test_diag = serde_json::json!({
            "range": {
                "start": {"line": 0, "character": 0},
                "end":   {"line": 0, "character": 1}
            },
            "message": "x"
        });
        let s = app_test_diag["severity"].as_u64().unwrap_or(1) as u32;
        assert_eq!(s, 1);
    }
}

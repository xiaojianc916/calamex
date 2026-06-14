//! JSON-RPC 帧编解码与 file path ↔ uri 转换（纯函数）。

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde_json::Value;

pub(crate) fn jsonrpc_request(id: i64, method: &str, params: Value) -> String {
    serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string()
}

pub(crate) fn jsonrpc_notify(method: &str, params: Value) -> String {
    serde_json::json!({"jsonrpc":"2.0","method":method,"params":params}).to_string()
}

pub(crate) fn jsonrpc_ok_response(id: &Value, result: Value) -> String {
    serde_json::json!({"jsonrpc":"2.0","id":id,"result":result}).to_string()
}

pub(crate) fn jsonrpc_error_response(id: &Value, code: i64, message: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
    .to_string()
}

pub(crate) fn frame_message(content: &str) -> Vec<u8> {
    format!("Content-Length: {}\r\n\r\n{}", content.len(), content).into_bytes()
}

// --- file path ↔ uri percent-encoding ---------------------------------------
// 用 percent-encoding crate 替换手写实现：在 NON_ALPHANUMERIC 基础上放开 `/` 与 `:`，
// 与原手写逻辑（保留 unreserved + `/` + `:`）完全一致；decode 走标准
// percent_decode_str（file URI 不含 `+`→空格语义）。

/// 编码集合：除字母数字外全部编码，但放开 unreserved 标点（`- _ . ~`）、
/// 路径分隔符 `/` 与 Windows 盘符 `:`，与原手写逻辑（unreserved + `/` + `:`）一致。
const FILE_PATH_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~')
    .remove(b'/')
    .remove(b':');

fn percent_encode_path(s: &str) -> String {
    utf8_percent_encode(s, FILE_PATH_ENCODE_SET).to_string()
}

fn percent_decode(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().into_owned()
}

pub(crate) fn path_to_uri(path: &str) -> Result<String, String> {
    let normalized = path.replace('\\', "/");
    // 去掉 Windows 扩展路径前缀(\\?\ 或 //?/)，避免打断后续 trim 逻辑
    let cleaned = if cfg!(windows) {
        if let Some(rest) = normalized.strip_prefix("//?/UNC/") {
            format!("//{}", rest)
        } else if let Some(rest) = normalized.strip_prefix("//?/") {
            rest.to_string()
        } else if let Some(rest) = normalized.strip_prefix("//./") {
            rest.to_string()
        } else {
            normalized
        }
    } else {
        normalized
    };

    if cfg!(windows) {
        let trimmed = cleaned.trim_start_matches('/');
        Ok(format!("file:///{}", percent_encode_path(trimmed)))
    } else {
        let with_slash = if cleaned.starts_with('/') {
            cleaned
        } else {
            format!("/{}", cleaned)
        };
        Ok(format!("file://{}", percent_encode_path(&with_slash)))
    }
}

pub(crate) fn uri_to_path(uri: &str) -> String {
    let s = uri.strip_prefix("file://").unwrap_or(uri);
    let decoded = percent_decode(s);
    if cfg!(windows) && decoded.starts_with('/') {
        decoded[1..].to_string()
    } else {
        decoded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_to_uri_simple() {
        let uri = path_to_uri("/home/user/test.sh").unwrap();
        assert!(uri.starts_with("file://"));
        assert!(uri.ends_with("test.sh"));
    }

    #[test]
    fn test_path_to_uri_encodes_spaces_and_unicode() {
        let uri = path_to_uri("/home/user/My Scripts/测试.sh").unwrap();
        assert!(uri.contains("%20"));
        // 中文 UTF-8 字节会被 percent-encoded
        assert!(uri.contains("%E6%B5%8B")); // '测' = E6 B5 8B
    }

    #[test]
    fn test_uri_to_path_roundtrip() {
        // path_to_uri / uri_to_path 行为依平台而异（Windows 走盘符路径分支），
        // 测试输入需按平台选取，否则在 Windows 上会因前导斜杠处理误报。
        #[cfg(windows)]
        let original = "C:/Users/user/My Scripts/测试.sh";
        #[cfg(not(windows))]
        let original = "/home/user/My Scripts/测试.sh";
        let uri = path_to_uri(original).unwrap();
        assert_eq!(uri_to_path(&uri), original);
    }

    #[test]
    fn test_uri_to_path_basic() {
        // Windows 下 file:///C:/... 去掉 file:// 后是 /C:/...，需再剥前导斜杠；
        // 类 Unix 平台保留前导斜杠。
        #[cfg(windows)]
        assert_eq!(uri_to_path("file:///C:/Users/test.sh"), "C:/Users/test.sh");
        #[cfg(not(windows))]
        assert_eq!(
            uri_to_path("file:///home/user/test.sh"),
            "/home/user/test.sh"
        );
    }

    #[test]
    fn test_frame_message() {
        let msg = jsonrpc_request(1, "test", serde_json::json!({}));
        let framed = frame_message(&msg);
        let framed_str = String::from_utf8_lossy(&framed);
        assert!(framed_str.starts_with("Content-Length:"));
        assert!(framed_str.contains("\r\n\r\n"));
    }
}

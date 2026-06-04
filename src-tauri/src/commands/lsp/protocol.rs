//! JSON-RPC 帧编解码与 file path ↔ uri 转换（纯函数，零依赖）。

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

// --- 极简 percent-encoding（纯 Rust，零依赖）-------------------------------

/// 对 file path 做 percent-encoding。保留 `unreserved` 字符 + `/` + `:`。
/// 其它字节 (空格、`#`、中文 UTF-8 字节等) 编码成 `%XX`。
fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                out.push(b as char)
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(out, "%{:02X}", b);
            }
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = (bytes[i + 1] as char).to_digit(16);
            let l = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (h, l) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
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

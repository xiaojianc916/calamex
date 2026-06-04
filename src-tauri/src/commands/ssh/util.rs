//! 远程路径、文本编解码、POSIX 权限位渲染等纯函数工具。

use std::path::Path;

// POSIX mode bits used for permission rendering.
const S_IFMT: u32 = 0o170000;
const S_IFSOCK: u32 = 0o140000;
const S_IFLNK: u32 = 0o120000;
const S_IFREG: u32 = 0o100000;
const S_IFBLK: u32 = 0o060000;
const S_IFDIR: u32 = 0o040000;
const S_IFCHR: u32 = 0o020000;
const S_IFIFO: u32 = 0o010000;

pub(crate) fn safe_remote_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("远程路径不能为空。".into());
    }
    if trimmed.contains('\r') || trimmed.contains('\n') {
        return Err("远程路径包含非法控制字符。".into());
    }
    Ok(trimmed.replace('\\', "/"))
}

pub(crate) fn validate_remote_mutation_name(path: &str) -> Result<(), String> {
    if path
        .split(['/', '\\'])
        .any(|segment| segment.trim() == "..")
    {
        return Err(format!("远程路径名不合法：{path}"));
    }
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or(std::borrow::Cow::Borrowed(path));
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\n')
        || trimmed.contains('\r')
    {
        return Err(format!("远程路径名不合法：{name}"));
    }
    Ok(())
}

pub(crate) fn truncate_at_utf8_boundary(mut raw: Vec<u8>) -> Vec<u8> {
    if std::str::from_utf8(&raw).is_ok() {
        return raw;
    }
    let mut end = raw.len();
    while end > 0 {
        end -= 1;
        if std::str::from_utf8(&raw[..end]).is_ok() {
            raw.truncate(end);
            return raw;
        }
    }
    raw.clear();
    raw
}

pub(crate) fn decode_remote_preview_text(raw: Vec<u8>) -> Result<(String, String, String), String> {
    let has_bom = raw.starts_with(&[0xef, 0xbb, 0xbf]);
    let encoding = if has_bom { "utf-8-bom" } else { "utf-8" };
    let decoded = if has_bom {
        String::from_utf8(raw[3..].to_vec()).map_err(|e| format!("UTF-8 解码失败：{e}"))?
    } else {
        String::from_utf8(raw).map_err(|e| format!("UTF-8 解码失败：{e}"))?
    };
    let line_ending = detect_line_ending(decoded.as_bytes());
    Ok((decoded, encoding.to_string(), line_ending.to_string()))
}

fn detect_line_ending(data: &[u8]) -> &'static str {
    let mut has_crlf = false;
    let mut has_lf = false;
    let mut has_cr = false;
    let mut i = 0;
    while i < data.len() {
        if data[i] == b'\r' {
            if i + 1 < data.len() && data[i + 1] == b'\n' {
                has_crlf = true;
                i += 1;
            } else {
                has_cr = true;
            }
        } else if data[i] == b'\n' {
            has_lf = true;
        }
        i += 1;
    }
    match (has_crlf, has_lf, has_cr) {
        (true, false, false) => "crlf",
        (false, true, false) => "lf",
        (false, false, true) => "cr",
        (true, true, _) | (true, _, true) | (_, true, true) => "mixed",
        _ => "lf",
    }
}

pub(crate) fn encode_remote_preview_text(
    content: &str,
    encoding: &str,
    line_ending: &str,
) -> Result<Vec<u8>, String> {
    let lf_only = content.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = match line_ending {
        "crlf" => lf_only.replace('\n', "\r\n"),
        "cr" => lf_only.replace('\n', "\r"),
        _ => lf_only,
    };
    let mut bytes = normalized.into_bytes();
    if encoding == "utf-8-bom" {
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.append(&mut bytes);
        Ok(bom)
    } else {
        Ok(bytes)
    }
}

pub(crate) fn format_remote_permission_from_bits(bits: u32) -> String {
    let kind = match bits & S_IFMT {
        S_IFDIR => 'd',
        S_IFLNK => 'l',
        S_IFBLK => 'b',
        S_IFCHR => 'c',
        S_IFIFO => 'p',
        S_IFSOCK => 's',
        S_IFREG => '-',
        _ => '-',
    };
    let mode = bits & 0o777;
    let mut s = String::with_capacity(10);
    s.push(kind);
    s.push(if mode & 0o400 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o200 != 0 { 'w' } else { '-' });
    s.push(if mode & 0o100 != 0 { 'x' } else { '-' });
    s.push(if mode & 0o040 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o020 != 0 { 'w' } else { '-' });
    s.push(if mode & 0o010 != 0 { 'x' } else { '-' });
    s.push(if mode & 0o004 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o002 != 0 { 'w' } else { '-' });
    s.push(if mode & 0o001 != 0 { 'x' } else { '-' });
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_remote_mutation_names_rejects_path_control_names() {
        assert!(validate_remote_mutation_name("release").is_ok());
        assert!(validate_remote_mutation_name("../release").is_err());
        assert!(validate_remote_mutation_name("bad\nname").is_err());
        assert!(safe_remote_path("bad\rpath").is_err());
    }

    #[test]
    fn detect_line_ending_distinguishes_lf_crlf_and_mixed() {
        assert_eq!(detect_line_ending(b"alpha\nbeta\n"), "lf");
        assert_eq!(detect_line_ending(b"alpha\r\nbeta\r\n"), "crlf");
        assert_eq!(detect_line_ending(b"alpha\rbeta\r"), "cr");
        assert_eq!(detect_line_ending(b"alpha\r\nbeta\n"), "mixed");
        assert_eq!(detect_line_ending(b"alpha beta"), "lf");
    }

    #[test]
    fn decode_and_encode_remote_preview_text_preserve_utf8_bom_and_line_endings() {
        let (decoded, encoding, line_ending) =
            decode_remote_preview_text(vec![0xef, 0xbb, 0xbf, b'a', b'\r', b'\n', b'b'])
                .expect("preview text should decode");
        assert_eq!(decoded, "a\r\nb");
        assert_eq!(encoding, "utf-8-bom");
        assert_eq!(line_ending, "crlf");
        let encoded = encode_remote_preview_text("a\nb", &encoding, &line_ending)
            .expect("preview text should encode");
        assert_eq!(encoded, vec![0xef, 0xbb, 0xbf, b'a', b'\r', b'\n', b'b']);
    }

    #[test]
    fn encode_does_not_double_expand_existing_crlf() {
        let out = encode_remote_preview_text("a\r\nb", "utf-8", "crlf").unwrap();
        assert_eq!(out, b"a\r\nb");
    }

    #[test]
    fn format_remote_permission_renders_posix_mode_bits() {
        assert_eq!(format_remote_permission_from_bits(0o100755), "-rwxr-xr-x");
        assert_eq!(format_remote_permission_from_bits(0o040755), "drwxr-xr-x");
        assert_eq!(format_remote_permission_from_bits(0o120777), "lrwxrwxrwx");
    }

    #[test]
    fn safe_remote_path_normalizes_backslashes() {
        assert_eq!(
            safe_remote_path(r"\home\user\file").unwrap(),
            "/home/user/file"
        );
    }

    #[test]
    fn truncate_at_utf8_boundary_backs_off_mid_codepoint() {
        let v = vec![0xe4, 0xbd];
        let out = truncate_at_utf8_boundary(v);
        assert!(out.is_empty());

        let v = vec![b'a', 0xe4, 0xbd];
        let out = truncate_at_utf8_boundary(v);
        assert_eq!(out, b"a");
    }
}

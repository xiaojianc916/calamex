//! 出站前的凭据脱敏（egress secret guard）。
//!
//! 范式对齐 gitleaks / detect-secrets：按「凭据的格式/形状」而非英文关键词识别，命中后只
//! 替换密钥片段本身（span 级），保留其余正文——避免把正常编程对话（如“如何安全存储
//! password”“调试 Authorization 头”“提到 .env 文件”）整行打成占位符而降低可用性。
//!
//! 唯一调用点为 ACP 出站边界 `crate::acp` 的 `AcpHost::model_chat`：在把用户内容发往模型
//! sidecar 前扫描每条消息正文，命中则就地脱敏并记审计日志。
//!
//! 取精确优先（precision-first）：只识别高置信度的「带前缀 API 密钥 / JWT / PEM 私钥块 /
//! Bearer 令牌」，不做基于熵的泛化匹配——对出站防护而言，误报＝破坏用户 prompt，宁可少报。

/// 单次脱敏结果：脱敏后的文本 + 命中并替换的密钥片段数（0 表示未改动）。
#[derive(Debug, Clone)]
pub struct RedactionOutcome {
    pub text: String,
    pub redactions: usize,
}

impl RedactionOutcome {
    /// 是否发生过脱敏替换。
    pub fn is_redacted(&self) -> bool {
        self.redactions > 0
    }
}

/// 命中密钥时写入的占位符。
const PLACEHOLDER: &str = "«已脱敏:疑似密钥»";

/// 扫描并脱敏文本中的疑似凭据，保留正文其余部分与换行形态（含 CRLF）。
pub fn redact_secrets(input: &str) -> RedactionOutcome {
    if input.is_empty() {
        return RedactionOutcome {
            text: String::new(),
            redactions: 0,
        };
    }

    let mut redactions = 0usize;
    let mut in_pem_block = false;
    let mut out_lines: Vec<String> = Vec::new();

    for raw_line in input.split('\n') {
        let (line, has_cr) = match raw_line.strip_suffix('\r') {
            Some(stripped) => (stripped, true),
            None => (raw_line, false),
        };
        let lower = line.to_ascii_lowercase();

        // PEM 私钥块：整块脱敏（含 BEGIN/END 行），直到遇到 END。证书等非私钥 PEM 不命中。
        if in_pem_block {
            redactions += 1;
            out_lines.push(with_cr(PLACEHOLDER, has_cr));
            if lower.contains("-----end") {
                in_pem_block = false;
            }
            continue;
        }
        if lower.contains("-----begin") && lower.contains("private key") {
            redactions += 1;
            out_lines.push(with_cr(PLACEHOLDER, has_cr));
            if !lower.contains("-----end") {
                in_pem_block = true;
            }
            continue;
        }

        let (redacted_line, hits) = redact_line_spans(line);
        redactions += hits;
        out_lines.push(with_cr(&redacted_line, has_cr));
    }

    RedactionOutcome {
        text: out_lines.join("\n"),
        redactions,
    }
}

/// 在单行内按 token 定位并 span 级替换疑似密钥，返回（脱敏后行, 命中数）。
fn redact_line_spans(line: &str) -> (String, usize) {
    let bytes = line.as_bytes();
    let mut result = String::with_capacity(line.len());
    let mut cursor = 0usize;
    let mut redactions = 0usize;
    let mut prev_token_lower: Option<String> = None;

    let mut index = 0usize;
    while index < bytes.len() {
        if !is_token_byte(bytes[index]) {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && is_token_byte(bytes[index]) {
            index += 1;
        }
        let token = &line[start..index];

        let is_secret = is_secret_token(token)
            || (prev_token_lower.as_deref() == Some("bearer") && is_opaque_credential(token));

        if is_secret {
            result.push_str(&line[cursor..start]);
            result.push_str(PLACEHOLDER);
            cursor = index;
            redactions += 1;
        }

        prev_token_lower = Some(token.to_ascii_lowercase());
    }

    result.push_str(&line[cursor..]);
    (result, redactions)
}

/// token 字符集：ASCII 字母数字 + 常见凭据内可含的连接符（不含 `=`/`:`/空白，用作分隔）。
fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'+' | b'/')
}

/// 高置信度密钥 token：带厂商前缀的 API 密钥，或 JWT。
fn is_secret_token(token: &str) -> bool {
    is_prefixed_api_key(token) || is_jwt(token)
}

/// 带厂商前缀的 API 密钥（OpenAI/Stripe/GitHub/GitLab/Google/Slack/AWS）。
fn is_prefixed_api_key(token: &str) -> bool {
    if let Some(rest) = token.strip_prefix("sk-") {
        return rest.len() >= 16 && looks_secretish(rest);
    }
    for prefix in ["sk_live_", "sk_test_", "rk_live_", "rk_test_", "pk_live_"] {
        if let Some(rest) = token.strip_prefix(prefix) {
            return rest.len() >= 12 && looks_secretish(rest);
        }
    }
    for prefix in ["ghp_", "gho_", "ghs_", "ghr_", "github_pat_"] {
        if let Some(rest) = token.strip_prefix(prefix) {
            return rest.len() >= 16 && looks_secretish(rest);
        }
    }
    if let Some(rest) = token.strip_prefix("glpat-") {
        return rest.len() >= 16 && looks_secretish(rest);
    }
    if let Some(rest) = token.strip_prefix("AIza") {
        return rest.len() >= 30 && looks_secretish(rest);
    }
    for prefix in ["xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-"] {
        if let Some(rest) = token.strip_prefix(prefix) {
            return rest.len() >= 10 && looks_secretish(rest);
        }
    }
    for prefix in ["AKIA", "ASIA"] {
        if let Some(rest) = token.strip_prefix(prefix) {
            return rest.len() == 16
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
        }
    }
    false
}

/// JWT：三段以 `.` 分隔、首段以 `eyJ` 开头、各段为足够长的 base64url。
fn is_jwt(token: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    if !parts[0].starts_with("eyJ") {
        return false;
    }
    parts
        .iter()
        .all(|part| part.len() >= 8 && part.bytes().all(is_base64url_byte))
}

fn is_base64url_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
}

/// 前缀之后的剩余部分是否「像密钥」：含数字或足够长，排除 `sk-hello-world` 这类纯词误报。
fn looks_secretish(rest: &str) -> bool {
    rest.bytes().any(|b| b.is_ascii_digit()) || rest.len() >= 24
}

/// 不透明凭据（用于 `Bearer <token>` 上下文）：足够长且字母与数字混合。
fn is_opaque_credential(token: &str) -> bool {
    token.len() >= 16
        && token.bytes().any(|b| b.is_ascii_digit())
        && token.bytes().any(|b| b.is_ascii_alphabetic())
}

/// 还原行尾 CR（保持 CRLF 形态）。
fn with_cr(line: &str, has_cr: bool) -> String {
    if has_cr {
        format!("{line}\r")
    } else {
        line.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{PLACEHOLDER, redact_secrets};

    #[test]
    fn keeps_clean_text_unchanged() {
        let input = "ok\nnormal line\nnext";
        let outcome = redact_secrets(input);
        assert!(!outcome.is_redacted());
        assert_eq!(outcome.text, input);
    }

    #[test]
    fn does_not_redact_plain_english_keywords() {
        let input = "如何安全地存储 password？我在 .env 里放了 secret 吗";
        let outcome = redact_secrets(input);
        assert!(!outcome.is_redacted());
        assert_eq!(outcome.text, input);
    }

    #[test]
    fn redacts_openai_key_span_only() {
        let outcome = redact_secrets("我的 key 是 sk-proj-abc123DEF456ghi789JKL012 对吗");
        assert!(outcome.is_redacted());
        assert!(!outcome.text.contains("sk-proj-abc123DEF456ghi789JKL012"));
        assert!(outcome.text.contains(PLACEHOLDER));
        assert!(outcome.text.contains("我的 key 是"));
        assert!(outcome.text.contains("对吗"));
    }

    #[test]
    fn redacts_github_pat() {
        let outcome = redact_secrets("token=github_pat_11ABCDE0000fghij1234567890");
        assert!(outcome.is_redacted());
        assert!(!outcome.text.contains("github_pat_11ABCDE0000fghij1234567890"));
        assert!(outcome.text.starts_with("token="));
    }

    #[test]
    fn redacts_aws_access_key_id() {
        let outcome = redact_secrets("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
        assert!(outcome.is_redacted());
        assert!(!outcome.text.contains("AKIAIOSFODNN7EXAMPLE"));
    }

    #[test]
    fn redacts_bearer_token_by_context() {
        let outcome = redact_secrets("Authorization: Bearer token-value-1234567890");
        assert!(outcome.is_redacted());
        assert!(!outcome.text.contains("token-value-1234567890"));
        assert!(outcome.text.contains("Authorization: Bearer"));
    }

    #[test]
    fn does_not_redact_bearer_followed_by_prose() {
        let input = "the bearer of good news arrived";
        let outcome = redact_secrets(input);
        assert!(!outcome.is_redacted());
        assert_eq!(outcome.text, input);
    }

    #[test]
    fn redacts_jwt() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        let outcome = redact_secrets(&format!("token {jwt} end"));
        assert!(outcome.is_redacted());
        assert!(!outcome.text.contains(jwt));
        assert!(outcome.text.contains("token "));
        assert!(outcome.text.contains(" end"));
    }

    #[test]
    fn redacts_multiline_private_key_block_only() {
        let input = [
            "before",
            "-----BEGIN PRIVATE KEY-----",
            "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
            "-----END PRIVATE KEY-----",
            "after",
        ]
        .join("\n");
        let outcome = redact_secrets(&input);
        assert!(outcome.is_redacted());
        assert!(outcome.text.contains("before"));
        assert!(outcome.text.contains("after"));
        assert!(!outcome.text.contains("MIIEvQIBADAN"));
        let placeholder_lines = outcome
            .text
            .lines()
            .filter(|line| *line == PLACEHOLDER)
            .count();
        assert_eq!(placeholder_lines, 3);
    }

    #[test]
    fn does_not_redact_certificate_pem() {
        let input = [
            "-----BEGIN CERTIFICATE-----",
            "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A",
            "-----END CERTIFICATE-----",
        ]
        .join("\n");
        let outcome = redact_secrets(&input);
        assert!(!outcome.is_redacted());
    }

    #[test]
    fn preserves_crlf_shape() {
        let outcome = redact_secrets("ok\r\nBearer token-value-1234567890\r\nnext");
        assert!(outcome.is_redacted());
        assert!(outcome.text.contains("\r\n"));
        assert!(outcome.text.starts_with("ok\r\n"));
        assert!(outcome.text.ends_with("\r\nnext"));
    }

    #[test]
    fn preserves_trailing_newline() {
        let outcome = redact_secrets("clean line\n");
        assert!(!outcome.is_redacted());
        assert!(outcome.text.ends_with('\n'));
    }
}

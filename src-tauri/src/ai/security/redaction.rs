const REDACTION_PLACEHOLDER: &str = "[已脱敏：疑似敏感内容]";

const SECRET_MARKERS: &[&str] = &[
    "api_key",
    "apikey",
    "api-key",
    "x-api-key",
    "authorization",
    "bearer ",
    "sk-",
    "access_token",
    "refresh_token",
    "id_token",
    "session_token",
    "client_secret",
    "token=",
    "token:",
    "\"token\"",
    "\"api_key\"",
    "\"access_token\"",
    "\"refresh_token\"",
    "secret",
    "password",
    "passwd",
    "pwd=",
    "private key",
    "-----begin",
    ".env",
    "ghp_",
    "github_pat_",
    "akia",
];

const PEM_BEGIN_MARKER: &str = "-----begin";
const PEM_END_MARKER: &str = "-----end";

#[derive(Debug, Clone)]
pub struct RedactionResult {
    pub text: String,
    pub blocked: bool,
}

impl RedactionResult {
    pub fn clean(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            blocked: false,
        }
    }
}

pub fn redact_text(value: &str) -> RedactionResult {
    if value.is_empty() {
        return RedactionResult::clean(String::new());
    }

    let mut blocked = false;
    let mut in_pem_block = false;
    let mut redacted_lines = Vec::new();

    for raw_line in value.split('\n') {
        let line_without_cr = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let line_lower = line_without_cr.to_lowercase();

        if in_pem_block {
            blocked = true;
            redacted_lines.push(preserve_cr(raw_line, REDACTION_PLACEHOLDER));

            if line_lower.contains(PEM_END_MARKER) {
                in_pem_block = false;
            }

            continue;
        }

        if is_secret_line(&line_lower) {
            blocked = true;
            redacted_lines.push(preserve_cr(raw_line, REDACTION_PLACEHOLDER));

            if line_lower.contains(PEM_BEGIN_MARKER) && !line_lower.contains(PEM_END_MARKER) {
                in_pem_block = true;
            }

            continue;
        }

        redacted_lines.push(raw_line.to_string());
    }

    let text = redacted_lines.join("\n");

    RedactionResult { text, blocked }
}

fn is_secret_line(line_lower: &str) -> bool {
    SECRET_MARKERS
        .iter()
        .any(|marker| line_lower.contains(marker))
}

fn preserve_cr(original_line: &str, replacement: &str) -> String {
    if original_line.ends_with('\r') {
        format!("{replacement}\r")
    } else {
        replacement.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{REDACTION_PLACEHOLDER, redact_text};

    #[test]
    fn keeps_clean_text_unchanged() {
        let input = "ok\nnormal line\nnext";
        let result = redact_text(input);

        assert!(!result.blocked);
        assert_eq!(result.text, input);
    }

    #[test]
    fn redacts_api_key_lines() {
        let result = redact_text("ok\napi_key=sk-test-secret-value\nnext");

        assert!(result.blocked);
        assert!(result.text.contains(REDACTION_PLACEHOLDER));
        assert!(!result.text.contains("sk-test-secret-value"));
        assert!(result.text.contains("ok"));
        assert!(result.text.contains("next"));
    }

    #[test]
    fn redacts_authorization_bearer_lines() {
        let result = redact_text("Authorization: Bearer token-value-1234567890");

        assert!(result.blocked);
        assert_eq!(result.text, REDACTION_PLACEHOLDER);
        assert!(!result.text.contains("token-value-1234567890"));
    }

    #[test]
    fn redacts_json_token_lines() {
        let result = redact_text(r#"{"token":"super-secret-token-value"}"#);

        assert!(result.blocked);
        assert_eq!(result.text, REDACTION_PLACEHOLDER);
        assert!(!result.text.contains("super-secret-token-value"));
    }

    #[test]
    fn redacts_json_api_key_lines() {
        let result = redact_text(r#"{"api_key":"sk-test-secret-value"}"#);

        assert!(result.blocked);
        assert_eq!(result.text, REDACTION_PLACEHOLDER);
        assert!(!result.text.contains("sk-test-secret-value"));
    }

    #[test]
    fn redacts_client_secret_lines() {
        let result = redact_text("client_secret=abc123");

        assert!(result.blocked);
        assert_eq!(result.text, REDACTION_PLACEHOLDER);
        assert!(!result.text.contains("abc123"));
    }

    #[test]
    fn redacts_env_file_references_conservatively() {
        let result = redact_text("loaded .env.local");

        assert!(result.blocked);
        assert_eq!(result.text, REDACTION_PLACEHOLDER);
    }

    #[test]
    fn redacts_multiline_private_key_block() {
        let input = [
            "before",
            "-----BEGIN PRIVATE KEY-----",
            "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
            "secret-key-body",
            "-----END PRIVATE KEY-----",
            "after",
        ]
        .join("\n");

        let result = redact_text(&input);

        assert!(result.blocked);
        assert!(result.text.contains("before"));
        assert!(result.text.contains("after"));
        assert!(!result.text.contains("MIIEvQIBADAN"));
        assert!(!result.text.contains("secret-key-body"));

        let placeholder_count = result
            .text
            .lines()
            .filter(|line| *line == REDACTION_PLACEHOLDER)
            .count();

        assert_eq!(placeholder_count, 4);
    }

    #[test]
    fn preserves_trailing_newline() {
        let input = "ok\napi_key=sk-test-secret-value\n";
        let result = redact_text(input);

        assert!(result.blocked);
        assert!(result.text.ends_with('\n'));
        assert_eq!(result.text, format!("ok\n{REDACTION_PLACEHOLDER}\n"));
    }

    #[test]
    fn preserves_windows_crlf_shape() {
        let input = "ok\r\nAuthorization: Bearer token-value\r\nnext";
        let result = redact_text(input);

        assert!(result.blocked);
        assert_eq!(
            result.text,
            format!("ok\r\n{REDACTION_PLACEHOLDER}\r\nnext")
        );
    }

    #[test]
    fn redacts_openai_style_key_marker() {
        let result = redact_text("OPENAI_API_KEY=sk-proj-example-secret");

        assert!(result.blocked);
        assert_eq!(result.text, REDACTION_PLACEHOLDER);
        assert!(!result.text.contains("sk-proj-example-secret"));
    }

    #[test]
    fn redacts_github_tokens() {
        let result = redact_text("token=github_pat_1234567890");

        assert!(result.blocked);
        assert_eq!(result.text, REDACTION_PLACEHOLDER);
        assert!(!result.text.contains("github_pat_1234567890"));
    }

    #[test]
    fn redacts_aws_access_key_marker() {
        let result = redact_text("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");

        assert!(result.blocked);
        assert_eq!(result.text, REDACTION_PLACEHOLDER);
        assert!(!result.text.contains("AKIAIOSFODNN7EXAMPLE"));
    }
}

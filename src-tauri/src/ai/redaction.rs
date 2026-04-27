const SECRET_MARKERS: &[&str] = &[
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "password",
    "private key",
    "-----begin",
    ".env",
];

#[derive(Debug, Clone)]
pub struct RedactionResult {
    pub text: String,
    pub blocked: bool,
}

pub fn redact_text(value: &str) -> RedactionResult {
    let lower = value.to_lowercase();
    let blocked = SECRET_MARKERS.iter().any(|marker| lower.contains(marker));
    if !blocked {
        return RedactionResult {
            text: value.to_string(),
            blocked: false,
        };
    }

    let text = value
        .lines()
        .map(|line| {
            let line_lower = line.to_lowercase();
            if SECRET_MARKERS
                .iter()
                .any(|marker| line_lower.contains(marker))
            {
                "[已脱敏：疑似敏感内容]".to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    RedactionResult { text, blocked }
}

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct ChatCompletionStreamChunk {
    choices: Vec<ChatCompletionStreamChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionStreamChoice {
    delta: ChatCompletionStreamDelta,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionStreamDelta {
    content: Option<String>,
}

pub enum SseParseOutcome {
    Continue,
    Done,
}

pub fn parse_sse_line(line: &str) -> Result<(SseParseOutcome, Option<String>), String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        return Ok((SseParseOutcome::Continue, None));
    }
    let Some(data) = trimmed.strip_prefix("data:") else {
        return Ok((SseParseOutcome::Continue, None));
    };
    let payload = data.trim();
    if payload == "[DONE]" {
        return Ok((SseParseOutcome::Done, None));
    }
    let parsed = serde_json::from_str::<ChatCompletionStreamChunk>(payload)
        .map_err(|error| format!("AI stream chunk 解析失败：{error}"))?;
    let delta = parsed
        .choices
        .into_iter()
        .filter_map(|choice| choice.delta.content)
        .collect::<String>();
    if delta.is_empty() {
        return Ok((SseParseOutcome::Continue, None));
    }
    Ok((SseParseOutcome::Continue, Some(delta)))
}

#[cfg(test)]
mod tests {
    use super::{parse_sse_line, SseParseOutcome};

    #[test]
    fn parses_openai_delta() {
        let line = r#"data: {"choices":[{"delta":{"content":"hello"}}]}"#;
        let (outcome, delta) = parse_sse_line(line).expect("parse sse");
        assert!(matches!(outcome, SseParseOutcome::Continue));
        assert_eq!(delta.as_deref(), Some("hello"));
    }

    #[test]
    fn parses_done_marker() {
        let (outcome, delta) = parse_sse_line("data: [DONE]").expect("parse done");
        assert!(matches!(outcome, SseParseOutcome::Done));
        assert!(delta.is_none());
    }
}

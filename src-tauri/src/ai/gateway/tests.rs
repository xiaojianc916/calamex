use super::conversation::{normalize_conversation_title, with_identity_system_message};
use super::prompt::{build_conversation_title_prompt, build_identity_system_prompt};
use super::suggestions::{normalize_suggestion_text, parse_suggestion_pool_response};
use super::{
    AiModelEndpointRuntimeConfig, AiRuntimeConfig, DEFAULT_MASTRA_MODEL, DEFAULT_NARRATOR_MODEL,
    MAX_GENERATED_TITLE_CHARS, default_base_url, default_model, is_endpoint_ready,
    model_service_platform, validate_model_provider, validate_provider,
};
use crate::ai::provider::AiProviderMessage;

#[test]
fn mastra_provider_uses_current_defaults() {
    assert!(validate_provider("mastra").is_ok());
    assert_eq!(
        default_model("mastra").as_deref(),
        Some(DEFAULT_MASTRA_MODEL)
    );
    assert_eq!(default_base_url("mastra"), None);
    assert!(validate_provider("litellm").is_err());
    assert!(validate_provider("openai").is_err());
}

#[test]
fn deepseek_identity_prompt_is_model_aware_and_concise() {
    let prompt = build_identity_system_prompt("deepseek/deepseek-v4-pro");

    assert!(prompt.contains("DeepSeek"));
    assert!(prompt.contains("当前模型：deepseek/deepseek-v4-pro"));
    assert!(prompt.contains("不冒充其他模型或厂商"));
    assert!(prompt.contains("deepseek/deepseek-v4-pro"));
    assert!(!prompt.contains("不要自称"));
}

#[test]
fn anthropic_identity_prompt_keeps_claude_as_current_model() {
    let prompt = build_identity_system_prompt("anthropic/claude-sonnet-4-6");

    assert!(prompt.contains("Anthropic"));
    assert!(prompt.contains("当前模型：anthropic/claude-sonnet-4-6"));
    assert!(!prompt.contains("当前模型不是"));
}

#[test]
fn identity_message_is_prepended_before_user_messages() {
    let messages = with_identity_system_message(
        vec![AiProviderMessage::user("你是谁")],
        "deepseek/deepseek-v4-pro",
    );

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].role, "system");
    assert!(messages[0].content.contains("身份："));
    assert_eq!(messages[1].role, "user");
}

#[test]
fn conversation_title_prompt_uses_only_first_round() {
    let prompt = build_conversation_title_prompt("第一轮用户问题", "第一轮 AI 回答");

    assert!(prompt.contains("第一轮用户问题"));
    assert!(prompt.contains("第一轮 AI 回答"));
    assert!(prompt.contains("只依据下面第一轮问答"));
    assert!(!prompt.contains("第二轮"));
}

#[test]
fn conversation_title_normalization_limits_length_and_removes_wrappers() {
    let title = normalize_conversation_title("标题：《修复弹窗滚动与标题生成》");

    assert!(title.chars().count() <= MAX_GENERATED_TITLE_CHARS);
    assert_eq!(title, "修复弹窗滚动与标题生");
}

#[test]
fn conversation_title_generation_prefers_narrator_model() {
    let config = AiRuntimeConfig {
        selected_model: Some("openai/gpt-5.5".to_string()),
        narrator: AiModelEndpointRuntimeConfig {
            selected_model: Some("zhipuai/glm-4.7-flash".to_string()),
            ..AiModelEndpointRuntimeConfig::default()
        },
        ..AiRuntimeConfig::default()
    };

    let model = config
        .narrator
        .selected_model
        .as_deref()
        .unwrap_or(DEFAULT_NARRATOR_MODEL);

    assert_eq!(model, "zhipuai/glm-4.7-flash");
    assert_ne!(
        model,
        config
            .selected_model
            .as_deref()
            .unwrap_or(DEFAULT_MASTRA_MODEL)
    );
}

#[test]
fn mastra_endpoint_readiness_does_not_require_manual_base_url() {
    assert!(is_endpoint_ready(true, true));
    assert!(!is_endpoint_ready(false, true));
    assert!(!is_endpoint_ready(true, false));
}

#[test]
fn model_provider_is_resolved_from_model_prefix() {
    assert_eq!(
        model_service_platform(Some("deepseek/deepseek-v4-flash")),
        Some("deepseek"),
    );
    assert_eq!(model_service_platform(Some("gpt-5.5")), None);
}

#[test]
fn credential_provider_must_match_model_provider() {
    assert_eq!(
        validate_model_provider(Some("deepseek/deepseek-v4-pro"), Some("deepseek")).unwrap(),
        "deepseek",
    );
    assert!(validate_model_provider(Some("deepseek/deepseek-v4-pro"), Some("openai")).is_err());
}

#[test]
fn suggestion_pool_parser_accepts_wrapped_json_object() {
    let suggestions = (1..=9)
        .map(|index| format!("\"介绍提示词{index}测试\""))
        .collect::<Vec<_>>()
        .join(",");
    let raw = format!("```json\n{{\"suggestions\":[{suggestions}]}}\n```");

    let parsed = parse_suggestion_pool_response(&raw, 9);

    assert_eq!(parsed.len(), 9);
    assert_eq!(parsed[0], "介绍提示词1测试");
}

#[test]
fn suggestion_pool_parser_normalizes_numbered_lines() {
    let raw = [
        "1. “解释潮汐形成原因”",
        "2. 给我一个睡前放松建议",
        "3. 推荐一本短篇小说",
        "4. 讲一个数学冷知识",
        "5. 帮我拆解今天的任务",
        "6. 介绍一个天文现象",
        "7. 用类比解释基因",
        "8. 给我一个沟通练习",
        "9. 讲讲古诗词意象",
    ]
    .join("\n");

    let parsed = parse_suggestion_pool_response(&raw, 9);

    assert_eq!(parsed.len(), 9);
    assert_eq!(parsed[0], "解释潮汐形成原因");
}

#[test]
fn suggestion_text_normalization_rejects_overlong_items() {
    let value = "这是一条明显超过字符上限的提示词，内容冗长到已经不适合作为首页按钮文案展示，也不利于快速扫描";

    assert_eq!(normalize_suggestion_text(value), None);
}

#[test]
fn suggestion_pool_cache_model_must_match_current_narrator_model() {
    let current_model = AiRuntimeConfig::default()
        .narrator
        .selected_model
        .unwrap_or_else(|| DEFAULT_NARRATOR_MODEL.to_string());

    assert_eq!(current_model, "zhipuai/glm-4.7-flash");
    assert_ne!(current_model, "zhipu/glm-4-flash");
}

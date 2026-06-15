use fs_err as fs;
use std::{collections::HashSet, path::PathBuf};

use super::*;
use crate::commands::contracts::{AgentSidecarChatRequest, AgentSidecarMessagePayload};
use tauri::Manager as _;

const MIN_SUGGESTION_POOL_SIZE: usize = 9;
const MAX_SUGGESTION_POOL_SIZE: usize = 90;
const MIN_SUGGESTION_CHARS: usize = 7;
const MAX_SUGGESTION_CHARS: usize = 15;
const SUGGESTION_POOL_CACHE_FILE_NAME: &str = "ai-suggestion-pool.json";

const DEFAULT_SUGGESTION_TOPICS: &[&str] = &[
    "健康",
    "生活小知识",
    "科学",
    "文学",
    "历史",
    "艺术",
    "学习",
    "效率",
    "旅行",
    "饮食",
    "心理",
    "科技",
    "自然",
    "哲学",
    "沟通",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedSuggestionPoolObject {
    suggestions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum ParsedSuggestionPoolResponse {
    Object(ParsedSuggestionPoolObject),
    Array(Vec<String>),
}

async fn run_suggestion_model_chat(
    app: &AppHandle,
    mut request: AgentSidecarChatRequest,
) -> Result<crate::commands::contracts::AgentSidecarResponsePayload, String> {
    request
        .model_config
        .get_or_insert(narrator_sidecar_model_config()?);
    let host = app
        .state::<crate::acp::AcpRuntime>()
        .get_or_spawn(app)
        .map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("无法建立 ACP 宿主连接：{error}"),
            )
        })?;

    host.model_chat(crate::acp::chat_request_to_model_chat_ext(request))
        .await
        .map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("ACP 模型透传失败：{error}"),
            )
        })
}

pub async fn generate_suggestion_pool(
    app: &AppHandle,
    payload: AiSuggestionPoolRequest,
) -> Result<AiSuggestionPoolPayload, String> {
    let config = current_config()?;
    let narrator_config = &config.narrator;
    let count = normalize_suggestion_count(payload.count);
    let locale = normalize_locale(&payload.locale);
    let topics = normalize_topics(&payload.topics);
    let model = narrator_config
        .selected_model
        .as_deref()
        .unwrap_or(DEFAULT_NARRATOR_MODEL);
    let request = AiProviderChatRequest::new(vec![
        prompt::build_identity_system_message(model),
        AiProviderMessage::system(build_suggestion_pool_system_prompt(count)),
        AiProviderMessage::user(build_suggestion_pool_user_prompt(&locale, &topics, count)),
    ]);

    let response = run_suggestion_model_chat(
        app,
        AgentSidecarChatRequest {
            session_id: None,
            mode: Some("ask".to_string()),
            goal: Some("生成首页提示词池".to_string()),
            messages: request
                .messages
                .into_iter()
                .map(|message| AgentSidecarMessagePayload {
                    role: message.role,
                    content: message.content,
                })
                .collect(),
            workspace_root_path: None,
            context: Vec::new(),
            model_config: None,
            thread_id: None,
        },
    )
    .await?;
    let suggestions =
        parse_suggestion_pool_response(response.result.as_deref().unwrap_or_default(), count);

    // 软约束:只要达到展示下限即接受。前端 MMR + 兜底池负责把残缺池子凑成 9 个多样按钮。
    if suggestions.len() < MIN_SUGGESTION_POOL_SIZE {
        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            format!(
                "提示词池仅 {} 条,低于展示下限 {}。",
                suggestions.len(),
                MIN_SUGGESTION_POOL_SIZE
            ),
        ));
    }

    let payload = AiSuggestionPoolPayload {
        suggestions,
        model: model.to_string(),
        generated_at: jiff::Timestamp::now().to_string(),
    };

    persist_suggestion_pool_cache(&payload)?;

    Ok(payload)
}

pub fn get_suggestion_pool_cache() -> Result<Option<AiSuggestionPoolPayload>, String> {
    let Some(path) = suggestion_pool_cache_path() else {
        return Ok(None);
    };
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("提示词池缓存读取失败:{error}"),
            ));
        }
    };
    let payload = match serde_json::from_str::<AiSuggestionPoolPayload>(&content) {
        Ok(payload) => payload,
        Err(_) => return Ok(None),
    };

    let suggestions = normalize_suggestion_pool(payload.suggestions, MAX_SUGGESTION_POOL_SIZE);
    if suggestions.len() < MIN_SUGGESTION_POOL_SIZE
        || payload.model.trim().is_empty()
        || payload.generated_at.trim().is_empty()
    {
        return Ok(None);
    }

    let config = current_config()?;
    let current_model = config
        .narrator
        .selected_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_NARRATOR_MODEL);
    if payload.model.trim() != current_model {
        return Ok(None);
    }

    Ok(Some(AiSuggestionPoolPayload {
        suggestions,
        model: payload.model,
        generated_at: payload.generated_at,
    }))
}

fn normalize_suggestion_count(value: usize) -> usize {
    value.clamp(MIN_SUGGESTION_POOL_SIZE, MAX_SUGGESTION_POOL_SIZE)
}

fn normalize_locale(value: &str) -> String {
    let locale = value.trim();
    if locale.is_empty() {
        return "zh-CN".to_string();
    }
    locale.chars().take(16).collect()
}

fn normalize_topics(topics: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for topic in topics {
        let normalized = topic.trim();
        if normalized.is_empty() || seen.contains(normalized) {
            continue;
        }
        seen.insert(normalized.to_string());
        result.push(normalized.chars().take(16).collect());
    }

    if result.is_empty() {
        return DEFAULT_SUGGESTION_TOPICS
            .iter()
            .map(|topic| (*topic).to_string())
            .collect();
    }
    result
}

fn build_suggestion_pool_system_prompt(count: usize) -> String {
    let q_min = (count / 6).max(2);
    let imp_min = (count / 4).max(2);
    let stmt_min = (count / 6).max(2);
    let len_a_min = (count / 4).max(2); // 7-9 字
    let len_b_min = (count / 4).max(2); // 10-12 字
    let len_c_min = (count / 4).max(2); // 13-15 字
    let punct_max = (count * 3) / 10; // 末尾带标点 ≤ 30%
    let head_max = 3usize;
    let min_chars = MIN_SUGGESTION_CHARS;
    let max_chars = MAX_SUGGESTION_CHARS;

    format!(
        "为桌面助手首页批量生成 {count} 条中文按钮提示词。\
         严格输出 JSON,无任何前后缀文本、无 Markdown、无代码块围栏。\n\n\
         [硬约束]\n\
         - 每条恰好 {min_chars}-{max_chars} 个汉字字符,不计空格,超出或不足都视为不合格\
         - 简体中文,严禁涉及代码、编程、命令行、API、调试、配置、框架等开发话题\
         - 末尾带 ? ？ ! ！ 等标点的条目数 ≤ {punct_max}(整批 30% 上限)\
         - 任意\"前两个字\"在整批中出现 ≤ {head_max} 次\n\n\
         [句式配额]\n\
         - 疑问句(\"如何/为什么/哪些/能否/怎么\" 等开头,或以 ？ 结尾) ≥ {q_min} 条\
         - 祈使句(\"帮我/推荐/列出/解释/讲讲/介绍/聊聊/比较\" 等动词开头) ≥ {imp_min} 条\
         - 陈述句(以名词、数字、场景词开头,既不疑问也不祈使) ≥ {stmt_min} 条\n\n\
         [长度配额]\n\
         - 7-9 字 ≥ {len_a_min} 条\
         - 10-12 字 ≥ {len_b_min} 条\
         - 13-15 字 ≥ {len_c_min} 条\n\n\
         [质量基线]\n\
         合格(每条都有具体对象、具体动作、具体场景或具体悬念):\n\
         - 为什么唐宋八大家没有李白\
         - 用趣味比喻讲解二进制\
         - 推荐一本被低估的小说\
         - 三个治愈拖延的小习惯\
         - 简单介绍熵增定律\
         - 古人怎么计算月亮距离\
         - 介绍一种小众乐器\
         - 一道适合周末做的菜\
         - 唐诗里最孤独的一句\
         - 用电影解释存在主义\n\n\
         不合格(过短、空泛、寒暄、套话、无具体对象,严禁出现此类口水句):\n\
         - 早餐这么吃\
         - 你好呀\
         - 今天天气真好\
         - 讲一下吧\
         - 来点小知识\
         - 给我一些建议\n\n\
         [领域分布]\n\
         覆盖:健康、生活、科学、文学、历史、艺术、学习、效率、旅行、\
         饮食、心理、自然、哲学、沟通。每个领域 ≥ 1 条,任一领域 ≤ 12 条。\
         健康类仅限日常常识,不涉及诊断、处方、治疗、用药。\n\n\
         [输出]\n\
         {{\"suggestions\":[{count} 条字符串,顺序不限]}}"
    )
}

fn build_suggestion_pool_user_prompt(locale: &str, topics: &[String], count: usize) -> String {
    let locale_text = sanitize_fenced_text(locale);
    let topics_text = topics
        .iter()
        .map(|topic| sanitize_fenced_text(topic))
        .collect::<Vec<_>>()
        .join("、");

    format!(
        "生成 {count} 条提示词。\n\
         语言:{locale_text}\n\
         重点领域:{topics_text}\n\
         严格遵守 [硬约束] [句式配额] [长度配额] [质量基线],输出 JSON。"
    )
}

fn suggestion_pool_cache_path() -> Option<PathBuf> {
    Some(config_file_path()?.with_file_name(SUGGESTION_POOL_CACHE_FILE_NAME))
}

fn persist_suggestion_pool_cache(payload: &AiSuggestionPoolPayload) -> Result<(), String> {
    let Some(path) = suggestion_pool_cache_path() else {
        return Ok(());
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("提示词池缓存目录创建失败:{error}"),
            )
        })?;
    }

    let content = serde_json::to_string_pretty(payload).map_err(|error| {
        errors::error(
            "AI_RESPONSE_INVALID",
            format!("提示词池缓存序列化失败:{error}"),
        )
    })?;

    let temp_path = path.with_extension("json.tmp");
    let backup_path = path.with_extension("json.bak");

    fs::write(&temp_path, content).map_err(|error| {
        errors::error(
            "AI_PROVIDER_UNAVAILABLE",
            format!("提示词池缓存写入失败:{error}"),
        )
    })?;

    if backup_path.exists() {
        fs::remove_file(&backup_path).map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("提示词池旧缓存备份清理失败:{error}"),
            )
        })?;
    }

    let had_existing_cache = path.exists();
    if had_existing_cache {
        fs::rename(&path, &backup_path).map_err(|error| {
            errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("旧提示词池缓存备份失败:{error}"),
            )
        })?;
    }

    match fs::rename(&temp_path, &path) {
        Ok(()) => {
            if had_existing_cache && backup_path.exists() {
                fs::remove_file(&backup_path).map_err(|error| {
                    errors::error(
                        "AI_PROVIDER_UNAVAILABLE",
                        format!("旧提示词池缓存删除失败:{error}"),
                    )
                })?;
            }
            Ok(())
        }
        Err(error) => {
            if had_existing_cache && backup_path.exists() {
                let _ = fs::rename(&backup_path, &path);
            }
            let _ = fs::remove_file(&temp_path);
            Err(errors::error(
                "AI_PROVIDER_UNAVAILABLE",
                format!("提示词池缓存替换失败:{error}"),
            ))
        }
    }
}

pub(super) fn parse_suggestion_pool_response(value: &str, count: usize) -> Vec<String> {
    let requested_count = normalize_suggestion_count(count);
    let parsed = parse_suggestion_json(value).unwrap_or_else(|| parse_suggestion_lines(value));
    normalize_suggestion_pool(parsed, requested_count)
}

fn parse_suggestion_json(value: &str) -> Option<Vec<String>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    for candidate in json_candidates(trimmed) {
        if let Ok(parsed) = serde_json::from_str::<ParsedSuggestionPoolResponse>(candidate) {
            return Some(match parsed {
                ParsedSuggestionPoolResponse::Object(object) => object.suggestions,
                ParsedSuggestionPoolResponse::Array(items) => items,
            });
        }
    }
    None
}

fn json_candidates(value: &str) -> Vec<&str> {
    let mut result: Vec<&str> = Vec::new();

    // 整段(模型直接返回净 JSON)
    if value.starts_with('{') || value.starts_with('[') {
        result.push(value);
    }

    // 首个 { 到末个 } 的切片
    if let (Some(start), Some(end)) = (value.find('{'), value.rfind('}'))
        && start <= end
        && let Some(slice) = value.get(start..=end)
        && !result.contains(&slice)
    {
        result.push(slice);
    }

    // 首个 [ 到末个 ] 的切片
    if let (Some(start), Some(end)) = (value.find('['), value.rfind(']'))
        && start <= end
        && let Some(slice) = value.get(start..=end)
        && !result.contains(&slice)
    {
        result.push(slice);
    }

    result
}

fn parse_suggestion_lines(value: &str) -> Vec<String> {
    value
        .lines()
        .filter_map(normalize_suggestion_text)
        .collect()
}

fn normalize_suggestion_pool(suggestions: Vec<String>, count: usize) -> Vec<String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for suggestion in suggestions {
        let Some(normalized) = normalize_suggestion_text(&suggestion) else {
            continue;
        };
        let key = normalized.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        result.push(normalized);
        if result.len() >= count {
            break;
        }
    }
    result
}

pub(super) fn normalize_suggestion_text(value: &str) -> Option<String> {
    let without_marker = strip_leading_list_marker(value);
    let collapsed = without_marker
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = collapsed.trim_matches(|item: char| {
        item.is_whitespace()
            || matches!(
                item,
                '"' | '\''
                    | '\u{201c}'
                    | '\u{201d}'
                    | '\u{2018}'
                    | '\u{2019}'
                    | '\u{300a}'
                    | '\u{300b}'
                    | '\u{3010}'
                    | '\u{3011}'
                    | '\u{300c}'
                    | '\u{300d}'
                    | '\u{300e}'
                    | '\u{300f}'
                    | '\u{3002}'
                    | ','
                    | '.'
                    | ':'
                    | ';'
            )
    });
    let char_count = trimmed.chars().count();
    if !(MIN_SUGGESTION_CHARS..=MAX_SUGGESTION_CHARS).contains(&char_count) {
        return None;
    }
    Some(trimmed.chars().take(MAX_SUGGESTION_CHARS).collect())
}

fn strip_leading_list_marker(value: &str) -> &str {
    let mut text = value
        .trim()
        .trim_start_matches(['-', '*', '\u{2022}', '\u{00b7}'])
        .trim_start();

    let mut digit_end = 0;
    let mut has_digit = false;
    for (index, item) in text.char_indices() {
        if item.is_ascii_digit() {
            has_digit = true;
            digit_end = index + item.len_utf8();
            continue;
        }
        if has_digit && matches!(item, '.' | '\u{3001}' | ')') {
            digit_end = index + item.len_utf8();
            break;
        }
        digit_end = 0;
        break;
    }

    if digit_end > 0 {
        text = text.get(digit_end..).unwrap_or(text).trim_start();
    }
    text
}

#!/usr/bin/env node
// 重构 AI Provider「测试连接」为真实、符合现实逻辑的校验：
// 1. 校验模型必须真正返回内容（之前丢弃返回值，sidecar 返回 200 即算通过）。
// 2. 点「测试」只测你当前填写的 Key：填了才连模型；没填就直接报错，绝不静默回退去用已保存的 Key（保存路径仍保留回退）。
// 3. 成功结果如实披露模型、Key 来源、往返耗时；失败按 401/429/404/无返回分类。
// 仅改 src-tauri 后端三个 .rs；幂等、CRLF 安全；原始 / 已部分打补丁 / 已完成 三种状态均可重复运行。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const CLASSIFY_HELPER = `use tauri::AppHandle;

fn classify_provider_test_error_code(error: &str) -> &'static str {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("http 401")
        || normalized.contains("http 403")
        || normalized.contains("unauthorized")
        || normalized.contains("ai_provider_auth_failed")
    {
        "AI_PROVIDER_AUTH_FAILED"
    } else if normalized.contains("http 429")
        || normalized.contains("too many requests")
        || normalized.contains("rate limit")
    {
        "AI_PROVIDER_RATE_LIMITED"
    } else if normalized.contains("ai_provider_not_configured") || normalized.contains("http 404") {
        "AI_PROVIDER_NOT_CONFIGURED"
    } else if normalized.contains("ai_response_invalid") {
        "AI_RESPONSE_INVALID"
    } else {
        "AI_PROVIDER_UNAVAILABLE"
    }
}`;

const edits = {
  'src-tauri/src/ai/gateway/config.rs': [
    {
      label: 'config: candidate 增加 api_key_from_saved 字段',
      done: 'pub(super) api_key_from_saved: bool,',
      find: `    pub(super) api_key_for_test: String,
    pub(super) inline_completion_enabled: bool,`,
      replace: `    pub(super) api_key_for_test: String,
    pub(super) api_key_from_saved: bool,
    pub(super) inline_completion_enabled: bool,`,
    },
    {
      label: 'config: 记录 Key 来源（填写 / 回退已保存）',
      done: 'let api_key_from_saved = typed_api_key.is_none()',
      find: `    let api_key_for_test = api_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .map(Ok)
        .unwrap_or_else(|| get_saved_api_key_for_candidate(model.as_deref()))?;

    if api_key_for_test.trim().is_empty() {
        return Err(errors::error("AI_PROVIDER_AUTH_FAILED", "请填写 API Key。"));
    }

    Ok(AiProviderConnectionCandidate {
        provider_id: resolved_provider_id,
        provider_type: provider_type.to_string(),
        selected_model: model,
        base_url: normalized_base_url,
        api_key_for_test,
        inline_completion_enabled,
        chat_enabled,
        agent_enabled,
    })`,
      replace: `    let typed_api_key = api_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let api_key_from_saved = typed_api_key.is_none();
    let api_key_for_test = match typed_api_key {
        Some(value) => value,
        None => get_saved_api_key_for_candidate(model.as_deref())?,
    };

    if api_key_for_test.trim().is_empty() {
        return Err(errors::error("AI_PROVIDER_AUTH_FAILED", "请填写 API Key。"));
    }

    Ok(AiProviderConnectionCandidate {
        provider_id: resolved_provider_id,
        provider_type: provider_type.to_string(),
        selected_model: model,
        base_url: normalized_base_url,
        api_key_for_test,
        api_key_from_saved,
        inline_completion_enabled,
        chat_enabled,
        agent_enabled,
    })`,
    },
    {
      label: 'config: build_provider_connection_candidate 增加 allow_saved_fallback 参数',
      done: `    allow_saved_fallback: bool,
) -> Result<AiProviderConnectionCandidate, String> {`,
      find: `    api_key: Option<&str>,
) -> Result<AiProviderConnectionCandidate, String> {`,
      replace: `    api_key: Option<&str>,
    allow_saved_fallback: bool,
) -> Result<AiProviderConnectionCandidate, String> {`,
    },
    {
      label: 'config: 仅当允许时才回退已保存 Key，否则空 Key 直接报错',
      done: 'let api_key_from_saved = typed_api_key.is_none() && allow_saved_fallback;',
      find: `    let typed_api_key = api_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let api_key_from_saved = typed_api_key.is_none();
    let api_key_for_test = match typed_api_key {
        Some(value) => value,
        None => get_saved_api_key_for_candidate(model.as_deref())?,
    };`,
      replace: `    let typed_api_key = api_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let api_key_from_saved = typed_api_key.is_none() && allow_saved_fallback;
    let api_key_for_test = match typed_api_key {
        Some(value) => value,
        None => {
            if allow_saved_fallback {
                get_saved_api_key_for_candidate(model.as_deref())?
            } else {
                return Err(errors::error(
                    "AI_PROVIDER_AUTH_FAILED",
                    "请先填写要测试的 API Key 后再测试连接。",
                ));
            }
        }
    };`,
    },
  ],
  'src-tauri/src/ai/gateway/connection.rs': [
    {
      label: 'connection: 测试需校验真实返回并生成专业结果文案',
      done: 'let started_at = std::time::Instant::now();',
      find: `async fn test_provider_connection_candidate(
    candidate: &AiProviderConnectionCandidate,
) -> Result<(), String> {
    let _ = agent_sidecar::model_chat_once(build_test_request(candidate)?).await?;
    Ok(())
}`,
      replace: `async fn test_provider_connection_candidate(
    candidate: &AiProviderConnectionCandidate,
) -> Result<String, String> {
    let started_at = std::time::Instant::now();
    let response = agent_sidecar::model_chat_once(build_test_request(candidate)?).await?;
    let reply = response.result.unwrap_or_default();
    let reply = reply.trim();

    if reply.is_empty() {
        return Err(errors::error(
            "AI_RESPONSE_INVALID",
            "模型连接成功但未返回任何内容，请确认所选模型与对应厂商 API Key 是否匹配可用。",
        ));
    }

    let latency_ms = started_at.elapsed().as_millis();
    let model_label = candidate
        .selected_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("默认模型");
    let key_source = if candidate.api_key_from_saved {
        "已保存的 API Key"
    } else {
        "本次填写的 API Key"
    };

    Ok(format!(
        "连接正常：{model_label} 已成功响应（使用{key_source}，耗时 {latency_ms}ms）。"
    ))
}`,
    },
    {
      label: 'connection: test_provider 标记 Key 来自已保存',
      done: 'api_key_from_saved: true,',
      find: `        api_key_for_test: get_api_key_for_config(&config)?,
        inline_completion_enabled: config.inline_completion_enabled,`,
      replace: `        api_key_for_test: get_api_key_for_config(&config)?,
        api_key_from_saved: true,
        inline_completion_enabled: config.inline_completion_enabled,`,
    },
    {
      label: 'connection: test_provider 返回结果文案',
      done: 'pub async fn test_provider() -> Result<String, String> {',
      find: `pub async fn test_provider() -> Result<(), String> {`,
      replace: `pub async fn test_provider() -> Result<String, String> {`,
    },
    {
      label: 'connection: test_provider_config 返回结果文案',
      done: `) -> Result<String, String> {
    let candidate = build_provider_connection_candidate(`,
      find: `    api_key: Option<&str>,
) -> Result<(), String> {
    let candidate = build_provider_connection_candidate(`,
      replace: `    api_key: Option<&str>,
) -> Result<String, String> {
    let candidate = build_provider_connection_candidate(`,
    },
    {
      label: 'connection: test_provider_config 不回退已保存 Key (allow_saved_fallback=false)',
      done: `        api_key,
        false,
    )?;`,
      find: `        api_key,
    )?;

    test_provider_connection_candidate(&candidate).await
}`,
      replace: `        api_key,
        false,
    )?;

    test_provider_connection_candidate(&candidate).await
}`,
    },
    {
      label: 'connection: connect_provider 保留回退已保存 Key (allow_saved_fallback=true)',
      done: `        api_key,
        true,
    )?;`,
      find: `        api_key,
    )?;

    test_provider_connection_candidate(&candidate).await?;

    save_connected_model(role, candidate)`,
      replace: `        api_key,
        true,
    )?;

    test_provider_connection_candidate(&candidate).await?;

    save_connected_model(role, candidate)`,
    },
  ],
  'src-tauri/src/commands/ai/gateway.rs': [
    {
      label: 'command: 新增错误分类辅助函数',
      done: 'fn classify_provider_test_error_code(',
      find: `use tauri::AppHandle;`,
      replace: CLASSIFY_HELPER,
    },
    {
      label: 'command: ai_test_provider_config 透传真实结果与错误分类',
      done: `    .await
    {
        Ok(message) => Ok(AiProviderTestPayload {`,
      find: `    )
    .await
    {
        Ok(()) => Ok(AiProviderTestPayload {
            ok: true,
            code: "AI_PROVIDER_READY".to_string(),
            message: "AI Provider 可用。".to_string(),
        }),
        Err(error) => Ok(AiProviderTestPayload {
            ok: false,
            code: "AI_PROVIDER_UNAVAILABLE".to_string(),
            message: error,
        }),
    }`,
      replace: `    )
    .await
    {
        Ok(message) => Ok(AiProviderTestPayload {
            ok: true,
            code: "AI_PROVIDER_READY".to_string(),
            message,
        }),
        Err(error) => Ok(AiProviderTestPayload {
            ok: false,
            code: classify_provider_test_error_code(&error).to_string(),
            message: error,
        }),
    }`,
    },
    {
      label: 'command: ai_test_provider 透传真实结果与错误分类',
      done: `    match gateway::test_provider().await {
        Ok(message) => Ok(AiProviderTestPayload {`,
      find: `    match gateway::test_provider().await {
        Ok(()) => Ok(AiProviderTestPayload {
            ok: true,
            code: "AI_PROVIDER_READY".to_string(),
            message: "AI Provider 可用。".to_string(),
        }),
        Err(error) => Ok(AiProviderTestPayload {
            ok: false,
            code: "AI_PROVIDER_UNAVAILABLE".to_string(),
            message: error,
        }),
    }`,
      replace: `    match gateway::test_provider().await {
        Ok(message) => Ok(AiProviderTestPayload {
            ok: true,
            code: "AI_PROVIDER_READY".to_string(),
            message,
        }),
        Err(error) => Ok(AiProviderTestPayload {
            ok: false,
            code: classify_provider_test_error_code(&error).to_string(),
            message: error,
        }),
    }`,
    },
  ],
};

let totalApplied = 0;
let totalSkipped = 0;

for (const [relPath, fileEdits] of Object.entries(edits)) {
  const absPath = resolve(repoRoot, relPath);
  const raw = readFileSync(absPath, 'utf8');
  const usesCrlf = raw.includes('\r\n');
  let content = usesCrlf ? raw.replace(/\r\n/g, '\n') : raw;
  let applied = 0;
  let skipped = 0;

  for (const edit of fileEdits) {
    if (content.includes(edit.done)) {
      skipped += 1;
      console.log(`  [skip] ${edit.label}`);
      continue;
    }
    const occurrences = content.split(edit.find).length - 1;
    if (occurrences === 0) {
      throw new Error(`锚点未找到：${relPath} :: ${edit.label}`);
    }
    if (occurrences > 1) {
      throw new Error(`锚点不唯一（${occurrences} 处）：${relPath} :: ${edit.label}`);
    }
    content = content.replace(edit.find, () => edit.replace);
    applied += 1;
    console.log(`  [ok]   ${edit.label}`);
  }

  if (applied > 0) {
    const output = usesCrlf ? content.replace(/\n/g, '\r\n') : content;
    writeFileSync(absPath, output, 'utf8');
  }
  totalApplied += applied;
  totalSkipped += skipped;
  console.log(`${relPath}: applied ${applied}, skipped ${skipped}`);
}

console.log(`Done. applied ${totalApplied}, skipped ${totalSkipped}`);

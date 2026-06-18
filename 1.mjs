#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

function read(path) { return readFileSync(path, 'utf8'); }
function write(path, content) { writeFileSync(path, content, 'utf8'); }

function nl(s) { return s.replace(/\r\n/g, '\n'); }

function gitBlob(sha) {
  try {
    return nl(execSync(`git cat-file blob ${sha}`, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }));
  } catch {
    return null;
  }
}

function replace(content, oldStr, newStr, label) {
  const c = nl(content);
  const o = nl(oldStr);
  const n = nl(newStr);
  if (c.includes(n) && !c.includes(o)) return c;
  const count = c.split(o).length - 1;
  if (count === 0) throw new Error(`[${label}] 未找到匹配`);
  if (count > 1)  throw new Error(`[${label}] 匹配 ${count} 处`);
  return c.replace(o, n);
}

const ORIG = {
  'agent-sidecar/src/engines/contracts/runtime-contracts.ts': 'd7d4be0f43e9149b605c68f5fcbd7c98dcca393b',
  'agent-sidecar/src/engines/responses/responses.ts':         '8bd001567083f85c9bc55742670d6b339a5823f0',
  'agent-sidecar/src/schemas/events.ts':                      '037b05e002539b76959bc508e1f31c485ce4f389',
};

const tasks = [
  {
    label: 'composition.ts',
    path: 'agent-sidecar/src/engines/runtime/composition.ts',
    apply: (c) => {
      c = replace(c,
        "import { normalizeMastraError } from '../shared/errors.js';",
        "import { normalizeMastraError, classifyProviderErrorCode } from '../shared/errors.js';",
        'import');
      c = replace(c,
        '`原始模型透传失败：${normalizeMastraError(error)}`,\n                events,\n                options,\n            );',
        '`原始模型透传失败：${normalizeMastraError(error)}`,\n                events,\n                options,\n                classifyProviderErrorCode(error),\n            );',
        'catch');
      return c;
    },
  },
  {
    label: 'runtime-contracts.ts',
    path: 'agent-sidecar/src/engines/contracts/runtime-contracts.ts',
    fromOriginal: true,
    apply: (c) => {
      c = replace(c,
        '    readonly errorMessage?: string;',
        '    readonly errorMessage?: string;\n    /**\n     * Stable provider error classification code (e.g. `AI_PROVIDER_AUTH_FAILED`),\n     * derived from AI SDK structured error properties (HTTP status code).\n     * Consumed by the host to replace fragile substring matching.\n     */\n    readonly errorCode?: string;',
        'errorCode field');
      c = replace(c,
        '    result: response.result,\n});',
        '    result: response.result,\n    ...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),\n    ...(response.errorCode ? { errorCode: response.errorCode } : {}),\n});',
        'toAgentSidecarResponse');
      return c;
    },
  },
  {
    label: 'responses.ts',
    path: 'agent-sidecar/src/engines/responses/responses.ts',
    fromOriginal: true,
    apply: (c) => {
      c = replace(c,
        '): IAgentRuntimeResponse => {\n    return {\n        sessionId,\n        events,\n        result: null,\n        errorMessage: message,\n    };\n};',
        '    errorCode?: string,\n): IAgentRuntimeResponse => {\n    return {\n        sessionId,\n        events,\n        result: null,\n        errorMessage: message,\n        ...(errorCode ? { errorCode } : {}),\n    };\n};',
        'createErrorResponse');
      return c;
    },
  },
  {
    label: 'events.ts',
    path: 'agent-sidecar/src/schemas/events.ts',
    fromOriginal: true,
    apply: (c) => {
      c = replace(c,
        '  result: z.string().nullable(),\n});',
        '  result: z.string().nullable(),\n  errorMessage: z.string().optional(),\n  errorCode: z.string().optional(),\n});',
        'schema');
      c = replace(c,
        '  result: string | null;\n};',
        '  result: string | null;\n  errorMessage?: string;\n  errorCode?: string;\n};',
        'type');
      return c;
    },
  },
  {
    label: 'agent_sidecar.rs',
    path: 'src-tauri/src/commands/contracts/agent_sidecar.rs',
    apply: (c) => {
      c = replace(c,
        '    pub(crate) result: Option<String>,\n}\n\n// ============================================================================\n// 外部 ACP 编码 agent',
        '    pub(crate) result: Option<String>,\n    /// sidecar 结构化错误消息（来自 IAgentRuntimeResponse.errorMessage）。\n    #[serde(skip_serializing_if = "Option::is_none")]\n    pub(crate) error_message: Option<String>,\n    /// 稳定的 provider 错误分类码（如 AI_PROVIDER_AUTH_FAILED）。\n    #[serde(skip_serializing_if = "Option::is_none")]\n    pub(crate) error_code: Option<String>,\n}\n\n// ============================================================================\n// 外部 ACP 编码 agent',
        'AgentSidecarResponsePayload');
      return c;
    },
  },
  {
    label: 'client.rs',
    path: 'src-tauri/src/acp/client.rs',
    apply: (c) => {
      c = replace(c,
        'use tokio::sync::{mpsc, oneshot};',
        'use tokio::sync::{mpsc, oneshot};\n\nuse crate::commands::contracts::SecretString;',
        'import');
      c = replace(c,
        '    pub api_key: String,',
        '    pub api_key: SecretString,',
        'ExtModelConfig.api_key');
      return c;
    },
  },
  {
    label: 'bridge.rs',
    path: 'src-tauri/src/acp/bridge.rs',
    apply: (c) => {
      c = replace(c,
        '        api_key: config.api_key.into_inner(),',
        '        api_key: config.api_key,',
        'model_config_to_ext');
      c = replace(c,
        'assert_eq!(model_config.api_key, "secret-key");',
        'assert_eq!(model_config.api_key.expose(), "secret-key");',
        'test assertion');
      return c;
    },
  },
  {
    label: 'connection.rs',
    path: 'src-tauri/src/ai/gateway/connection.rs',
    apply: (c) => {
      c = replace(c,
        '    let response = run_test_model_chat(app, build_test_request(candidate)?).await?;\n    let reply = response.result.unwrap_or_default();\n    let reply = reply.trim();\n\n    if reply.is_empty() {',
        '    let response = run_test_model_chat(app, build_test_request(candidate)?).await?;\n\n    // 优先检查 sidecar 返回的结构化错误（如 401 认证失败），\n    // 避免将 provider 错误误分类为 AI_RESPONSE_INVALID。\n    if let Some(error_message) = &response.error_message {\n        let code = response.error_code.as_deref().unwrap_or("AI_PROVIDER_UNAVAILABLE");\n        return Err(errors::error(code, error_message.clone()));\n    }\n\n    let reply = response.result.unwrap_or_default();\n    let reply = reply.trim();\n\n    if reply.is_empty() {',
        'error extraction');
      return c;
    },
  },
  {
    label: 'gateway.rs',
    path: 'src-tauri/src/commands/ai/gateway.rs',
    apply: (c) => {
      c = replace(c,
        "fn classify_provider_test_error_code(error: &str) -> &'static str {\n    let normalized = error.to_ascii_lowercase();",
        'fn classify_provider_test_error_code(error: &str) -> String {\n    // 优先解析结构化错误 JSON（由 errors::error() 构造的 AiErrorPayload）。\n    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(error) {\n        if let Some(code) = payload.get("code").and_then(|v| v.as_str()) {\n            return code.to_string();\n        }\n    }\n\n    let normalized = error.to_ascii_lowercase();',
        'function signature');

      c = replace(c,
        '        "AI_PROVIDER_AUTH_FAILED"\n    } else if',
        '        "AI_PROVIDER_AUTH_FAILED".to_string()\n    } else if',
        'return 1');
      c = replace(c,
        '        "AI_PROVIDER_RATE_LIMITED"\n    } else if',
        '        "AI_PROVIDER_RATE_LIMITED".to_string()\n    } else if',
        'return 2');
      c = replace(c,
        '        "AI_PROVIDER_NOT_CONFIGURED"\n    } else if',
        '        "AI_PROVIDER_NOT_CONFIGURED".to_string()\n    } else if',
        'return 3');
      c = replace(c,
        '        "AI_RESPONSE_INVALID"\n    } else {',
        '        "AI_RESPONSE_INVALID".to_string()\n    } else {',
        'return 4');
      c = replace(c,
        '        "AI_PROVIDER_UNAVAILABLE"\n    }\n}',
        '        "AI_PROVIDER_UNAVAILABLE".to_string()\n    }\n}',
        'return 5');

      // 两处调用点去掉多余的 .to_string()
      c = replace(c,
        '            code: classify_provider_test_error_code(&error).to_string(),\n            message: error,\n        }),\n    }\n}\n\n#[tauri::command]\n#[specta::specta]\npub async fn ai_connect_provider',
        '            code: classify_provider_test_error_code(&error),\n            message: error,\n        }),\n    }\n}\n\n#[tauri::command]\n#[specta::specta]\npub async fn ai_connect_provider',
        'call site 1');
      c = replace(c,
        '            code: classify_provider_test_error_code(&error).to_string(),\n            message: error,\n        }),\n    }\n}\n\n#[tauri::command]\n#[specta::specta]\npub async fn ai_generate_conversation_title',
        '            code: classify_provider_test_error_code(&error),\n            message: error,\n        }),\n    }\n}\n\n#[tauri::command]\n#[specta::specta]\npub async fn ai_generate_conversation_title',
        'call site 2');
      return c;
    },
  },
];

let ok = 0, fail = 0;

for (const task of tasks) {
  process.stdout.write(`📝 [${task.label}] ... `);
  try {
    let content;
    if (task.fromOriginal) {
      const blob = ORIG[task.path];
      content = gitBlob(blob);
      if (!content) {
        console.log('⚠️  blob SHA 不可用，使用磁盘版本');
        content = nl(read(task.path));
      }
    } else {
      content = nl(read(task.path));
    }
    const newContent = task.apply(content);
    if (newContent === content) {
      console.log('⏭️  无变化');
      continue;
    }
    write(task.path, newContent);
    console.log('✅');
    ok++;
  } catch (err) {
    console.log(`❌ ${err.message}`);
    fail++;
  }
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`✅ 成功: ${ok}  ❌ 失败: ${fail}  共: ${tasks.length}`);
if (fail > 0) {
  console.log('\n⚠️  失败的文件可用 git checkout -- <path> 恢复后重跑');
} else {
  console.log('\n✨ 全部完成，运行 git diff 检查后 git add + commit');
}
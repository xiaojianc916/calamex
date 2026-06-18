#!/usr/bin/env node
// D7-④ Rust 侧：ACP available_commands_update → TAgentUiEvent 投影（ADR-20260617）。
// 在 src-tauri/src/acp/ui_event.rs 增加 helper + match 分支 + 两个单测，并校正模块文档。
// 幂等；patch 前归一 LF，写回按原 EOL 还原。

import { readFileSync, writeFileSync } from 'node:fs';

const L = (...xs) => xs.join('\n');

const patchFile = (file, marker, edits) => {
  const original = readFileSync(file, 'utf8');
  if (original.includes(marker)) {
    console.log(`[skip] ${file} 已含 ${marker}`);
    return;
  }
  const hadCrlf = original.includes('\r\n');
  let text = original.replace(/\r\n/g, '\n');
  for (const [anchor, replacement, keyword] of edits) {
    const count = text.split(anchor).length - 1;
    if (count !== 1) {
      console.error(`--- ${file} 上下文 \"${keyword}\" ---`);
      text.split('\n').forEach((line, idx) => {
        if (line.includes(keyword)) {
          console.error(`${idx + 1}: ${line}`);
        }
      });
      console.error('--- end ---');
      throw new Error(`[${file}] anchor \"${keyword}\": expected 1 match but found ${count}`);
    }
    text = text.replace(anchor, () => replacement);
  }
  writeFileSync(file, hadCrlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  console.log(`[done] patched ${file}`);
};

const FILE = 'src-tauri/src/acp/ui_event.rs';

patchFile(FILE, 'available_commands_ui_event', [
  // 1) helper
  [
    L(
      'fn mode_update_ui_event(mode_id: &str) -> Value {',
      '    json!({ \"type\": \"mode_update\", \"modeId\": mode_id })',
      '}',
    ),
    L(
      'fn mode_update_ui_event(mode_id: &str) -> Value {',
      '    json!({ \"type\": \"mode_update\", \"modeId\": mode_id })',
      '}',
      '',
      '/// 构造可用斜杠命令更新 `TAgentUiEvent`（`type` 为 `available_commands_update`）。',
      '///',
      '/// 投影 ACP `available_commands_update`（外部 agent 声明本会话可用斜杠命令）：整份透传',
      '/// ACP `availableCommands` 原始数组（逐字透传，不解读其结构、不伪造默认项），交前端 ACL',
      '/// 归一到命令面板 VM（见 src/types/ai/sidecar.ts 的 TAgentUiEventAvailableCommandsUpdate',
      '/// 与 from-acp-available-commands.ts）。',
      'fn available_commands_ui_event(available_commands: &Value) -> Value {',
      '    json!({ \"type\": \"available_commands_update\", \"availableCommands\": available_commands.clone() })',
      '}',
    ),
    'mode_update_ui_event',
  ],
  // 2) match arm
  [
    L(
      '        \"current_mode_update\" => {',
      '            let mode_id = update.get(\"currentModeId\").and_then(Value::as_str)?;',
      '            Some(mode_update_ui_event(mode_id))',
      '        }',
    ),
    L(
      '        \"current_mode_update\" => {',
      '            let mode_id = update.get(\"currentModeId\").and_then(Value::as_str)?;',
      '            Some(mode_update_ui_event(mode_id))',
      '        }',
      '        // 外部 agent 声明本会话可用的斜杠命令（标准 available_commands_update）：整份透传',
      '        // availableCommands 原始数组，交前端 ACL 归一到命令面板 VM（D7-④）。',
      '        \"available_commands_update\" => {',
      '            let commands = update.get(\"availableCommands\")?;',
      '            Some(available_commands_ui_event(commands))',
      '        }',
    ),
    'current_mode_update',
  ],
  // 3) module doc paragraph
  [
    L(
      '//! 其余 session/update 变体（`plan` / `usage_update` / `available_commands_update` 等）',
      '//! 暂未投影：plan/usage 经信封回安主，会话元数据待后续 slice 接入，故此处显式返回 None',
      '//! 作为可扩展接入点。`current_mode_update`（外部 agent 自行切换当前会话模式）已投影为',
      '//! `mode_update` UI 事件（见 session_notification_to_ui_event 的对应分支）。',
    ),
    L(
      '//! 其余 session/update 变体（`plan` / `usage_update` 等）暂未投影：plan/usage 经信封回',
      '//! 安主，待后续 slice 接入，故此处显式返回 None 作为可扩展接入点。`current_mode_update`',
      '//! （外部 agent 切换当前会话模式）已投影为 `mode_update`、`available_commands_update`',
      '//! （外部 agent 声明本会话可用斜杠命令）已投影为同名 UI 事件（见',
      '//! session_notification_to_ui_event 的对应分支）。',
    ),
    'available_commands_update',
  ],
  // 4) inline _ => None comment
  [
    L(
      '        // 其余变体暂未投影（plan/usage_update 经信封回安主；available_commands_update',
      '        // 等会话元数据待后续 slice）。显式 None 作为接入点。',
      '        _ => None,',
    ),
    L(
      '        // 其余变体暂未投影（plan/usage_update 经信封回安主，待后续 slice）。显式 None 作为接入点。',
      '        _ => None,',
    ),
    '_ => None',
  ],
  // 5) tests
  [
    L(
      '    #[test]',
      '    fn current_mode_update_without_mode_id_yields_none() {',
      '        let n = notif(json!({ \"sessionUpdate\": \"current_mode_update\" }));',
      '        assert!(session_notification_to_ui_event(&n).is_none());',
      '    }',
    ),
    L(
      '    #[test]',
      '    fn current_mode_update_without_mode_id_yields_none() {',
      '        let n = notif(json!({ \"sessionUpdate\": \"current_mode_update\" }));',
      '        assert!(session_notification_to_ui_event(&n).is_none());',
      '    }',
      '',
      '    #[test]',
      '    fn available_commands_update_passes_through_raw_array() {',
      '        let commands = json!([',
      '            { \"name\": \"plan\", \"description\": \"生成计划\" },',
      '            { \"name\": \"test\", \"description\": \"运行测试\", \"input\": { \"hint\": \"范围\" } }',
      '        ]);',
      '        let n = notif(json!({',
      '            \"sessionUpdate\": \"available_commands_update\",',
      '            \"availableCommands\": commands.clone()',
      '        }));',
      '        let ui = session_notification_to_ui_event(&n).unwrap();',
      '        assert_eq!(ui[\"type\"], \"available_commands_update\");',
      '        assert_eq!(ui[\"availableCommands\"], commands);',
      '    }',
      '',
      '    #[test]',
      '    fn available_commands_update_without_field_yields_none() {',
      '        let n = notif(json!({ \"sessionUpdate\": \"available_commands_update\" }));',
      '        assert!(session_notification_to_ui_event(&n).is_none());',
      '    }',
    ),
    'current_mode_update_without_mode_id_yields_none',
  ],
]);

console.log('[all done] D7-④ Rust 侧 available_commands_update 投影已生成。');

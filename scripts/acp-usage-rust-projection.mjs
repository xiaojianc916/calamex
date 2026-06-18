#!/usr/bin/env node
// D7-⑦ Rust 投影：ACP session/update 的 usage_update → usage_update UI 事件（ADR-20260617）。
// 整份透传 usage 原始对象（不解读/不折算），与 available_commands_update 投影同构。
// 6 处编辑（helper / match 臂 / 2 单测 / 2 处文档同步），单文件原子写：任一 anchor 未命中即抛错、不落盘。
// 幂等：marker=usage_update_ui_event。LF 归一、原 EOL 还原。

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
      console.error(`--- ${file} 上下文 "${keyword}" ---`);
      text.split('\n').forEach((line, idx) => {
        if (line.includes(keyword)) {
          console.error(`${idx + 1}: ${line}`);
        }
      });
      console.error('--- end ---');
      throw new Error(`[${file}] anchor "${keyword}": expected 1 match but found ${count}`);
    }
    text = text.replace(anchor, () => replacement);
  }
  writeFileSync(file, hadCrlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  console.log(`[done] patched ${file}`);
};

const FILE = 'src-tauri/src/acp/ui_event.rs';

patchFile(FILE, 'usage_update_ui_event', [
  // R1: helper
  [
    L(
      'fn available_commands_ui_event(available_commands: &Value) -> Value {',
      '    json!({ "type": "available_commands_update", "availableCommands": available_commands.clone() })',
      '}',
    ),
    L(
      'fn available_commands_ui_event(available_commands: &Value) -> Value {',
      '    json!({ "type": "available_commands_update", "availableCommands": available_commands.clone() })',
      '}',
      '',
      '/// 构造用量更新 `TAgentUiEvent`（`type` 为 `usage_update`）。',
      '///',
      '/// 投影 ACP `usage_update`（外部 agent 上报本回合 token 用量）：整份透传 ACP `usage` 原始',
      '/// 对象（逐字透传，不解读其结构、不本地折算），交前端 ACL 归一到用量 VM（见',
      '/// src/types/ai/sidecar.ts 的 TAgentUiEventUsageUpdate 与 from-acp-usage.ts）。',
      'fn usage_update_ui_event(usage: &Value) -> Value {',
      '    json!({ "type": "usage_update", "usage": usage.clone() })',
      '}',
    ),
    'available_commands_ui_event',
  ],
  // R2: match arm
  [
    L(
      '        "available_commands_update" => {',
      '            let commands = update.get("availableCommands")?;',
      '            Some(available_commands_ui_event(commands))',
      '        }',
    ),
    L(
      '        "available_commands_update" => {',
      '            let commands = update.get("availableCommands")?;',
      '            Some(available_commands_ui_event(commands))',
      '        }',
      '        // 外部 agent 上报本回合 token 用量（标准 usage_update）：整份透传 usage 原始对象，',
      '        // 交前端 ACL 归一到用量 VM（D7-⑦）。',
      '        "usage_update" => {',
      '            let usage = update.get("usage")?;',
      '            Some(usage_update_ui_event(usage))',
      '        }',
    ),
    'Some(available_commands_ui_event(commands))',
  ],
  // R6: unit tests
  [
    L(
      '    #[test]',
      '    fn available_commands_update_without_field_yields_none() {',
      '        let n = notif(json!({ "sessionUpdate": "available_commands_update" }));',
      '        assert!(session_notification_to_ui_event(&n).is_none());',
      '    }',
    ),
    L(
      '    #[test]',
      '    fn available_commands_update_without_field_yields_none() {',
      '        let n = notif(json!({ "sessionUpdate": "available_commands_update" }));',
      '        assert!(session_notification_to_ui_event(&n).is_none());',
      '    }',
      '',
      '    #[test]',
      '    fn usage_update_passes_through_raw_usage() {',
      '        let usage = json!({ "inputTokens": 10, "outputTokens": 5, "totalTokens": 15 });',
      '        let n = notif(json!({',
      '            "sessionUpdate": "usage_update",',
      '            "usage": usage.clone()',
      '        }));',
      '        let ui = session_notification_to_ui_event(&n).unwrap();',
      '        assert_eq!(ui["type"], "usage_update");',
      '        assert_eq!(ui["usage"], usage);',
      '    }',
      '',
      '    #[test]',
      '    fn usage_update_without_field_yields_none() {',
      '        let n = notif(json!({ "sessionUpdate": "usage_update" }));',
      '        assert!(session_notification_to_ui_event(&n).is_none());',
      '    }',
    ),
    'available_commands_update_without_field_yields_none',
  ],
  // R3: 内联 _ => None 注释
  ['（plan/usage_update 经信封回宿主，待后续 slice）', '（plan 经信封回宿主，待后续 slice）', 'plan'],
  // R4: 模块文档变体清单
  ['其余 session/update 变体（`plan` / `usage_update` 等）', '其余 session/update 变体（`plan` 等）', 'session/update'],
  // R5: 模块文档句子
  ['暂未投影：plan/usage 经信封回宿主', '暂未投影：plan 经信封回宿主', 'plan'],
]);

console.log('[all done] D7-⑦ Rust usage_update 投影已应用。');

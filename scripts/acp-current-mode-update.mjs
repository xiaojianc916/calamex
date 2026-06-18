// scripts/acp-current-mode-update.mjs
//
// 一次性 codemod（D7-③-b-1）：把 ACP 标准 session/update 的 current_mode_update
// 投影为前端 mode_update UI 事件，端到端接线（仅「当前模式已变更」信号；可用模式清单
// 来自 NewSessionResponse.modes，属后续 slice ③-b-2）。
//   ui_event.rs        新增 current_mode_update -> { type: mode_update, modeId } 投影 + 单测
//   types/ai/sidecar.ts 新增 TAgentUiEventModeUpdate 线格式类型并并入 TAgentUiEvent 联合
//
// 幂等：每个文件先按 skipIf 标记跳过；每个锚点要求恰好命中 1 次，否则抛错中止。
// EOL 容错：本地工作树可能是 CRLF，先归一到 LF 匹配，写回时还原文件原有 CRLF，避免行尾噪声。
// 仓库根目录运行：node scripts/acp-current-mode-update.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const edits = [
  {
    file: 'src-tauri/src/acp/ui_event.rs',
    skipIf: 'mode_update_ui_event',
    steps: [
      {
        find: `//! 其余 session/update 变体（\`plan\` / \`usage_update\` / \`current_mode_update\` /
//! \`available_commands_update\` 等）暂未投影：plan/usage 经信封回宿主，会话元数据
//! 待后续 slice 接入，故此处显式返回 None 作为可扩展接入点。`,
        replace: `//! 其余 session/update 变体（\`plan\` / \`usage_update\` / \`available_commands_update\` 等）
//! 暂未投影：plan/usage 经信封回宿主，会话元数据待后续 slice 接入，故此处显式返回 None
//! 作为可扩展接入点。\`current_mode_update\`（外部 agent 自行切换当前会话模式）已投影为
//! \`mode_update\` UI 事件（见 session_notification_to_ui_event 的对应分支）。`,
      },
      {
        find: `fn tool_call_ui_event(kind: &str, update: &Value) -> Value {
    json!({ "type": kind, "acpUpdate": update.clone() })
}`,
        replace: `fn tool_call_ui_event(kind: &str, update: &Value) -> Value {
    json!({ "type": kind, "acpUpdate": update.clone() })
}

/// 构造模式切换 \`TAgentUiEvent\`（\`type\` 为 \`mode_update\`）。
///
/// 投影 ACP \`current_mode_update\`（外部 agent 自行切换当前会话模式）：仅透传 \`modeId\`
/// （ACP \`currentModeId\` 原值，逐字透传，绝不本地映射），交前端归一到模式选择器 VM。
fn mode_update_ui_event(mode_id: &str) -> Value {
    json!({ "type": "mode_update", "modeId": mode_id })
}`,
      },
      {
        find: `        "tool_call" | "tool_call_update" => Some(tool_call_ui_event(kind, update)),
        // 其余变体暂未投影（plan/usage_update 经信封回宿主；current_mode_update /
        // available_commands_update 等会话元数据待后续 slice）。显式 None 作为接入点。
        _ => None,`,
        replace: `        "tool_call" | "tool_call_update" => Some(tool_call_ui_event(kind, update)),
        // 外部 agent 自行切换当前会话模式（标准 current_mode_update）：取其 currentModeId
        // 投影为 mode_update UI 事件，交前端归一到模式选择器 VM（D7-③-b）。
        "current_mode_update" => {
            let mode_id = update.get("currentModeId").and_then(Value::as_str)?;
            Some(mode_update_ui_event(mode_id))
        }
        // 其余变体暂未投影（plan/usage_update 经信封回宿主；available_commands_update
        // 等会话元数据待后续 slice）。显式 None 作为接入点。
        _ => None,`,
      },
      {
        find: `    #[test]
    fn unmapped_session_update_yields_none() {`,
        replace: `    #[test]
    fn current_mode_update_maps_to_mode_update_event() {
        let n = notif(json!({
            "sessionUpdate": "current_mode_update",
            "currentModeId": "code"
        }));
        let ui = session_notification_to_ui_event(&n).unwrap();
        assert_eq!(ui["type"], "mode_update");
        assert_eq!(ui["modeId"], "code");
    }

    #[test]
    fn current_mode_update_without_mode_id_yields_none() {
        let n = notif(json!({ "sessionUpdate": "current_mode_update" }));
        assert!(session_notification_to_ui_event(&n).is_none());
    }

    #[test]
    fn unmapped_session_update_yields_none() {`,
      },
    ],
  },
  {
    file: 'src/types/ai/sidecar.ts',
    skipIf: 'TAgentUiEventModeUpdate',
    steps: [
      {
        find: `export type TAgentUiEventToolCallUpdate = {
  type: 'tool_call_update';
  acpUpdate: TAcpToolCallUpdate;
};

export type TAgentUiEvent =`,
        replace: `export type TAgentUiEventToolCallUpdate = {
  type: 'tool_call_update';
  acpUpdate: TAcpToolCallUpdate;
};

/* ----------------------------------------------------------------------------
 * ACP 会话模式切换 UI 事件（ADR-20260617 · D7-③-b）
 *
 * 投影 ACP \`session/update\` 的 \`current_mode_update\`（外部 agent 自行切换当前会话模式，
 * 见 Rust host src-tauri/src/acp/ui_event.rs）：仅携带切换后的 \`modeId\`（ACP \`currentModeId\`
 * 原值，逐字透传，不本地映射）。可用模式清单另由会话建立时的 \`NewSessionResponse.modes\`
 * 提供（见后续 slice）；本事件只负责「当前模式已变更」信号，交前端模式选择器 VM 据
 * \`modeId\` 高亮当前项。
 * -------------------------------------------------------------------------- */
export type TAgentUiEventModeUpdate = {
  type: 'mode_update';
  modeId: string;
};

export type TAgentUiEvent =`,
      },
      {
        find: `  | TAgentUiEventToolCall
  | TAgentUiEventToolCallUpdate
  | { type: 'approval_required'; request: IApprovalRequest }`,
        replace: `  | TAgentUiEventToolCall
  | TAgentUiEventToolCallUpdate
  | TAgentUiEventModeUpdate
  | { type: 'approval_required'; request: IApprovalRequest }`,
      },
    ],
  },
];

let changed = 0;
for (const edit of edits) {
  const raw = readFileSync(edit.file, 'utf8');
  if (edit.skipIf && raw.includes(edit.skipIf)) {
    console.log(`skip (already applied): ${edit.file}`);
    continue;
  }
  // EOL 归一：CRLF -> LF 匹配，写回时还原，避免行尾噪声污染 diff。
  const hadCRLF = raw.includes('\r\n');
  let src = hadCRLF ? raw.replace(/\r\n/g, '\n') : raw;
  for (const step of edit.steps) {
    const count = src.split(step.find).length - 1;
    if (count !== 1) {
      throw new Error(
        `expected exactly 1 anchor in ${edit.file}, found ${count}:\n--- anchor ---\n${step.find}`,
      );
    }
    src = src.replace(step.find, () => step.replace);
  }
  const out = hadCRLF ? src.replace(/\n/g, '\r\n') : src;
  writeFileSync(edit.file, out, 'utf8');
  changed += 1;
  console.log(`patched: ${edit.file}${hadCRLF ? ' (CRLF preserved)' : ''}`);
}
console.log(`\ndone. files changed: ${changed}/${edits.length}`);

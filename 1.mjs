// scripts/f3-remove-resize-repaint-suppression-backend.mjs
// F3（方案B）：移除「交互 resize 重绘帧丢弃」抑制的后端半边，并级联删除随之而死的全部代码
// （含整份 vte_detect.rs）。对齐行业标杆：交互输出一律原样落入回放快照，绝不丢 PTY 字节。
// 覆盖：commands/terminal/{events,state,commands,tests}.rs、terminal/{snapshot,mod}.rs；删除 vte_detect.rs。
// 安全：逐字锚点 + 计数校验；全部改完并通过才落盘。含 \x1b 的测试/注释用地标区间删除。
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const toLF = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/\r\n/g, '\n');
const files = {
  events: 'src-tauri/src/commands/terminal/events.rs',
  state: 'src-tauri/src/commands/terminal/state.rs',
  commands: 'src-tauri/src/commands/terminal/commands.rs',
  tests: 'src-tauri/src/commands/terminal/tests.rs',
  snapshot: 'src-tauri/src/terminal/snapshot.rs',
  mod: 'src-tauri/src/terminal/mod.rs',
};
const DELETE_FILE = 'src-tauri/src/terminal/vte_detect.rs';
const buf = Object.fromEntries(
  Object.entries(files).map(([k, p]) => [k, toLF(readFileSync(p, 'utf8'))]),
);
const done = [];
const countOf = (hay, needle) => hay.split(needle).length - 1;

function once(key, label, oldStr, newStr) {
  const from = toLF(oldStr);
  const n = countOf(buf[key], from);
  if (n !== 1) throw new Error(`[${key}:${label}] 期望恰好 1 处，实际 ${n} 处。`);
  buf[key] = buf[key].replace(from, toLF(newStr));
  done.push(`${key}:${label}`);
}
function deleteRange(key, label, startAnchor, endAnchor) {
  const a = toLF(startAnchor), b = toLF(endAnchor);
  if (countOf(buf[key], a) !== 1) throw new Error(`[${key}:${label}] 起点地标不唯一。`);
  if (countOf(buf[key], b) !== 1) throw new Error(`[${key}:${label}] 终点地标不唯一。`);
  const ai = buf[key].indexOf(a), bi = buf[key].indexOf(b);
  if (bi <= ai) throw new Error(`[${key}:${label}] 终点在起点之前。`);
  buf[key] = buf[key].slice(0, ai) + buf[key].slice(bi);
  done.push(`${key}:${label}`);
}

// ── events.rs ──
once('events', 'import',
`    set_session_state, should_skip_snapshot_for_interactive_resize_repaint,
};`,
`    set_session_state,
};`);
once('events', 'body',
`    if chunk.is_empty() {
        return;
    }
    if !should_skip_snapshot_for_interactive_resize_repaint(state, session_id, &chunk) {
        let _ = append_terminal_snapshot(state, session_id, &chunk);
    }
    emit_terminal_data(`,
`    if chunk.is_empty() {
        return;
    }
    // 对齐行业标杆（VS Code / Windows Terminal / Alacritty）：交互输出一律原样落入回放快照，
    // 绝不为「resize 重绘」丢弃 PTY 字节；直播与回放严格同源。
    let _ = append_terminal_snapshot(state, session_id, &chunk);
    emit_terminal_data(`);

// ── state.rs ──
once('state', 'doc-mod',
'//! 集成终端共享状态：会话、快照、交互视觉态、活动运行与切换态输入缓冲。',
'//! 集成终端共享状态：会话、快照、活动运行与切换态输入缓冲。');
once('state', 'import',
`use crate::terminal::{
    flow_control::FlowController,
    snapshot::{
        TerminalInteractiveVisualState,
        is_likely_interactive_resize_repaint_frame,
        trim_terminal_snapshot,
    },
    state_machine::StateMachine,
    types::{Geometry, TerminalState},
    vte_detect::scan_ansi_csi_events,
    wsl_pty::LocalWslPtyHandle,
};`,
`use crate::terminal::{
    flow_control::FlowController,
    snapshot::trim_terminal_snapshot,
    state_machine::StateMachine,
    types::{Geometry, TerminalState},
    wsl_pty::LocalWslPtyHandle,
};`);
once('state', 'const',
`const TERMINAL_RESIZE_REPAINT_SUPPRESSION: Duration = Duration::from_millis(240);
const MAX_PENDING_SWITCH_INPUT_BYTES: usize = 64 * 1024;`,
`const MAX_PENDING_SWITCH_INPUT_BYTES: usize = 64 * 1024;`);
once('state', 'field',
`    /// 该会话状态机的当前状态。\`None\` 表示尚无记录，以 \`Booting\` 为基线。
    state: Option<TerminalState>,
    /// 交互视觉态（alt-screen / resize 重绘抑制）。\`None\` 表示尚无记录。
    interactive_visual: Option<TerminalInteractiveVisualState>,
    /// 该会话的输出流控器（P2 ack 背压）。\`None\` 表示尚未重置过。`,
`    /// 该会话状态机的当前状态。\`None\` 表示尚无记录，以 \`Booting\` 为基线。
    state: Option<TerminalState>,
    /// 该会话的输出流控器（P2 ack 背压）。\`None\` 表示尚未重置过。`);
once('state', 'is-empty',
`            && self.state.is_none()
            && self.interactive_visual.is_none()
            && self.flow_controller.is_none()`,
`            && self.state.is_none()
            && self.flow_controller.is_none()`);
once('state', 'sessions-doc',
`    /// 调用 \`set_terminal_snapshot\` / \`remove_terminal_interactive_visual_state\`（二者现取
    /// \`per_session\` 锁）。若把 \`sessions\` 并入 \`per_session\`，将在同一线程重入同一把锁导致自`,
`    /// 调用 \`set_terminal_snapshot\`（取 \`per_session\` 锁）。若把 \`sessions\` 并入
    /// \`per_session\`，将在同一线程重入同一把锁导致自`);
once('state', 'per-session-doc',
'    /// 其余「按 session_id 归集」的叶子状态（快照 / 交互视觉态 / 切换态输入 / geometry /',
'    /// 其余「按 session_id 归集」的叶子状态（快照 / 切换态输入 / geometry /');
deleteRange('state', 'fns-visual',
  'pub(super) fn remove_terminal_interactive_visual_state(',
  '/// 每会话 geometry：');
deleteRange('state', 'fn-should-skip',
  'pub(super) fn should_skip_snapshot_for_interactive_resize_repaint(',
  'pub(super) fn should_recreate_terminal_session(');

// ── snapshot.rs ──
once('snapshot', 'import-instant',
`use std::time::Instant;

/// 终端快照保留的**字节**上限（不是字符数）。160 KiB。`,
`/// 终端快照保留的**字节**上限（不是字符数）。160 KiB。`);
once('snapshot', 'struct',
`const TERMINAL_SNAPSHOT_TRIM_TARGET: usize = TERMINAL_SNAPSHOT_MAX_LENGTH * 3 / 4;

#[derive(Clone, Copy, Default)]
pub struct TerminalInteractiveVisualState {
    pub resize_repaint_suppress_until: Option<Instant>,
    pub alt_screen_active: bool,
}

/// 将快照裁剪到`,
`const TERMINAL_SNAPSHOT_TRIM_TARGET: usize = TERMINAL_SNAPSHOT_MAX_LENGTH * 3 / 4;

/// 将快照裁剪到`);
deleteRange('snapshot', 'fn-is-likely',
  '\n/// 整屏交互式 resize 重绘帧判定。',
  '#[cfg(test)]');

// ── commands.rs ──
once('commands', 'import-mark',
'    get_terminal_snapshot, lock_terminal_sessions, mark_terminal_resize_repaint_suppression,',
'    get_terminal_snapshot, lock_terminal_sessions,');
once('commands', 'import-visual',
'    remove_session_geometry, remove_session_liveness, remove_terminal_interactive_visual_state,',
'    remove_session_geometry, remove_session_liveness,');
once('commands', 'reuse-mark',
`                mark_terminal_resize_repaint_suppression(&terminal_state, &payload.session_id);
                let initial_output = get_terminal_snapshot(&terminal_state, &payload.session_id)?;`,
`                let initial_output = get_terminal_snapshot(&terminal_state, &payload.session_id)?;`);
once('commands', 'create-visual',
`        set_terminal_snapshot(&terminal_state, &payload.session_id, String::new())?;
        remove_terminal_interactive_visual_state(&terminal_state, &payload.session_id)?;

        (terminal_cwd, true)`,
`        set_terminal_snapshot(&terminal_state, &payload.session_id, String::new())?;

        (terminal_cwd, true)`);
once('commands', 'resize-mark',
`        .map_err(|error| error.to_string())?;
    mark_terminal_resize_repaint_suppression(&terminal_state, &payload.session_id);
    Ok(())
}`,
`        .map_err(|error| error.to_string())?;
    Ok(())
}`);
once('commands', 'close-visual',
`    remove_terminal_snapshot(&terminal_state, &payload.session_id)?;
    remove_terminal_interactive_visual_state(&terminal_state, &payload.session_id)?;
    remove_pending_switch_input(&terminal_state, &payload.session_id);`,
`    remove_terminal_snapshot(&terminal_state, &payload.session_id)?;
    remove_pending_switch_input(&terminal_state, &payload.session_id);`);

// ── tests.rs ──
once('tests', 'import',
`    get_active_terminal_run_input_target, get_session_state,
    mark_terminal_resize_repaint_suppression, set_session_state,
    should_skip_snapshot_for_interactive_resize_repaint,
    take_and_prepend_pending_switch_input, try_mark_active_terminal_run,`,
`    get_active_terminal_run_input_target, get_session_state, set_session_state,
    take_and_prepend_pending_switch_input, try_mark_active_terminal_run,`);
deleteRange('tests', 'suppress-tests',
  '#[test]\nfn interactive_resize_repaint_is_excluded_from_snapshot_window() {',
  '#[test]\nfn dispatch_command_prefers_workspace_root_over_script_directory() {');

// ── terminal/mod.rs ──
once('mod', 'mod-decl',
`pub mod utf8_decoder;
pub mod vte_detect;
pub mod wsl;`,
`pub mod utf8_decoder;
pub mod wsl;`);

for (const [k, p] of Object.entries(files)) writeFileSync(p, buf[k]);
unlinkSync(DELETE_FILE);
console.log(`✅ 后端 6 文件已改（${done.length} 处），并删除 vte_detect.rs：\n  ` + done.join('\n  '));
console.log('ℹ️ vte crate 仅曾被 vte_detect.rs 使用；删文件后成为未用依赖（不影响 clippy）。如需彻底移除，手动删 src-tauri/Cargo.toml 的 vte 依赖。');
console.log('▶ 守卫：cd src-tauri && cargo clippy --all-targets && cargo test');
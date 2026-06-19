#!/usr/bin/env node
// fix-terminal-5b-cancel-escalation.mjs
// 终端审计 #5 续：把"取消运行"从单发 Ctrl-C 升级为专业的 SIGINT→SIGINT→SIGQUIT→强拆PTY 阶梯。
// 用法：node fix-terminal-5b-cancel-escalation.mjs           （预演，不写）
//       node fix-terminal-5b-cancel-escalation.mjs --write   （实际写入）
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WRITE = process.argv.includes("--write");
const ROOT = process.cwd();

const norm = (s) => s.replace(/\r\n/g, "\n");               // 锚点/文件统一归一到 LF 比对
const detectEol = (s) => (s.includes("\r\n") ? "\r\n" : "\n");
const restoreEol = (s, eol) => (eol === "\r\n" ? s.replace(/\n/g, "\r\n") : s);
const occ = (hay, needle) => hay.split(needle).length - 1; // 出现次数

const FILES = [
  {
    rel: "src-tauri/src/commands/terminal/commands.rs",
    forbiddenAfter: [
      "graceful / kill 同样发 Ctrl-C",
      "_app: AppHandle",
      "由 ConPTY 转成 SIGINT",
    ],
    edits: [
      {
        id: "escalation-consts",
        count: 1,
        find: norm(String.raw`const TEARDOWN_WATCH_POLL: Duration = Duration::from_millis(250);`),
        replace: norm(String.raw`const TEARDOWN_WATCH_POLL: Duration = Duration::from_millis(250);

/// 取消升级阶梯——SIGINT 宽限期：发出 Ctrl-C(SIGINT) 后等待运行经 OSC 133 D 收尾的时长；
/// 超时仍在运行则升级。首发 SIGINT 与补发 SIGINT 各用一个该宽限期。
const CANCEL_SIGINT_GRACE: Duration = Duration::from_secs(2);
/// 取消升级阶梯——SIGQUIT 宽限期：补发 Ctrl-C 仍无效后改发 Ctrl-\(SIGQUIT)，再等这么久；
/// 仍未收尾则进入最后手段（强拆该会话 PTY）。
const CANCEL_SIGQUIT_GRACE: Duration = Duration::from_secs(2);
/// 取消升级阶梯——轮询间隔：周期性复检活动运行是否已被 OSC 133 D 清理，避免忙等。
const CANCEL_ESCALATION_POLL: Duration = Duration::from_millis(100);`),
      },
      {
        id: "cancel-fn-and-watch",
        count: 1,
        find: norm(String.raw`pub async fn cancel_terminal_run(
    _app: AppHandle,
    state: State<'_, TerminalSessionState>,
    payload: CancelTerminalRunRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    // Shell Integration：运行即交互 shell 的前台命令。取消 = 向交互 stdin 写入 Ctrl-C(ETX)，
    // 由 ConPTY 转成 SIGINT 投递给前台进程组；运行结束仍由交互流中的 OSC 133 D 标记驱动收尾。
    // 单命令/会话模型下不再有独立运行 PTY 与 kill 看门狗（graceful / kill 同样发 Ctrl-C）。
    let session_id = get_active_terminal_run_session(&terminal_state, &payload.run_id)
        .ok_or_else(|| format!("未找到正在运行的脚本：{}", payload.run_id))?;
    let session = get_terminal_session(&terminal_state, &session_id)?
        .ok_or_else(|| "目标终端会话不存在。".to_string())?;
    session
        .handle
        .write_input("\u{0003}".to_string())
        .await
        .map_err(|error| error.to_string())
}`),
        replace: norm(String.raw`pub async fn cancel_terminal_run(
    app: AppHandle,
    state: State<'_, TerminalSessionState>,
    payload: CancelTerminalRunRequest,
) -> Result<(), String> {
    let terminal_state = state.inner().clone();
    // Shell Integration：运行即交互 shell 的前台命令。取消 = 向交互 stdin 写入 Ctrl-C(ETX)，
    // 由 PTY 行规程转成 SIGINT 投递给前台进程组；运行结束仍由交互流中的 OSC 133 D 标记驱动收尾。
    // 专业取消：首发 SIGINT 后挂一条升级监护——进程在宽限期内拒不响应（屏蔽/忽略 SIGINT）时，
    // 自动沿 Ctrl-C(SIGINT) -> 补发 Ctrl-C -> Ctrl-\(SIGQUIT) -> 强拆会话 PTY 的阶梯升级，保证
    // 取消最终一定生效、UI 不会永久卡在「取消中」。对照 VSCode 任务终止的 SIGINT/SIGTERM ->
    // SIGKILL 渐进升级思路（本模型不持有前台子进程 pid，强制手段落为强拆会话 PTY）。
    let session_id = get_active_terminal_run_session(&terminal_state, &payload.run_id)
        .ok_or_else(|| format!("未找到正在运行的脚本：{}", payload.run_id))?;
    let session = get_terminal_session(&terminal_state, &session_id)?
        .ok_or_else(|| "目标终端会话不存在。".to_string())?;
    // Step 1：立即发 Ctrl-C(SIGINT)，与真实终端按 Ctrl+C 一致——绝大多数命令到此即被中断。
    session
        .handle
        .write_input("\u{0003}".to_string())
        .await
        .map_err(|error| error.to_string())?;
    // 挂升级监护：仅当 SIGINT 未能在宽限期内令运行收尾时才逐级升级，正常路径下监护静静退出。
    spawn_cancel_escalation_watch(app, terminal_state, session_id, payload.run_id);
    Ok(())
}

/// 取消升级监护：在首发 Ctrl-C(SIGINT) 后挂一次性监护线程，逐级升级直到运行确实收尾。完成判据 =
/// 该运行被交互流的 OSC 133 D 标记经 clear_active_terminal_run 清理（get_active_terminal_run_session
/// 返回 None）。正常路径下首个 SIGINT 即令命令结束，监护在第一段宽限期内观察到运行已清理即静静
/// 退出，不发任何多余信号。仅当进程屏蔽/忽略信号时才依次升级：补发 Ctrl-C -> Ctrl-\(SIGQUIT) ->
/// 最后手段强拆该会话 PTY 并合成退出事件，保证 UI 不会永久卡在「取消中」。对照 VSCode 任务终止
/// 的 SIGINT/SIGTERM -> SIGKILL 渐进升级（本模型不持有前台子进程 pid，强制手段落为强拆会话 PTY）。
fn spawn_cancel_escalation_watch(
    app: AppHandle,
    state: TerminalSessionState,
    session_id: String,
    run_id: String,
) {
    let spawn_result = std::thread::Builder::new()
        .name(format!("wsl-cancel-escalation-{run_id}"))
        .spawn(move || {
            // 首个 SIGINT 已由 cancel_terminal_run 同步发出，这里先等它在宽限期内令运行收尾。
            if wait_until_run_cleared(&state, &run_id, CANCEL_SIGINT_GRACE) {
                return;
            }
            // 升级 1：补发 Ctrl-C(SIGINT)，捕捉「首个 INT 被提示符吞掉」或需多次中断的场景。
            // 会话已不存在（运行必已收尾 / 会话已关闭）则提前结束升级。
            if !resend_interactive_control(&state, &session_id, "\u{0003}") {
                return;
            }
            log::warn!(
                "WSL 取消：运行在首个 SIGINT 宽限期内未收尾（run_id={run_id}），补发 Ctrl-C。"
            );
            if wait_until_run_cleared(&state, &run_id, CANCEL_SIGINT_GRACE) {
                return;
            }
            // 升级 2：改发 Ctrl-\(SIGQUIT)，比 SIGINT 更难被忽略。
            if !resend_interactive_control(&state, &session_id, "\u{001C}") {
                return;
            }
            log::warn!(
                "WSL 取消：运行连续两次 SIGINT 后仍在运行（run_id={run_id}），升级发送 SIGQUIT。"
            );
            if wait_until_run_cleared(&state, &run_id, CANCEL_SIGQUIT_GRACE) {
                return;
            }
            // 最后手段：进程拒不响应信号（不可中断 / 显式屏蔽）。强拆该会话 PTY 终止整条交互 shell，
            // 合成退出事件并回收会话与运行态，保证 UI 不会永久卡在「取消中」。
            log::error!(
                "WSL 取消：运行在 SIGINT/SIGQUIT 升级后仍未收尾（run_id={run_id}, session_id={session_id}），强拆会话 PTY 作为最后手段。"
            );
            if let Ok(Some(session)) = get_terminal_session(&state, &session_id)
                && let Err(error) = terminate_terminal_session(session.as_ref())
            {
                log::warn!(
                    "WSL 取消：最后手段强拆会话 PTY 失败（session_id={session_id}）：{error}"
                );
            }
            // 回收该运行登记的临时脚本并清理会话态，再合成退出事件通知前端。
            spawn_wsl_script_cleanup(clear_active_terminal_run(&state, &run_id));
            remove_interactive_terminal_after_exit(&state, &session_id);
            emit_terminal_exit(
                &app,
                TerminalExitEvent {
                    session_id,
                    exit_code: None,
                },
            );
        });
    if let Err(error) = spawn_result {
        // 监护线程创建失败极罕见（资源耗尽）；首个 SIGINT 已发出，这里仅告警、不阻断取消。
        log::warn!("WSL 取消升级监护线程创建失败：{error}");
    }
}

/// 在 budget 内轮询等待指定运行被清理（OSC 133 D 收尾经 clear_active_terminal_run 移除活动运行）：
/// 已清理返回 true，超预算仍在运行返回 false。供取消升级监护判定「运行是否已结束、可停止升级」。
pub(super) fn wait_until_run_cleared(
    state: &TerminalSessionState,
    run_id: &str,
    budget: Duration,
) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        if get_active_terminal_run_session(state, run_id).is_none() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(CANCEL_ESCALATION_POLL);
    }
}

/// 向指定会话的交互 stdin 同步补发一个控制字符（取消升级用）。会话已不存在（运行必已收尾或会话
/// 已关闭）时返回 false，调用方据此提前结束升级；写入失败仅告警并返回 true（运行可能仍在，继续后续
/// 升级步骤）。
fn resend_interactive_control(
    state: &TerminalSessionState,
    session_id: &str,
    control: &str,
) -> bool {
    match get_terminal_session(state, session_id) {
        Ok(Some(session)) => {
            if let Err(error) = session.handle.write_input_sync(control) {
                log::warn!(
                    "WSL 取消升级写入控制字符失败（session_id={session_id}）：{error}"
                );
            }
            true
        }
        _ => false,
    }
}`),
      },
    ],
  },
  {
    rel: "src-tauri/src/commands/terminal/tests.rs",
    forbiddenAfter: [],
    edits: [
      {
        id: "use-duration",
        count: 1,
        find: norm(String.raw`use std::fs;`),
        replace: norm(String.raw`use std::fs;
use std::time::Duration;`),
      },
      {
        id: "use-wait-helper",
        count: 1,
        find: norm(String.raw`use super::events::next_terminal_data_seq;`),
        replace: norm(String.raw`use super::commands::wait_until_run_cleared;
use super::events::next_terminal_data_seq;`),
      },
      {
        id: "append-test",
        count: 1,
        find: norm(String.raw`    assert!(clear_active_terminal_run(&state, "cleanup-run").is_empty());
    assert_eq!(active_terminal_run_count(&state), 0);
}`),
        replace: norm(String.raw`    assert!(clear_active_terminal_run(&state, "cleanup-run").is_empty());
    assert_eq!(active_terminal_run_count(&state), 0);
}

#[test]
fn cancel_escalation_watch_stops_once_run_is_cleared() {
    let state = TerminalSessionState::default();
    try_mark_active_terminal_run(&state, "cancel-session", "cancel-run", Vec::new())
        .expect("active run should mark");
    // 运行仍在：取消升级监护在短预算内应判定「未清理」(false)，从而继续升级。
    assert!(!wait_until_run_cleared(
        &state,
        "cancel-run",
        Duration::from_millis(150)
    ));
    // 运行被 OSC 133 D 清理后：应立即判定「已清理」(true)，监护据此停止升级、不再多发信号。
    clear_active_terminal_run(&state, "cancel-run");
    assert!(wait_until_run_cleared(
        &state,
        "cancel-run",
        Duration::from_secs(2)
    ));
}`),
      },
    ],
  },
];

// ---- 全局原子：先校验所有文件的所有锚点与禁忌串，全部通过后才写入 ----
const planned = [];
let ok = true;
for (const f of FILES) {
  const abs = join(ROOT, f.rel);
  let original;
  try {
    original = readFileSync(abs, "utf8");
  } catch (e) {
    console.error(`✗ 读取失败 ${f.rel}: ${e.message}`);
    ok = false;
    continue;
  }
  const eol = detectEol(original);
  let body = norm(original);
  for (const e of f.edits) {
    const c = occ(body, e.find);
    if (c !== e.count) {
      console.error(`✗ [${f.rel}] 锚点 ${e.id} 命中 ${c} 次，期望 ${e.count} —— 终止。`);
      ok = false;
      break;
    }
    body = body.split(e.find).join(e.replace);
    console.log(`  · [${f.rel}] 锚点 ${e.id} 命中 1 次，已就绪。`);
  }
  for (const tok of f.forbiddenAfter ?? []) {
    if (body.includes(tok)) {
      console.error(`✗ [${f.rel}] 写入后仍残留禁忌串：${tok}`);
      ok = false;
    }
  }
  planned.push({ abs, rel: f.rel, out: restoreEol(body, eol), eol });
}

if (!ok) {
  console.error("\n✗ 校验未全部通过，未写入任何文件（全局原子）。");
  process.exit(1);
}

for (const p of planned) {
  if (WRITE) {
    writeFileSync(p.abs, p.out, "utf8");
    console.log(`✓ 已写入 ${p.rel}（EOL=${p.eol === "\r\n" ? "CRLF" : "LF"}）`);
  } else {
    console.log(`〔dry-run〕将写入 ${p.rel}（EOL=${p.eol === "\r\n" ? "CRLF" : "LF"}）`);
  }
}
console.log(WRITE ? "\n✓ 全部写入完成。" : "\n这是预演，未改动文件。确认无误后加 --write 实际写入。");
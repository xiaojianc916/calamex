#!/usr/bin/env node
// apply-p4-resize-debounce.mjs  (CRLF-safe 版)
// P4 续：resize 合批（DelayedResizer 等价）+ 扩展 trace
// 用法：仓库根目录执行  node apply-p4-resize-debounce.mjs
import { readFileSync, writeFileSync } from "node:fs";

const WSL_PTY = "src-tauri/src/terminal/wsl_pty.rs";
const COMMANDS = "src-tauri/src/commands/terminal/commands.rs";

/** @type {{file:string, find:string, replace:string, count?:number}[]} */
const edits = [
  // ---------- wsl_pty.rs ----------
  {
    file: WSL_PTY,
    find: `    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },`,
    replace: `    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },`,
  },
  {
    file: WSL_PTY,
    find: `const TERMINAL_OUTPUT_COALESCE_BYTES: usize = 32 * 1024;`,
    replace: `const TERMINAL_OUTPUT_COALESCE_BYTES: usize = 32 * 1024;

/// resize 合批静默窗口：窗口拖拽期间会高频触发 resize，逐次直接驱动 ConPTY 既浪费又可能在
/// Windows 上引发抖动 / 竞争。对照 VSCode src/vs/platform/terminal/node/terminalProcess.ts 的
/// DelayedResizer：合并一串快速 resize，仅在尺寸“安定”后把最后一次应用到底层 PTY。
const TERMINAL_RESIZE_DEBOUNCE: Duration = Duration::from_millis(50);`,
  },
  {
    file: WSL_PTY,
    find: `    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,`,
    replace: `    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// resize 合批通道发送端：所有 resize 经此投递给该会话独占的合批线程串行应用（见 spawn_resize_worker）。
    resize_tx: Sender<(u16, u16)>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,`,
  },
  {
    file: WSL_PTY,
    find: `    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), LocalWslPtyError> {
        let master = self
            .master
            .lock()
            .map_err(|_| LocalWslPtyError::Resize("终端尺寸锁已损坏。".to_string()))?;
        master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| LocalWslPtyError::Resize(error.to_string()))
    }`,
    replace: `    /// 提交一次尺寸调整。不直接驱动 ConPTY，而是投递到该会话独占的 resize 合批线程：窗口拖拽
    /// 等高频 resize 会被合并，仅在尺寸安定后把最后一次应用到底层 PTY（见 spawn_resize_worker）。
    /// 通道断开（会话已销毁）时返回错误，由命令层按尽力而为处理。
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), LocalWslPtyError> {
        self.resize_tx
            .send((cols, rows))
            .map_err(|_| LocalWslPtyError::Resize("终端尺寸合批通道已关闭。".to_string()))
    }`,
  },
  {
    file: WSL_PTY,
    find: `    Ok(LocalWslPtyHandle {
        session_id,
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
        killer: Arc::new(Mutex::new(killer)),
        finished,
        flow,
    })`,
    replace: `    let (resize_tx, resize_rx) = mpsc::channel::<(u16, u16)>();
    // 为该会话挂一条独占的 resize 合批线程，移交 MasterPty 所有权并串行化全部尺寸调整。
    spawn_resize_worker(session_id.clone(), pair.master, resize_rx);

    Ok(LocalWslPtyHandle {
        session_id,
        writer: Arc::new(Mutex::new(writer)),
        resize_tx,
        killer: Arc::new(Mutex::new(killer)),
        finished,
        flow,
    })`,
  },
  {
    file: WSL_PTY,
    find: `fn normalize_interactive_cwd(working_directory: &str) -> String {`,
    replace: `/// resize 合批工作线程：拥有该会话的 MasterPty，串行化所有 resize，并在静默窗口内合并一串快速
/// resize，仅把最后一次尺寸应用到 ConPTY。句柄及其所有克隆释放（发送端全部 drop、通道断开）后
/// 线程自动退出。对照 VSCode terminalProcess.ts 的 DelayedResizer 合并快速 resize 的思路。
fn spawn_resize_worker(
    session_id: String,
    master: Box<dyn MasterPty + Send>,
    resize_rx: Receiver<(u16, u16)>,
) {
    let spawn_result = std::thread::Builder::new()
        .name(format!("wsl-pty-resize-{session_id}"))
        .spawn(move || {
            // 阻塞等待第一条 resize；所有发送端释放后通道断开，recv 返回 Err，线程退出。
            while let Ok(mut latest) = resize_rx.recv() {
                // 合批：静默窗口内持续吸收后续 resize，只保留最后一次；窗口内无新 resize 即安定。
                loop {
                    match resize_rx.recv_timeout(TERMINAL_RESIZE_DEBOUNCE) {
                        Ok(next) => latest = next,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => {
                            apply_pty_resize(&session_id, &*master, latest);
                            return;
                        }
                    }
                }
                apply_pty_resize(&session_id, &*master, latest);
            }
        });
    if let Err(error) = spawn_result {
        // 合批线程创建失败极罕见（资源耗尽）；此时通道无接收端，后续 resize 的 send 将返回错误，
        // 由命令层按尽力而为处理，不阻断会话创建。
        log::warn!("WSL 交互终端 resize 合批线程创建失败（session_id={session_id}）：{error}");
    }
}

/// 把一次尺寸应用到底层 ConPTY；失败仅记录告警（resize 为尽力而为，不应阻断交互）。
fn apply_pty_resize(session_id: &str, master: &(dyn MasterPty + Send), size: (u16, u16)) {
    let (cols, rows) = size;
    match master.resize(PtySize {
        rows: rows.max(1),
        cols: cols.max(2),
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(()) => log::trace!(
            "WSL 交互终端尺寸已应用（session_id={session_id}, cols={cols}, rows={rows}）。"
        ),
        Err(error) => {
            log::warn!("WSL 交互终端调整尺寸失败（session_id={session_id}）：{error}")
        }
    }
}

fn normalize_interactive_cwd(working_directory: &str) -> String {`,
  },

  // ---------- commands.rs（纯日志，零行为改变）----------
  {
    file: COMMANDS,
    find: `            if payload.cwd.is_none() && should_recreate_terminal_session(existing_session.as_ref())
            {
                remove_terminal_session(&terminal_state, &payload.session_id)?;`,
    replace: `            if payload.cwd.is_none() && should_recreate_terminal_session(existing_session.as_ref())
            {
                log::debug!(
                    "既有 WSL 交互会话已不可复用，将重建（session_id={}）。",
                    payload.session_id
                );
                remove_terminal_session(&terminal_state, &payload.session_id)?;`,
  },
  {
    file: COMMANDS,
    find: `            } else {
                existing_session
                    .handle
                    .resize(payload.cols, payload.rows)
                    .map_err(|error| error.to_string())?;
                mark_terminal_resize_repaint_suppression(&terminal_state, &payload.session_id);`,
    replace: `            } else {
                log::debug!(
                    "复用既有 WSL 交互会话并同步尺寸（session_id={}, cols={}, rows={}）。",
                    payload.session_id,
                    payload.cols,
                    payload.rows
                );
                existing_session
                    .handle
                    .resize(payload.cols, payload.rows)
                    .map_err(|error| error.to_string())?;
                mark_terminal_resize_repaint_suppression(&terminal_state, &payload.session_id);`,
  },
  {
    file: COMMANDS,
    find: `        // 进入创建分支后才暴露工作目录解析错误（与改动前的 \`?\` 时机一致）。
        let terminal_cwd = pre_resolved_terminal_cwd?;`,
    replace: `        // 进入创建分支后才暴露工作目录解析错误（与改动前的 \`?\` 时机一致）。
        let terminal_cwd = pre_resolved_terminal_cwd?;
        log::debug!(
            "创建新的 WSL 交互会话（session_id={}, cwd={terminal_cwd}, cols={}, rows={}）。",
            payload.session_id,
            payload.cols,
            payload.rows
        );`,
  },
  {
    file: COMMANDS,
    find: `    mark_terminal_interactive_ready(&app);

    Ok(TerminalSessionPayload {
        session_id: payload.session_id,
        cwd: terminal_cwd,`,
    replace: `    mark_terminal_interactive_ready(&app);
    log::trace!(
        "WSL 交互会话就绪事件已发出（session_id={}, created={created}）。",
        payload.session_id
    );

    Ok(TerminalSessionPayload {
        session_id: payload.session_id,
        cwd: terminal_cwd,`,
  },
];

// ---- 应用：规一化 EOL 匹配，按原始行尾写回，逐处精确断言出现次数 ----
const byFile = new Map();
for (const e of edits) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}

let total = 0;
for (const [file, fileEdits] of byFile) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`✗ 读取失败：${file}（请在仓库根目录运行）`);
    throw err;
  }
  // 记录原始行尾；处理时统一成 LF，写回时还原。
  const usesCrlf = raw.includes("\r\n");
  let content = raw.split("\r\n").join("\n");

  for (const [i, e] of fileEdits.entries()) {
    const want = e.count ?? 1;
    const find = e.find.split("\r\n").join("\n"); // 锚点也规一化为 LF
    const parts = content.split(find);
    const got = parts.length - 1;
    if (got !== want) {
      throw new Error(
        `✗ ${file} 第 ${i + 1} 处锚点出现 ${got} 次，期望 ${want} 次。\n` +
          `  本地内容与预期(main@f8fc88c1)不一致——请先 git pull，且不要重复运行本脚本。\n` +
          `  锚点起始：${find.slice(0, 80).replace(/\n/g, "⏎")}…`
      );
    }
    content = parts.join(e.replace.split("\r\n").join("\n"));
    total++;
  }

  if (usesCrlf) content = content.split("\n").join("\r\n"); // 还原 CRLF
  writeFileSync(file, content, "utf8");
  console.log(`✓ ${file}（应用 ${fileEdits.length} 处，行尾=${usesCrlf ? "CRLF" : "LF"}）`);
}
console.log(`\n全部完成：共 ${total} 处改动。接着请：cargo build && cargo test -p calamex`);
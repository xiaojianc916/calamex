// r1-resize-worker-to-tokio.mjs
// 用法：node r1-resize-worker-to-tokio.mjs [--write]
// 作用：把每会话独占的 resize 合批 OS 线程改为跑在共享 tokio 运行时上的任务，
//       保留 50ms 合批语义，行为不变；每个终端会话少一条常驻 OS 线程。
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src-tauri/src/terminal/wsl_pty.rs";
const WRITE = process.argv.includes("--write");

const HUNKS = [
	{
		before: `use std::{
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    time::Duration,
};`,
		after: `use std::{
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};`,
	},
	{
		before: `    /// resize 合批通道发送端：所有 resize 经此投递给该会话独占的合批线程串行应用（见 spawn_resize_worker）。
    resize_tx: Sender<(u16, u16)>,`,
		after: `    /// resize 合批通道发送端：所有 resize 经此投递给该会话独占的合批任务串行应用（见 spawn_resize_worker）。
    resize_tx: UnboundedSender<(u16, u16)>,`,
	},
	{
		before: `    let (resize_tx, resize_rx) = mpsc::channel::<(u16, u16)>();
    // 为该会话挂一条独占的 resize 合批线程，移交 MasterPty 所有权并串行化全部尺寸调整。
    spawn_resize_worker(session_id.clone(), pair.master, resize_rx);`,
		after: `    let (resize_tx, resize_rx) = tokio::sync::mpsc::unbounded_channel::<(u16, u16)>();
    // 为该会话挂一条独占的 resize 合批任务（tokio 运行时，不再占用独占 OS 线程），移交 MasterPty 所有权并串行化全部尺寸调整。
    spawn_resize_worker(session_id.clone(), pair.master, resize_rx);`,
	},
	{
		before: `fn spawn_resize_worker(
    session_id: String,
    master: Box<dyn MasterPty + Send>,
    resize_rx: Receiver<(u16, u16)>,
) {
    // 把 session_id 克隆给合批线程闭包持有；原值留给下方 spawn 失败时的告警日志，
    // 避免「move 进闭包后又借用」(E0382)。
    let worker_session_id = session_id.clone();
    let spawn_result = std::thread::Builder::new()
        .name(format!("wsl-pty-resize-{session_id}"))
        .spawn(move || {
            let session_id = worker_session_id;
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
}`,
		after: `fn spawn_resize_worker(
    session_id: String,
    master: Box<dyn MasterPty + Send>,
    mut resize_rx: UnboundedReceiver<(u16, u16)>,
) {
    // 该会话独占的 resize 合批任务，跑在共享 tokio 运行时上（不再为每会话占用一条独占 OS 线程）：
    // 移交 MasterPty 所有权并串行化全部尺寸调整；静默窗口内合并一串快速 resize，仅把最后一次应用到
    // ConPTY。所有发送端释放（会话销毁、句柄全部 drop）后通道关闭，recv 返回 None，任务自然退出。
    tauri::async_runtime::spawn(async move {
        // 等待第一条 resize；通道关闭（发送端全部释放）时 recv 返回 None，任务退出。
        while let Some(mut latest) = resize_rx.recv().await {
            // 合批：静默窗口内持续吸收后续 resize，只保留最后一次；窗口内无新 resize 即安定。
            loop {
                match tokio::time::timeout(TERMINAL_RESIZE_DEBOUNCE, resize_rx.recv()).await {
                    Ok(Some(next)) => latest = next,
                    // 通道关闭：应用最后一次尺寸后退出任务。
                    Ok(None) => {
                        apply_pty_resize(&session_id, &*master, latest);
                        return;
                    }
                    // 静默窗口到期（尺寸已安定）：应用并回到外层等待下一串 resize。
                    Err(_) => break,
                }
            }
            apply_pty_resize(&session_id, &*master, latest);
        }
    });
}`,
	},
];

const raw = readFileSync(FILE, "utf8");
const isCRLF = raw.includes("\r\n");
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("resize 合批任务，跑在共享 tokio 运行时")) {
	console.log("[skip] 已应用过，幂等退出。");
	process.exit(0);
}
for (const [i, h] of HUNKS.entries()) {
	const n = src.split(h.before).length - 1;
	if (n !== 1) {
		console.error(`[abort] 第 ${i + 1} 个锚点命中 ${n} 次（需恰好 1 次），未写入任何改动。文件可能已被新 commit 改过——请对当前工作树重新核对。`);
		process.exit(1);
	}
}
for (const h of HUNKS) src = src.replace(h.before, h.after);
if (isCRLF) src = src.replace(/\n/g, "\r\n");
if (WRITE) {
	writeFileSync(FILE, src, "utf8");
	console.log("[written] wsl_pty.rs 已更新（4 处）；请跑 cd src-tauri && cargo clippy && cargo test。");
} else {
	console.log("[dry-run] 4 个锚点各命中 1 次，将把 resize 合批线程改为 tokio 任务。加 --write 落盘。");
}
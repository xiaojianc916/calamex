// r2-acp-concurrent-commands.mjs
// 用法：node r2-acp-concurrent-commands.mjs [--write]
// 作用：ACP 命令循环由「逐条 await 串行」改为「每条命令 cx.spawn 派生」，消除命令间头阻塞。
//       loop 仍在（连接保活）；Shutdown 在派生前处理（break 只能作用于本 while）。
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src-tauri/src/acp/client.rs";
const WRITE = process.argv.includes("--write");

const HUNKS = [
	{
		before: `                while let Some(command) = cmd_rx.recv().await {
                    match command {`,
		after: `                while let Some(command) = cmd_rx.recv().await {
                    // Shutdown 必须在派生任务前处理：break 只能作用于本 while 循环。
                    if matches!(command, Command::Shutdown) {
                        break;
                    }
                    // 每条命令派生到连接自身的任务（cx.spawn，SDK 认可、派发循环后台继续跑），命令循环
                    // 立刻处理下一条 → 消除命令间头阻塞；同会话依赖顺序仍由调用方 await 各自 oneshot 保证。
                    // task_cx 移入任务后重绑为 cx，下方各 match arm 主体无需改动。
                    let task_cx = cx.clone();
                    let spawn_result = cx.spawn(async move {
                        let cx = task_cx;
                        match command {`,
	},
	{
		before: `                        Command::Shutdown => break,
                    }
                }`,
		after: `                        Command::Shutdown => {}
                    }
                        Ok::<(), agent_client_protocol::Error>(())
                    });
                    if let Err(error) = spawn_result {
                        log::warn!("acp: 派生命令任务失败：{error}");
                    }
                }`,
	},
];

const raw = readFileSync(FILE, "utf8");
const isCRLF = raw.includes("\r\n");
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("let spawn_result = cx.spawn(async move {")) {
	console.log("[skip] 已应用过，幂等退出。");
	process.exit(0);
}
for (const [i, h] of HUNKS.entries()) {
	const n = src.split(h.before).length - 1;
	if (n !== 1) {
		console.error(`[abort] 第 ${i + 1} 个锚点命中 ${n} 次（需恰好 1 次），未写入任何改动。HEAD 可能已再前进——请对当前工作树重新核对。`);
		process.exit(1);
	}
}
for (const h of HUNKS) src = src.replace(h.before, h.after);
if (isCRLF) src = src.replace(/\n/g, "\r\n");
if (WRITE) {
	writeFileSync(FILE, src, "utf8");
	console.log("[written] client.rs 已更新（2 处）。请依次跑：cargo fmt（match arm 缩进需归位）→ cargo clippy → cargo test。");
} else {
	console.log("[dry-run] 2 个锚点各命中 1 次，将把命令循环改为 cx.spawn 并发派发。加 --write 落盘。");
}
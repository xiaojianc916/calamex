// fix-exit-cleanup-timeout.mjs（EOL 安全版）
// 用法：node 1.mjs [--write]
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src-tauri/src/main.rs";
const WRITE = process.argv.includes("--write");

const BEFORE = `    let lsp_manager = app_handle.state::<LspManager>();
    tauri::async_runtime::block_on(async move {
        if let Err(error) = commands::lsp_stop(lsp_manager).await {
            tracing::error!("failed to stop LSP server: {error}");
        }
        commands::shutdown_ssh_pool().await;
    });`;

const AFTER = `    let lsp_manager = app_handle.state::<LspManager>();
    tauri::async_runtime::block_on(async move {
        // 关停清理加总超时兜底：任一子系统优雅关停卡住（wsl.exe / LSP / SSH 挂起）也绝不把退出
        // 路径永久阻塞在此；超时后退回 process_guard 的 Job Object 由 OS 连带回收进程树。
        let cleanup = async move {
            if let Err(error) = commands::lsp_stop(lsp_manager).await {
                tracing::error!("failed to stop LSP server: {error}");
            }
            commands::shutdown_ssh_pool().await;
        };
        if tokio::time::timeout(std::time::Duration::from_secs(5), cleanup)
            .await
            .is_err()
        {
            tracing::warn!("exit cleanup timed out after 5s; relying on OS job-object teardown");
        }
    });`;

const raw = readFileSync(FILE, "utf8");
const isCRLF = raw.includes("\r\n");              // 记住原文件行尾
const src = raw.replace(/\r\n/g, "\n");           // 归一化到 LF 再匹配

if (src.includes("exit cleanup timed out after 5s")) {
	console.log("[skip] 已应用过，幂等退出。");
	process.exit(0);
}
const count = src.split(BEFORE).length - 1;
if (count !== 1) {
	console.error(`[abort] 锚点命中 ${count} 次（需恰好 1 次），未写入。`);
	process.exit(1);
}
let out = src.replace(BEFORE, AFTER);
if (isCRLF) out = out.replace(/\n/g, "\r\n");     // 按原行尾还原，零多余 diff
if (WRITE) {
	writeFileSync(FILE, out, "utf8");
	console.log("[written] main.rs 已更新（保持原 CRLF/LF 行尾）；请跑 cargo clippy && cargo test。");
} else {
	console.log("[dry-run] 命中锚点 1 次，将替换为带 5s 超时的清理块。加 --write 落盘。");
}
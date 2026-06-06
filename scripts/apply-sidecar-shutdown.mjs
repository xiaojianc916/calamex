#!/usr/bin/env node
// 给 src-tauri/src/agent_sidecar/mod.rs 打两处补丁：
//   #3 terminate_process 加 /T，taskkill 连子进程树一起结束
//   #1 新增 shutdown_default_sidecar()，退出时收口默认本地 sidecar
// 幂等：已改过会跳过；锚点缺失或匹配多处会报错退出，不做任何写入。
// 兼容 CRLF：按 LF 匹配，写回时保留原文件行尾风格。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(process.argv[2] ?? "src-tauri/src/agent_sidecar/mod.rs");

const TASKKILL_OLD = `.args(["/PID", &pid.to_string(), "/F"])`;
const TASKKILL_NEW = `.args(["/PID", &pid.to_string(), "/T", "/F"])`;

const RESTART_FN = `fn restart_stale_default_sidecar() -> Result<(), String> {
    let pids = find_listening_pids_for_port(DEFAULT_SIDECAR_PORT)?;
    for pid in pids {
        terminate_process(pid)?;
    }

    Ok(())
}`;

const SHUTDOWN_FN = `

/// 应用退出时调用：若默认 sidecar 运行在本地默认端口，杀掉其进程树，
/// 避免遗留 Node（及其派生的 MCP / uvx）子进程。
///
/// 仅处理「默认本地 sidecar」：通过 XIAOJIANC_AGENT_SIDECAR_URL 指向的自定义
/// 远端不归本进程生命周期管理，绝不尝试结束。所有失败仅记录到 stderr，不阻断退出。
pub fn shutdown_default_sidecar() {
    if !is_default_local_sidecar_url(&configured_base_url()) {
        return;
    }

    match find_listening_pids_for_port(DEFAULT_SIDECAR_PORT) {
        Ok(pids) => {
            for pid in pids {
                if let Err(error) = terminate_process(pid) {
                    eprintln!("退出清理：结束 sidecar 进程 {pid} 失败：{error}");
                }
            }
        }
        Err(error) => {
            eprintln!("退出清理：查询 sidecar 监听进程失败：{error}");
        }
    }
}`;

const count = (h, n) => h.split(n).length - 1;
const die = (m) => {
	console.error(`✗ ${m}`);
	process.exit(1);
};

const raw = readFileSync(FILE, "utf8");
const usesCRLF = raw.includes("\r\n");
let src = raw.replace(/\r\n/g, "\n"); // 统一按 LF 匹配
const original = src;

// ---- 补丁 #3：taskkill 加 /T ----
if (src.includes(TASKKILL_NEW)) {
	console.log("• #3 已是 /T 进程树写法，跳过。");
} else {
	const n = count(src, TASKKILL_OLD);
	if (n !== 1) die(`#3 期望锚点出现 1 次，实际 ${n} 次，已中止（文件可能已变更）。`);
	src = src.replace(TASKKILL_OLD, TASKKILL_NEW);
	console.log("• #3 已为 taskkill 加上 /T。");
}

// ---- 补丁 #1：新增 shutdown_default_sidecar() ----
if (src.includes("fn shutdown_default_sidecar(")) {
	console.log("• #1 shutdown_default_sidecar 已存在，跳过。");
} else {
	const n = count(src, RESTART_FN);
	if (n !== 1) die(`#1 期望 restart_stale_default_sidecar 锚点出现 1 次，实际 ${n} 次，已中止。`);
	src = src.replace(RESTART_FN, RESTART_FN + SHUTDOWN_FN);
	console.log("• #1 已插入 shutdown_default_sidecar()。");
}

if (src === original) {
	console.log("✓ 无需改动（两处补丁均已存在）。");
	process.exit(0);
}

// ---- 写回前自检 ----
if (!src.includes(TASKKILL_NEW)) die("自检失败：未找到 /T 写法。");
if (count(src, "fn shutdown_default_sidecar(") !== 1) die("自检失败：shutdown_default_sidecar 数量异常。");

// 保留原文件行尾风格写回（原为 CRLF 则转回 CRLF，避免整文件换行符 diff）
const out = usesCRLF ? src.replace(/\n/g, "\r\n") : src;
writeFileSync(FILE, out);
console.log(`✓ 已写入 ${FILE}（${usesCRLF ? "CRLF" : "LF"} 行尾）`);
console.log('  下一步：cargo fmt 后提交 —');
console.log('  git add -A && git commit -m "fix(sidecar): 退出时杀进程树并清理默认 sidecar，避免遗留 Node/MCP 子进程"');
console.log("  git push");
// fix-regquery-no-window.mjs
// 用法：node fix-regquery-no-window.mjs [--write]
// 作用：读取用户环境变量时经 configure_std_command_for_background 设 CREATE_NO_WINDOW，杜绝闪窗。
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src-tauri/src/acp/launch.rs";
const WRITE = process.argv.includes("--write");

// 用正则跨越含反斜杠的中间片段，避免手工转义出错；[\s\S]*? 惰性匹配到首个 .ok()?;
const RE = /let output = Command::new\("reg\.exe"\)[\s\S]*?\.ok\(\)\?;/;

const AFTER = `let mut command = Command::new("reg.exe");
    command
        .args(["query", "HKCU\\\\Environment", "/v", key])
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    // 与其它后台子进程一致设 CREATE_NO_WINDOW，避免读取用户环境变量时闪出控制台窗口。
    crate::commands::configure_std_command_for_background(&mut command);
    let output = command.output().ok()?;`;

const src = readFileSync(FILE, "utf8");
if (src.includes("configure_std_command_for_background(&mut command)")) {
	console.log("[skip] 已应用过，幂等退出。");
	process.exit(0);
}
const matches = src.match(new RegExp(RE, "g")) || [];
if (matches.length !== 1) {
	console.error(`[abort] 锚点命中 ${matches.length} 次（需恰好 1 次），未写入。`);
	process.exit(1);
}
const out = src.replace(RE, AFTER);
if (WRITE) {
	writeFileSync(FILE, out, "utf8");
	console.log("[written] launch.rs 已更新；请跑 cargo clippy && cargo test。");
} else {
	console.log("[dry-run] 命中锚点 1 次，将改为经 CREATE_NO_WINDOW 派发 reg.exe。加 --write 落盘。");
}
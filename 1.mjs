// r1-watchdogs-to-tokio.mjs
// 用法：node r1-watchdogs-to-tokio.mjs [--write]
// 作用：终端关闭/取消看门狗由独占 OS 线程 + std::thread::sleep 忙轮询，改为跑在共享 tokio
//       运行时上的任务 + tokio::time::sleep；同步 wait 助手改 async；并把依赖它的同步测试
//       迁移到 #[tokio::test]。全命中或全不写（任一文件、任一锚点计数不符即中止）。
import { readFileSync, writeFileSync } from "node:fs";

const WRITE = process.argv.includes("--write");

const COMMANDS = "src-tauri/src/commands/terminal/commands.rs";
const TESTS = "src-tauri/src/commands/terminal/tests.rs";

// 每个 hunk：{ before, after, count }（count 默认为 1；用 split/join 精确替换 count 次）
const PLAN = {
	[COMMANDS]: [
		// 关闭看门狗：线程 -> tokio 任务
		{
			before: `    let spawn_result = std::thread::Builder::new()
        .name(format!("wsl-teardown-watch-{session_id}"))
        .spawn(move || {`,
			after: `    tauri::async_runtime::spawn(async move {`,
		},
		{
			before: `            if wait_until_finished(&handle, INTERACTIVE_TEARDOWN_GRACE) {`,
			after: `            if wait_until_finished(&handle, INTERACTIVE_TEARDOWN_GRACE).await {`,
		},
		{
			before: `            if wait_until_finished(&handle, INTERACTIVE_TEARDOWN_HARD_DEADLINE) {`,
			after: `            if wait_until_finished(&handle, INTERACTIVE_TEARDOWN_HARD_DEADLINE).await {`,
		},
		{
			before: `        });
    if let Err(error) = spawn_result {
        // 看门狗线程创建失败是极罕见的资源耗尽场景；关闭本身已发出 kill，这里仅警告，
        // 不阻断关闭流程。
        log::warn!("WSL 交互终端关闭看门狗线程创建失败：{error}");
    }
}`,
			after: `    });
}`,
		},
		// 取消升级监护：线程 -> tokio 任务
		{
			before: `    let spawn_result = std::thread::Builder::new()
        .name(format!("wsl-cancel-escalation-{run_id}"))
        .spawn(move || {`,
			after: `    tauri::async_runtime::spawn(async move {`,
		},
		{
			// 两处 SIGINT 宽限等待，字符串相同 -> 精确替换 2 次
			before: `            if wait_until_run_cleared(&state, &run_id, CANCEL_SIGINT_GRACE) {`,
			after: `            if wait_until_run_cleared(&state, &run_id, CANCEL_SIGINT_GRACE).await {`,
			count: 2,
		},
		{
			before: `            if wait_until_run_cleared(&state, &run_id, CANCEL_SIGQUIT_GRACE) {`,
			after: `            if wait_until_run_cleared(&state, &run_id, CANCEL_SIGQUIT_GRACE).await {`,
		},
		{
			before: `        });
    if let Err(error) = spawn_result {
        // 监护线程创建失败极罕见（资源耗尽）；首个 SIGINT 已发出，这里仅告警、不阻断取消。
        log::warn!("WSL 取消升级监护线程创建失败：{error}");
    }
}`,
			after: `    });
}`,
		},
		// 两个 wait 助手：同步 -> async，忙轮询 -> tokio::time::sleep
		{
			before: `fn wait_until_finished(handle: &LocalWslPtyHandle, budget: Duration) -> bool {`,
			after: `async fn wait_until_finished(handle: &LocalWslPtyHandle, budget: Duration) -> bool {`,
		},
		{
			before: `        std::thread::sleep(TEARDOWN_WATCH_POLL);`,
			after: `        tokio::time::sleep(TEARDOWN_WATCH_POLL).await;`,
		},
		{
			before: `pub(super) fn wait_until_run_cleared(`,
			after: `pub(super) async fn wait_until_run_cleared(`,
		},
		{
			before: `        std::thread::sleep(CANCEL_ESCALATION_POLL);`,
			after: `        tokio::time::sleep(CANCEL_ESCALATION_POLL).await;`,
		},
	],
	[TESTS]: [
		{
			before: `#[test]
fn cancel_escalation_watch_stops_once_run_is_cleared() {`,
			after: `#[tokio::test]
async fn cancel_escalation_watch_stops_once_run_is_cleared() {`,
		},
		{
			before: `    assert!(!wait_until_run_cleared(
        &state,
        "cancel-run",
        Duration::from_millis(150)
    ));`,
			after: `    assert!(!wait_until_run_cleared(&state, "cancel-run", Duration::from_millis(150)).await);`,
		},
		{
			before: `    assert!(wait_until_run_cleared(
        &state,
        "cancel-run",
        Duration::from_secs(2)
    ));`,
			after: `    assert!(wait_until_run_cleared(&state, "cancel-run", Duration::from_secs(2)).await);`,
		},
	],
};

// 读入所有文件、记住行尾、归一化到 LF
const files = {};
for (const path of Object.keys(PLAN)) {
	const raw = readFileSync(path, "utf8");
	files[path] = { raw, isCRLF: raw.includes("\r\n"), src: raw.replace(/\r\n/g, "\n") };
}

// 幂等：两文件的关键标记都已存在即跳过
if (
	files[COMMANDS].src.includes("async fn wait_until_finished") &&
	files[TESTS].src.includes("async fn cancel_escalation_watch_stops_once_run_is_cleared")
) {
	console.log("[skip] 已应用过，幂等退出。");
	process.exit(0);
}

// 先全量核对锚点计数（任一不符 -> 全不写）
const errors = [];
for (const [path, hunks] of Object.entries(PLAN)) {
	const src = files[path].src;
	hunks.forEach((h, i) => {
		const want = h.count ?? 1;
		const got = src.split(h.before).length - 1;
		if (got !== want) errors.push(`${path} 第 ${i + 1} 个锚点命中 ${got} 次（需 ${want} 次）`);
	});
}
if (errors.length) {
	console.error("[abort] 锚点核对失败，未写入任何文件：\n  - " + errors.join("\n  - "));
	console.error("（HEAD 可能又前进了，或本地有未提交改动——请对当前工作树核对。）");
	process.exit(1);
}

// 全部命中：应用并按原行尾写回
for (const [path, hunks] of Object.entries(PLAN)) {
	let src = files[path].src;
	for (const h of hunks) src = src.split(h.before).join(h.after);
	if (files[path].isCRLF) src = src.replace(/\n/g, "\r\n");
	files[path].out = src;
}
if (WRITE) {
	for (const path of Object.keys(PLAN)) writeFileSync(path, files[path].out, "utf8");
	console.log("[written] commands.rs + tests.rs 已更新。请依次跑：cargo fmt → cargo clippy → cargo test。");
} else {
	console.log("[dry-run] 所有锚点计数匹配（commands.rs 12 处含 SIGINT×2、tests.rs 3 处）。加 --write 落盘。");
}
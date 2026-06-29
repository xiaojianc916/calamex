// fix-git-tests.mjs  —— 收尾:把 tests.rs 里旧的 short_commit_id 测试改写到新函数
// 用法（仓库根目录）：node 3.mjs   或   node 3.mjs "D:\com.xiaojianc\my_desktop_app"
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const G = "src-tauri/src/commands";

function patch(relPath, edits) {
	const file = join(root, relPath);
	if (!existsSync(file)) throw new Error(`找不到文件：${file}`);
	let src = readFileSync(file, "utf8");
	const eol = src.includes("\r\n") ? "\r\n" : "\n";
	const toEol = (s) => s.split("\n").join(eol);
	for (const { find, replace, count = 1 } of edits) {
		const f = toEol(find);
		const r = toEol(replace);
		const hits = src.split(f).length - 1;
		if (hits !== count) {
			throw new Error(
				`[中止] ${relPath} 锚点命中 ${hits} 次（期望 ${count}）。文件可能已改动，请贴出最新内容。\n锚点首行：${find.split("\n")[0]}`,
			);
		}
		src = src.split(f).join(r);
	}
	writeFileSync(file, src, "utf8");
	console.log(`✓ ${relPath}（${edits.length} 处）`);
}

patch(`${G}/git/tests.rs`, [
	{
		find: `#[test]
fn short_commit_id_truncates_to_seven_hex_chars() {
    // 钉住 short_commit_id 依赖的 \`{:.7}\` 截断行为：避免 gix ObjectId 的 Display
    // 实现变更后短 OID 长度悄悄改变而无人察觉。
    let id = gix::ObjectId::from_hex(b"1234567890abcdef1234567890abcdef12345678")
        .expect("valid sha1 hex");
    assert_eq!(short_commit_id(id), "1234567");
}`,
		replace: `#[test]
fn short_commit_oid_falls_back_to_seven_hex_chars_for_unknown_object() {
    // 钉住 short_commit_oid 的回退路径：当对象不在仓库中（无法消歧义解析）时回退到
    // 固定 7 字符截断，避免 gix ObjectId 的 Display 实现变更后短 OID 长度悄悄改变而无人察觉。
    let temp = TempGitDir::new("short-oid-fallback").expect("temp dir");
    let repo = temp.init_repository().expect("init repo");
    let id = gix::ObjectId::from_hex(b"1234567890abcdef1234567890abcdef12345678")
        .expect("valid sha1 hex");
    assert_eq!(short_commit_oid(&repo, id), "1234567");
}`,
	},
]);

// 收尾自检：确认全工程已无旧的 short_commit_id( 引用
const scanFiles = [
	"git.rs", "git/branches.rs", "git/diff.rs", "git/history.rs",
	"git/revision.rs", "git/status.rs", "git/stash.rs", "git/worktree_io.rs", "git/tests.rs",
].map((f) => `${G}/${f}`);
const residual = scanFiles.filter(
	(rel) => existsSync(join(root, rel)) && readFileSync(join(root, rel), "utf8").includes("short_commit_id("),
);
if (residual.length) {
	throw new Error(`[警告] 仍有文件引用旧的 short_commit_id(）：${residual.join(", ")}`);
}
console.log("\n全部完成。请运行：cargo build && cargo test（重点跑 git 相关用例）。");
// fix-git-tests2.mjs —— 收尾(稳健版):tests.rs 旧 short_commit_id 测试迁移到 short_commit_oid
// 用法（仓库根目录）：node 4.mjs   或   node 4.mjs "D:\com.xiaojianc\my_desktop_app"
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const G = "src-tauri/src/commands";
const rel = `${G}/git/tests.rs`;
const file = join(root, rel);
if (!existsSync(file)) throw new Error(`找不到文件：${file}`);

let src = readFileSync(file, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";
const toEol = (s) => s.split("\n").join(eol);

// 必做：注入临时仓库 + 改调用为 short_commit_oid(&repo, id)。锚点只取注释下方两行，规避注释差异。
{
	const find = toEol(`    let id = gix::ObjectId::from_hex(b"1234567890abcdef1234567890abcdef12345678")
        .expect("valid sha1 hex");
    assert_eq!(short_commit_id(id), "1234567");`);
	const replace = toEol(`    let temp = TempGitDir::new("short-oid-fallback").expect("temp dir");
    let repo = temp.init_repository().expect("init repo");
    let id = gix::ObjectId::from_hex(b"1234567890abcdef1234567890abcdef12345678")
        .expect("valid sha1 hex");
    assert_eq!(short_commit_oid(&repo, id), "1234567");`);
	const hits = src.split(find).length - 1;
	if (hits !== 1) {
		throw new Error(
			`[中止] ${rel} 必做锚点命中 ${hits} 次（期望 1）。请把 tests.rs 里 short_commit_id 那个测试函数的当前内容贴给我。`,
		);
	}
	src = src.split(find).join(replace);
	console.log("✓ 已注入临时仓库并改用 short_commit_oid(&repo, id)");
}

// 尽力而为：重命名测试函数（命不中只提示，不影响编译）
{
	const find = `fn short_commit_id_truncates_to_seven_hex_chars()`;
	const replace = `fn short_commit_oid_falls_back_to_seven_hex_chars_for_unknown_object()`;
	const hits = src.split(find).length - 1;
	if (hits === 1) {
		src = src.split(find).join(replace);
		console.log("✓ 已重命名测试函数");
	} else {
		console.log(`· 跳过函数重命名（命中 ${hits} 次，本地命名可能不同；不影响编译）`);
	}
}

// 尽力而为：修订过时注释（多种已知措辞都试一遍，命不中就略过）
{
	const candidates = [
		`    // 钉住 short_commit_id 依赖的 \`{:.7}\` 截断行为：避免 gix ObjectId 的 Display
    // 实现变更后短 OID 长度悄悄改变而无人察觉。`,
	];
	const newComment = `    // 钉住 short_commit_oid 的回退路径：当对象不在仓库中（无法消歧义解析）时回退到
    // 固定 7 字符截断，避免 gix ObjectId 的 Display 实现变更后短 OID 长度悄悄改变而无人察觉。`;
	let done = false;
	for (const c of candidates) {
		const f = toEol(c);
		if (src.split(f).length - 1 === 1) {
			src = src.split(f).join(toEol(newComment));
			done = true;
			break;
		}
	}
	console.log(done ? "✓ 已修订过时注释" : "· 跳过注释修订（本地措辞不同；注释无害，可稍后手动改）");
}

writeFileSync(file, src, "utf8");

// 收尾自检
const scanFiles = [
	"git.rs", "git/branches.rs", "git/diff.rs", "git/history.rs",
	"git/revision.rs", "git/status.rs", "git/stash.rs", "git/worktree_io.rs", "git/tests.rs",
].map((f) => `${G}/${f}`);
const residual = scanFiles.filter(
	(p) => existsSync(join(root, p)) && readFileSync(join(root, p), "utf8").includes("short_commit_id("),
);
if (residual.length) {
	throw new Error(`[警告] 仍有文件引用旧的 short_commit_id(）：${residual.join(", ")}`);
}
console.log("\n全部完成。请运行：cargo build && cargo test（重点跑 git 相关用例）。");
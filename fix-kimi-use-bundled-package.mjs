// fix-kimi-use-bundled-package.mjs
// 让 Kimi 后端使用工程内置的 @moonshot-ai/kimi-code(node <绝对入口> acp),
// 并替换「去终端登录」的用户文案。保存到工程根后: node fix-kimi-use-bundled-package.mjs
import { readFileSync, writeFileSync } from "node:fs";

/**
 * @param {string} file
 * @param {(text:string)=>boolean} skipIf  返回 true 则整文件跳过(幂等)
 * @param {Array<{find:string, replace:string, key:string, optional?:boolean}>} edits
 *   optional=true: 未命中(0 次)时跳过且不报错; 命中多次仍报错。
 */
function patchFile(file, skipIf, edits) {
	const original = readFileSync(file, "utf8");
	if (skipIf(original)) {
		console.log(`SKIP  ${file} (already patched)`);
		return;
	}
	const isCRLF = original.includes("\r\n");
	let text = isCRLF ? original.replaceAll("\r\n", "\n") : original;

	for (const { find, replace, key, optional } of edits) {
		const count = text.split(find).length - 1;
		if (count === 1) {
			text = text.split(find).join(replace);
			continue;
		}
		if (optional && count === 0) {
			console.warn(`  - optional edit not found, skipped: ${key}`);
			continue;
		}
		const idx = text.indexOf(find);
		const ctx =
			idx >= 0
				? text.slice(Math.max(0, idx - 220), idx + find.length + 220)
				: "(no match)";
		throw new Error(
			`Edit "${key}" in ${file} matched ${count} times (want 1).\n--- context ---\n${ctx}\n--- find ---\n${find}`,
		);
	}

	const out = isCRLF ? text.replaceAll("\n", "\r\n") : text;
	writeFileSync(file, out, "utf8");
	console.log(`OK    ${file}`);
}

const j = (lines) => lines.join("\n");

// ---------------------------------------------------------------------------
// 1) src-tauri/src/acp/launch.rs
// ---------------------------------------------------------------------------
const LAUNCH = "src-tauri/src/acp/launch.rs";

const kimiFnFind = j([
	"fn build_kimi_client_config() -> AcpClientConfig {",
	'    let program = env_or_user_env(KIMI_EXE_ENV).unwrap_or_else(|| "kimi".to_string());',
	"    AcpClientConfig {",
	"        program,",
	'        args: vec!["acp".to_string()],',
	"        env: Vec::new(),",
	"    }",
	"}",
]);

const kimiFnReplace = j([
	"fn build_kimi_client_config() -> AcpClientConfig {",
	"    // 1) 绝对路径覆盖优先:随包/非 PATH 安装的逃生舱,直接作为 program 执行 <exe> acp。",
	"    if let Some(program) = env_or_user_env(KIMI_EXE_ENV) {",
	"        return AcpClientConfig {",
	"            program,",
	'            args: vec!["acp".to_string()],',
	"            env: Vec::new(),",
	"        };",
	"    }",
	"",
	"    // 2) 工程内置 npm 包(@moonshot-ai/kimi-code):以 node <绝对入口> acp 运行,",
	"    //    Windows 正确,绕开 node_modules/.bin/kimi shim 的 ENOENT。",
	"    if let Some(config) = resolve_bundled_kimi_client_config() {",
	"        return config;",
	"    }",
	"",
	"    // 3) 兜底:回退裸 kimi(系统 PATH);仅在既无 env 覆盖也未找到内置包时使用。",
	"    AcpClientConfig {",
	'        program: "kimi".to_string(),',
	'        args: vec!["acp".to_string()],',
	"        env: Vec::new(),",
	"    }",
	"}",
	"",
	"/// 解析「工程内置」Kimi Code(@moonshot-ai/kimi-code,经 pnpm add -D 装入工程根 node_modules)",
	"/// 的启动配置:node <绝对入口> acp。形态为 npm 包(JS CLI),以 node 直接运行绝对入口脚本——",
	"/// 绝对入口绕开 Windows 上 node_modules/.bin/kimi.CMD shim 的 ENOENT(GUI 进程不继承终端",
	"/// PATH)。node 解析复用 builtin 的 resolve_node_executable(随包 node 优先,再常见安装位置,",
	"/// 最后 PATH)。任一步缺失则返回 None,交由上层兜底。",
	"fn resolve_bundled_kimi_client_config() -> Option<AcpClientConfig> {",
	"    let node = resolve_node_executable().ok()?;",
	"    let package_dir = find_kimi_package_dir()?;",
	'    let entry = resolve_package_bin_entry(&package_dir, "kimi")?;',
	"",
	"    Some(AcpClientConfig {",
	"        program: path_to_string(&node),",
	'        args: vec![path_to_string(&entry), "acp".to_string()],',
	"        env: Vec::new(),",
	"    })",
	"}",
	"",
	"/// 在候选根的 node_modules/@moonshot-ai/kimi-code 下定位含 package.json 的包目录。",
	"/// 候选根:随包资源根(打包态)在前,仓库工作区根(开发态,pnpm add -D 落此处的 node_modules)",
	"/// 兜底——与 sidecar/node 的「随包优先,源码树兜底」解析策略一致。",
	"fn find_kimi_package_dir() -> Option<PathBuf> {",
	"    for root in kimi_package_search_roots() {",
	"        let package_dir = root",
	'            .join("node_modules")',
	'            .join("@moonshot-ai")',
	'            .join("kimi-code");',
	'        if package_dir.join("package.json").is_file() {',
	"            return Some(package_dir);",
	"        }",
	"    }",
	"    None",
	"}",
	"",
	"/// 内置 Kimi 包的候选搜索根:随包资源根(打包态)在前,仓库工作区根(开发态)兜底。",
	"fn kimi_package_search_roots() -> Vec<PathBuf> {",
	"    let mut roots: Vec<PathBuf> = Vec::new();",
	"    for root in crate::commands::shell_tools::bundled_resource_roots() {",
	"        roots.push(root.to_path_buf());",
	"    }",
	'    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));',
	"    if let Some(workspace_root) = manifest_dir.parent() {",
	"        roots.push(workspace_root.to_path_buf());",
	"    }",
	"    roots",
	"}",
	"",
	"/// 从包 package.json 的 bin 字段解析指定命令的入口脚本绝对路径。bin 可为字符串(单一入口)",
	"/// 或对象(优先 bin_name,否则取首个值);入口相对包目录解析。字段缺失或入口文件不存在时",
	"/// 返回 None。",
	"fn resolve_package_bin_entry(package_dir: &Path, bin_name: &str) -> Option<PathBuf> {",
	'    let manifest = fs::read_to_string(package_dir.join("package.json")).ok()?;',
	"    let value: serde_json::Value = serde_json::from_str(&manifest).ok()?;",
	'    let relative = match value.get("bin")? {',
	"        serde_json::Value::String(path) => path.clone(),",
	"        serde_json::Value::Object(map) => map",
	"            .get(bin_name)",
	"            .or_else(|| map.values().next())",
	"            .and_then(|entry| entry.as_str())",
	"            .map(|entry| entry.to_string())?,",
	"        _ => return None,",
	"    };",
	"",
	"    let entry = package_dir.join(relative);",
	"    entry.is_file().then_some(entry)",
	"}",
]);

patchFile(
	LAUNCH,
	(t) => t.includes("resolve_bundled_kimi_client_config"),
	[
		{ key: "launch:kimi-fn", find: kimiFnFind, replace: kimiFnReplace },
		// 文档注释清理(命中即换,未命中跳过,不影响功能)
		{
			key: "launch:doc-login",
			optional: true,
			find: "/// 鉴权由 Kimi CLI 自身负责(需先在终端 `kimi` 内 `/login`),故此处不注入模型 env。",
			replace:
				"/// 鉴权由 Kimi CLI 自身负责(凭据落 ~/.kimi,登录由其自身流程处理),故此处不注入模型 env。",
		},
		{
			key: "launch:doc-exe",
			optional: true,
			find: "/// 可执行名默认 `kimi`,可经 `XIAOJIANC_KIMI_EXE` 覆盖为绝对路径(便于随包/非 PATH 安装)。",
			replace:
				"/// 优先工程内置包 @moonshot-ai/kimi-code(node <绝对入口> acp),否则回退 kimi acp;可经 XIAOJIANC_KIMI_EXE 覆盖为绝对路径。",
		},
		{
			key: "launch:enum-doc",
			optional: true,
			find: "    /// Kimi Code(Kimi CLI):`kimi acp`,原生 ACP;需先在终端 `kimi` 内 `/login`。",
			replace:
				"    /// Kimi Code(@moonshot-ai/kimi-code):原生 ACP;优先工程内置包(node <入口> acp),否则回退裸 kimi acp;可经 XIAOJIANC_KIMI_EXE 覆盖为绝对路径。",
		},
		// 测试:三态下末位参数恒为 acp(开发机已装内置包时 args 不再等于 ["acp"])
		{
			key: "launch:test-args-1",
			find: 'assert_eq!(config.args, vec!["acp".to_string()]);',
			replace:
				'assert_eq!(config.args.last().map(String::as_str), Some("acp"));',
		},
		{
			key: "launch:test-args-2",
			find: 'assert_eq!(kimi.args, vec!["acp".to_string()]);',
			replace:
				'assert_eq!(kimi.args.last().map(String::as_str), Some("acp"));',
		},
		{
			key: "launch:test-comment-1",
			optional: true,
			find: "        // Kimi Code 原生 ACP:固定 `kimi acp`(可执行名可经 env 覆盖,但始终非空)。",
			replace:
				"        // Kimi Code 末位参数恒为 acp:env 覆盖 / 内置包(node <入口> acp)/ PATH 兜底三态统一,program 非空。",
		},
		{
			key: "launch:test-comment-2",
			optional: true,
			find: "        // 后端调度:Kimi/Codex 均不依赖 node/边车解析,故总能产出配置。",
			replace:
				"        // 后端调度:Kimi 末位参数恒为 acp(三态统一),Codex 无位置参数,两者均能产出配置。",
		},
	],
);

// ---------------------------------------------------------------------------
// 2) src-tauri/src/commands/agent_sidecar.rs —— 替换「去终端登录」的用户文案
// ---------------------------------------------------------------------------
const SIDECAR = "src-tauri/src/commands/agent_sidecar.rs";

patchFile(
	SIDECAR,
	(t) => t.includes("连接已断开或未能启动"),
	[
		{
			key: "sidecar:user-message",
			find: '"{} 外部 agent 进程未在运行（可能尚未启动或未登录）。请先在终端启动该 agent 并完成登录（Kimi：先运行 kimi，再在其中执行 /login），然后重试。"',
			replace:
				'"{} agent 连接已断开或未能启动（可能正在初始化、首次需登录授权，或工程内置依赖未就绪）。请稍后重试。"',
		},
		{
			key: "sidecar:doc-1",
			optional: true,
			find: "进程未运行或未就绪（最常见是 Kimi 尚未在终端 kimi 内执行 /login）",
			replace: "子进程启动/初始化失败或连接断开（如首次需登录授权、工程内置依赖缺失）",
		},
		{
			key: "sidecar:doc-2",
			optional: true,
			find: "如 Kimi 需先在终端 `kimi` 内 `/login`",
			replace: "如 Kimi 凭据落 ~/.kimi，登录由其自身流程处理",
		},
	],
);

console.log("\nDone.");
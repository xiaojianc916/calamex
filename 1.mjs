// patch-kimi-home.mjs  (v2: 兼容 CRLF/LF + 失败诊断)
// 让 calamex 接管 Kimi 配置目录(经 KIMI_HOME 指向 ~/.calamex/kimi-home)，
// 使 seed 写入路径与 `kimi acp` 子进程读取路径恒一致，修复 Authentication required。
// 用法: node 1.mjs            (默认改 src-tauri/src/acp/launch.rs)
//       node 1.mjs <文件路径>
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(process.argv[2] ?? "src-tauri/src/acp/launch.rs");
const raw = readFileSync(target, "utf8");

// 关键修复：本地多半是 CRLF，匹配前统一成 LF，写回时再还原。
const usedCrlf = raw.includes("\r\n");
let src = raw.replace(/\r\n/g, "\n");

// 幂等:已打过补丁则跳过。
if (src.includes("KIMI_MANAGED_HOME_DIR")) {
  console.log("⏭  已包含 KIMI_MANAGED_HOME_DIR，文件似乎已打过补丁，跳过(幂等)。");
  process.exit(0);
}

function dumpContext(text, find, name) {
  const anchor = find.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const idx = anchor ? text.indexOf(anchor) : -1;
  if (idx === -1) {
    console.error(`   (诊断)[${name}] 连锚点行也未找到: ${JSON.stringify(anchor)}`);
    return;
  }
  const start = Math.max(0, idx - 240);
  const end = Math.min(text.length, idx + 400);
  console.error(`   (诊断)[${name}] 文件该处真实内容(可见空白)：`);
  console.error("   " + JSON.stringify(text.slice(start, end)));
}

function applyOnce(text, find, replace, name) {
  const parts = text.split(find);
  if (parts.length === 1) {
    dumpContext(text, find, name);
    throw new Error(
      `[${name}] 未找到目标片段；已中止且未写入。请把上面(诊断)那行内容发我。`
    );
  }
  if (parts.length > 2) {
    throw new Error(
      `[${name}] 目标片段出现 ${parts.length - 1} 次(预期唯一)，已中止且未写入。`
    );
  }
  return parts.join(replace);
}

const edits = [
  {
    name: "1/6 新增 KIMI_HOME_ENV / KIMI_MANAGED_HOME_DIR 常量",
    find: `const KIMI_DEFAULT_BASE_URL: &str = "https://api.moonshot.ai/v1";`,
    replace: `const KIMI_DEFAULT_BASE_URL: &str = "https://api.moonshot.ai/v1";

// calamex 托管 Kimi 配置目录：经 KIMI_HOME 环境变量把 kimi acp 子进程的配置目录指向本程序
// 自管目录(品牌存储根下 kimi-home)，使 seed 写入与子进程读取恒为同一份，避免被用户既有的
// 全局 ~/.kimi/config.toml 截断(详见 resolved_kimi_home / kimi_child_env)。
const KIMI_HOME_ENV: &str = "KIMI_HOME";
const KIMI_MANAGED_HOME_DIR: &str = "kimi-home";`,
  },
  {
    name: "2/6 build_kimi_client_config：env 覆盖分支注入 KIMI_HOME",
    find: `            program,
            args: vec!["acp".to_string()],
            env: Vec::new(),
        };`,
    replace: `            program,
            args: vec!["acp".to_string()],
            env: kimi_child_env(),
        };`,
  },
  {
    name: "3/6 build_kimi_client_config：PATH 兜底分支注入 KIMI_HOME",
    find: `        program: "kimi".to_string(),
        args: vec!["acp".to_string()],
        env: Vec::new(),
    }`,
    replace: `        program: "kimi".to_string(),
        args: vec!["acp".to_string()],
        env: kimi_child_env(),
    }`,
  },
  {
    name: "4/6 resolve_bundled_kimi_client_config：内置包分支注入 KIMI_HOME",
    find: `        args: vec![path_to_string(&entry), "acp".to_string()],
        env: Vec::new(),
    })`,
    replace: `        args: vec![path_to_string(&entry), "acp".to_string()],
        env: kimi_child_env(),
    })`,
  },
  {
    name: "5/6 重写 kimi_home_dir 为托管目录解析(resolved/managed/child_env)",
    find: `/// 解析 \`~/.kimi\` 目录：优先 \`KIMI_HOME\`，否则用户主目录下 \`.kimi\`。
fn kimi_home_dir() -> Option<PathBuf> {
    if let Some(custom) = env_or_user_env("KIMI_HOME") {
        return Some(PathBuf::from(custom));
    }
    #[cfg(windows)]
    let home = env_or_user_env("USERPROFILE");
    #[cfg(not(windows))]
    let home = env_or_user_env("HOME");
    home.map(|value| PathBuf::from(value).join(".kimi"))
}`,
    replace: `/// 解析「calamex 托管」的 Kimi 配置目录。优先外部显式 KIMI_HOME(逃生舱：用户/CI 可强制
/// 指向自管目录)，否则用 calamex 自管目录(品牌存储根下 kimi-home，如 ~/.calamex/kimi-home)。
/// 不再回退全局 ~/.kimi——避免被用户既有的、非本程序托管的全局 config.toml 截断
/// (那会导致 seed 跳过、kimi acp 子进程无凭证而报 Authentication required)。
fn resolved_kimi_home() -> PathBuf {
    if let Some(custom) = env_or_user_env(KIMI_HOME_ENV) {
        return PathBuf::from(custom);
    }
    managed_kimi_home()
}

/// calamex 自管的 Kimi home：品牌存储根下 kimi-home(如 ~/.calamex/kimi-home)。
/// 与 storage_paths::local_root() 同源，保证 seed 写入路径与子进程读取路径恒一致。
fn managed_kimi_home() -> PathBuf {
    crate::storage_paths::local_root().join(KIMI_MANAGED_HOME_DIR)
}

/// 拉起 kimi acp 子进程时注入的 env：把 KIMI_HOME 指向 calamex 托管目录，
/// 使子进程读取的 config.toml 与 ensure_kimi_managed_config 写入的恒为同一份。
fn kimi_child_env() -> Vec<(String, String)> {
    vec![(
        KIMI_HOME_ENV.to_string(),
        path_to_string(&resolved_kimi_home()),
    )]
}

/// 解析 Kimi 配置目录(供 seed 写入)。委托 resolved_kimi_home，恒返回 Some，
/// 与子进程注入的 KIMI_HOME 指向同一目录。
fn kimi_home_dir() -> Option<PathBuf> {
    Some(resolved_kimi_home())
}`,
  },
  {
    name: "6/6 新增单测 kimi_child_env_injects_managed_kimi_home",
    find: `        let config = build_kimi_client_config();
        assert_eq!(config.args.last().map(String::as_str), Some("acp"));
        assert!(!config.program.trim().is_empty());
    }`,
    replace: `        let config = build_kimi_client_config();
        assert_eq!(config.args.last().map(String::as_str), Some("acp"));
        assert!(!config.program.trim().is_empty());
    }

    #[test]
    fn kimi_child_env_injects_managed_kimi_home() {
        // 子进程 env 注入 KIMI_HOME，指向 calamex 托管目录(resolved_kimi_home)，
        // 保证 seed 写入与子进程读取路径一致；该 env 恰含一项且非空。
        let env = kimi_child_env();
        assert_eq!(env.len(), 1);
        let (key, value) = &env[0];
        assert_eq!(key, KIMI_HOME_ENV);
        assert_eq!(value, &path_to_string(&resolved_kimi_home()));
        assert!(!value.trim().is_empty());
    }`,
  },
];

try {
  for (const e of edits) {
    src = applyOnce(src, e.find, e.replace, e.name);
    console.log(`✓ ${e.name}`);
  }
  // 还原原始行尾再写回(CRLF 项目保持 CRLF)。
  const out = usedCrlf ? src.replace(/\n/g, "\r\n") : src;
  writeFileSync(target, out, "utf8");
  console.log(`\n✅ 已写入 ${target}（行尾：${usedCrlf ? "CRLF" : "LF"}）`);
  console.log("下一步：cd src-tauri && cargo clippy --all-targets && cargo test");
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}
// fix-build2.cjs
// 运行: node fix-build2.cjs
// 特点: CRLF/LF 通吃(正则按 \r?\n 匹配换行); 每处锚点必须唯一匹配; 幂等(已改过自动跳过)
const fs = require("fs");

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function multilineRegex(lines) {
  return new RegExp(lines.map(escapeRegex).join("\\r?\\n"), "g");
}

const edits = [
  {
    file: "src-tauri/src/storage_paths.rs",
    replacements: [
      // 1) 生命周期
      { old: ["    fn lookup("], new: ["    fn lookup<'a>("] },
      {
        old: ["        map: &HashMap<&'static str, &'static str>,"],
        new: ["        map: &'a HashMap<&'static str, &'static str>,"],
      },
      {
        old: ["    ) -> impl Fn(&str) -> Option<OsString> + '_ {"],
        new: ["    ) -> impl Fn(&str) -> Option<OsString> + 'a {"],
      },
      // 2) collapsible_if (migrate_path) —— 整块替换并正确去缩进
      {
        old: [
          "    if let Some(parent) = to.parent() {",
          "        if let Err(error) = fs::create_dir_all(parent) {",
          '            log_migration_warn("create-parent-failed", to, &error.to_string());',
          "            return;",
          "        }",
          "    }",
        ],
        new: [
          "    if let Some(parent) = to.parent()",
          "        && let Err(error) = fs::create_dir_all(parent)",
          "    {",
          '        log_migration_warn("create-parent-failed", to, &error.to_string());',
          "        return;",
          "    }",
        ],
      },
    ],
  },
  {
    file: "src-tauri/src/commands/skills.rs",
    replacements: [
      // 3) 未用导入
      { old: ["    time::{SystemTime, UNIX_EPOCH},"], new: ["    time::UNIX_EPOCH,"] },
      // 4) unnecessary_sort_by
      {
        old: ["    skills.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));"],
        new: ["    skills.sort_by_key(|left| left.name.to_lowercase());"],
      },
      // 5a) collapsible_if (parse_skill_document) 开头
      {
        old: [
          '    if let Some(rest) = normalized.strip_prefix("---\\n") {',
          '        if let Some(end) = rest.find("\\n---") {',
        ],
        new: [
          '    if let Some(rest) = normalized.strip_prefix("---\\n")',
          '        && let Some(end) = rest.find("\\n---")',
          "    {",
        ],
      },
      // 5b) 对应的收尾大括号(去掉多出来的一层)
      {
        old: ["            };", "        }", "    }", "    ParsedSkill {"],
        new: ["            };", "    }", "    ParsedSkill {"],
      },
    ],
  },
  {
    file: "src-tauri/src/agent_sidecar/mod.rs",
    replacements: [
      // 6) 测试模块补 OnceLock / Duration 导入
      {
        old: ["    use std::fs;", "    use std::process::Command;"],
        new: [
          "    use std::fs;",
          "    use std::process::Command;",
          "    use std::sync::OnceLock;",
          "    use std::time::Duration;",
        ],
      },
    ],
  },
];

let totalApplied = 0;
let failed = false;

for (const { file, replacements } of edits) {
  if (!fs.existsSync(file)) {
    console.error(`[SKIP] file not found: ${file}`);
    failed = true;
    continue;
  }
  let content = fs.readFileSync(file, "utf8");
  const eol = detectEol(content);
  let fileApplied = 0;

  replacements.forEach((rep, i) => {
    const tag = `${file} #${i + 1}`;
    const newJoined = rep.new.join(eol);

    if (content.includes(newJoined)) {
      console.log(`[SKIP] ${tag}: already applied`);
      return;
    }
    const re = multilineRegex(rep.old);
    const matches = content.match(re);
    const count = matches ? matches.length : 0;
    if (count !== 1) {
      console.error(`[FAIL] ${tag}: expected exactly 1 match but found ${count}. No change made.`);
      failed = true;
      return;
    }
    content = content.replace(re, () => newJoined); // 函数式替换, 避免 $ 被当作特殊符号
    fileApplied++;
    totalApplied++;
    console.log(`[OK]   ${tag}: applied (eol=${eol === "\r\n" ? "CRLF" : "LF"})`);
  });

  if (fileApplied > 0) {
    fs.writeFileSync(file, content, "utf8");
    console.log(`[WRITE] ${file}: ${fileApplied} change(s) saved`);
  }
}

console.log("------------------------------------------");
console.log(`Total changes applied: ${totalApplied}`);
if (failed) {
  console.error("Some edits FAILED. Review messages above; nothing partial was forced.");
  process.exit(1);
} else {
  console.log("All done. Next, verify inside src-tauri:");
  console.log("  cargo test --no-run");
  console.log("  cargo clippy --all-targets -- -D warnings");
}
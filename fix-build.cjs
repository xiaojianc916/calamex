// fix-build.js
// 运行: 在项目根目录执行  node fix-build.js
// 规则: 每个锚点必须唯一匹配(count===1)才替换; 否则报错且不改动; 可重复运行(已改过会跳过)
const fs = require("fs");

function nl(lines) {
  return lines.join("\n");
}

const edits = [
  {
    file: "src-tauri/src/storage_paths.rs",
    replacements: [
      // 1) 生命周期: fn lookup
      { old: "    fn lookup(", new: "    fn lookup<'a>(" },
      {
        old: "        map: &HashMap<&'static str, &'static str>,",
        new: "        map: &'a HashMap<&'static str, &'static str>,",
      },
      {
        old: "    ) -> impl Fn(&str) -> Option<OsString> + '_ {",
        new: "    ) -> impl Fn(&str) -> Option<OsString> + 'a {",
      },
      // 2) collapsible_if (migrate_path)
      {
        old: nl([
          "    if let Some(parent) = to.parent() {",
          "        if let Err(error) = fs::create_dir_all(parent) {",
          '            log_migration_warn("create-parent-failed", to, &error.to_string());',
          "            return;",
          "        }",
          "    }",
        ]),
        new: nl([
          "    if let Some(parent) = to.parent()",
          "        && let Err(error) = fs::create_dir_all(parent)",
          "    {",
          '        log_migration_warn("create-parent-failed", to, &error.to_string());',
          "        return;",
          "    }",
        ]),
      },
    ],
  },
  {
    file: "src-tauri/src/commands/skills.rs",
    replacements: [
      // 3) 未用导入 SystemTime
      { old: "    time::{SystemTime, UNIX_EPOCH},", new: "    time::UNIX_EPOCH," },
      // 4) unnecessary_sort_by
      {
        old: "    skills.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));",
        new: "    skills.sort_by_key(|left| left.name.to_lowercase());",
      },
      // 5a) collapsible_if (parse_skill_document) 开头
      {
        old: nl([
          '    if let Some(rest) = normalized.strip_prefix("---\\n") {',
          '        if let Some(end) = rest.find("\\n---") {',
        ]),
        new: nl([
          '    if let Some(rest) = normalized.strip_prefix("---\\n")',
          '        && let Some(end) = rest.find("\\n---")',
          "    {",
        ]),
      },
      // 5b) 对应的收尾大括号 (少一层缩进/少一个 brace)
      {
        old: nl(["            };", "        }", "    }", "    ParsedSkill {"]),
        new: nl(["            };", "    }", "    ParsedSkill {"]),
      },
    ],
  },
  {
    file: "src-tauri/src/agent_sidecar/mod.rs",
    replacements: [
      // 6) 测试模块补充 OnceLock / Duration 导入
      {
        old: nl(["    use std::fs;", "    use std::process::Command;"]),
        new: nl([
          "    use std::fs;",
          "    use std::process::Command;",
          "    use std::sync::OnceLock;",
          "    use std::time::Duration;",
        ]),
      },
    ],
  },
];

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

let totalApplied = 0;
let failed = false;

for (const { file, replacements } of edits) {
  if (!fs.existsSync(file)) {
    console.error(`[SKIP] file not found: ${file}`);
    failed = true;
    continue;
  }
  let content = fs.readFileSync(file, "utf8");
  let fileApplied = 0;

  replacements.forEach((rep, i) => {
    const tag = `${file} #${i + 1}`;
    if (content.includes(rep.new) && !content.includes(rep.old)) {
      console.log(`[SKIP] ${tag}: already applied`);
      return;
    }
    const n = countOccurrences(content, rep.old);
    if (n !== 1) {
      console.error(`[FAIL] ${tag}: expected exactly 1 match but found ${n}. No change made.`);
      failed = true;
      return;
    }
    content = content.replace(rep.old, rep.new);
    fileApplied++;
    totalApplied++;
    console.log(`[OK]   ${tag}: applied`);
  });

  if (fileApplied > 0) {
    fs.writeFileSync(file, content, "utf8"); // UTF-8, no BOM
    console.log(`[WRITE] ${file}: ${fileApplied} change(s) saved`);
  }
}

console.log("------------------------------------------");
console.log(`Total changes applied: ${totalApplied}`);
if (failed) {
  console.error("Some edits FAILED. Nothing partial was forced; review messages above.");
  process.exit(1);
} else {
  console.log("All done. Next, verify inside src-tauri:");
  console.log("  cargo test --no-run");
  console.log("  cargo clippy --all-targets -- -D warnings");
}
#!/usr/bin/env node
// fix-agent-webview-quality.mjs
// 收敛 agent_webview.rs 的代码质量问题：
//   1) 10 处逐字重复的 native_webview 禁用文案 → 单一常量 NATIVE_WEBVIEW_DISABLED
//   2) map_console_level / map_log_level 的取值样板 → 抽出 serde_tag 复用
// 行为完全不变；兼容 CRLF/LF；命中数不符即报错回滚，不写任何备份。
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repoRoot = process.argv[2] ?? process.cwd();
const FILE = 'src-tauri/src/commands/agent_webview.rs';

const edits = [
  // --- Edit A：插入禁用文案常量（仅在关闭 native_webview 时编译） ---
  {
    find: `use tauri::AppHandle;\n\n#[cfg(feature = "native_webview")]\nconst AGENT_WEBVIEW_LABEL: &str = "agent-browser";`,
    replace: `use tauri::AppHandle;\n\n// 关闭 native_webview 特性时各 stub 命令统一返回的错误文案：单一事实源，避免 10 处重复。\n#[cfg(not(feature = "native_webview"))]\nconst NATIVE_WEBVIEW_DISABLED: &str =\n    "native_webview feature is disabled; rebuild with \`--features native_webview\`";\n\n#[cfg(feature = "native_webview")]\nconst AGENT_WEBVIEW_LABEL: &str = "agent-browser";`,
    expect: 1,
  },

  // --- Edit B：抽出 serde_tag，瘦身两个 level 映射函数 ---
  {
    find: `// Map console.* type -> frontend level via serde string (avoids depending on enum variant idents).\n#[cfg(feature = "native_webview")]\nfn map_console_level(\n    ty: &chromiumoxide::cdp::js_protocol::runtime::ConsoleApiCalledType,\n) -> &'static str {\n    match serde_json::to_value(ty)\n        .ok()\n        .and_then(|v| v.as_str().map(str::to_string))\n        .as_deref()\n    {\n        Some("error") | Some("assert") => "error",\n        Some("warning") => "warn",\n        _ => "log",\n    }\n}\n\n#[cfg(feature = "native_webview")]\nfn map_log_level(level: &chromiumoxide::cdp::browser_protocol::log::LogEntryLevel) -> &'static str {\n    match serde_json::to_value(level)\n        .ok()\n        .and_then(|v| v.as_str().map(str::to_string))\n        .as_deref()\n    {\n        Some("error") => "error",\n        Some("warning") => "warn",\n        _ => "log",\n    }\n}`,
    replace: `// 把任意 CDP 枚举序列化成它的 serde 字符串 tag（避免硬编码枚举变体名）。\n#[cfg(feature = "native_webview")]\nfn serde_tag<T: Serialize>(value: &T) -> Option<String> {\n    serde_json::to_value(value)\n        .ok()\n        .and_then(|v| v.as_str().map(str::to_string))\n}\n\n// Map console.* type -> frontend level.\n#[cfg(feature = "native_webview")]\nfn map_console_level(\n    ty: &chromiumoxide::cdp::js_protocol::runtime::ConsoleApiCalledType,\n) -> &'static str {\n    match serde_tag(ty).as_deref() {\n        Some("error") | Some("assert") => "error",\n        Some("warning") => "warn",\n        _ => "log",\n    }\n}\n\n#[cfg(feature = "native_webview")]\nfn map_log_level(level: &chromiumoxide::cdp::browser_protocol::log::LogEntryLevel) -> &'static str {\n    match serde_tag(level).as_deref() {\n        Some("error") => "error",\n        Some("warning") => "warn",\n        _ => "log",\n    }\n}`,
    expect: 1,
  },

  // --- Edit C：10 处禁用文案字面量 → 引用常量 ---
  {
    find: `Err("native_webview feature is disabled; rebuild with \`--features native_webview\`".to_string())`,
    replace: `Err(NATIVE_WEBVIEW_DISABLED.to_string())`,
    all: true,
    expect: 10,
  },
];

const rawIn = await readFile(resolve(repoRoot, FILE), 'utf8');
const isCRLF = rawIn.includes('\r\n');
let text = rawIn.replace(/\r\n/g, '\n'); // 归一化后匹配（find/replace 全用 LF 书写）

for (const [i, e] of edits.entries()) {
  const count = text.split(e.find).length - 1;
  const expect = e.expect ?? 1;
  if (count !== expect) {
    throw new Error(`编辑 #${i + 1} 期望命中 ${expect} 处，实际 ${count} 处。请确认仓库在 main 且未被改动后重试。`);
  }
  text = e.all ? text.split(e.find).join(e.replace) : text.replace(e.find, e.replace);
}

await writeFile(resolve(repoRoot, FILE), isCRLF ? text.replace(/\n/g, '\r\n') : text, 'utf8');

console.log(`✅ 已修改 ${FILE} [${isCRLF ? 'CRLF' : 'LF'}]`);
console.log('   - 新增常量 NATIVE_WEBVIEW_DISABLED，10 处重复文案收敛为单一引用');
console.log('   - 抽出 serde_tag，map_console_level / map_log_level 去重');
console.log('\n下一步：cargo clippy && cargo test（默认特性即可覆盖 stub 分支编译）。');
// revert-webview-defaultbg.mjs
// 移除上一版注入 harden_webview_settings 的 DefaultBackgroundColor 补丁(已证无效),
// 把 with_webview 闭包还原为改动前原样。幂等:未检测到补丁则不改动。无备份、可 git 追溯。
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src-tauri/src/main.rs";
const src = readFileSync(FILE, "utf8");

if (!/SetDefaultBackgroundColor/.test(src)) {
  console.log("[skip] 未发现该补丁,文件可能已回退,未改动。");
  process.exit(0);
}

// 闭包开头 `unsafe {` 之后、到紧随的 `let outcome = webview` 之间,原本什么都没有;
// 把这中间(即我插入的注释+DefaultBackgroundColor 块)整段删除即完整还原。CRLF/LF 兼容。
const re = /(with_webview\(move \|webview\| unsafe \{\r?\n)[\s\S]*?\r?\n([ \t]*let outcome = webview\b)/;
if (!re.test(src)) {
  console.log("[fail] 命中补丁标识但未匹配到闭包锚点,请人工核对,未改动。");
  process.exit(1);
}

const out = src.replace(re, "$1$2");
if (/SetDefaultBackgroundColor|ICoreWebView2Controller2|漏底根因修复/.test(out)) {
  console.log("[fail] 回退后仍残留补丁片段,已放弃写入,请人工核对。");
  process.exit(1);
}

writeFileSync(FILE, out, "utf8");
console.log("[ok] 已移除补丁,harden_webview_settings 恢复原样。请 git add/commit/push。");
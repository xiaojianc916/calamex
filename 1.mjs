// fix-narrow-acp-host-deadcode-allow.mjs
// 作用：去掉 acp/host.rs 文件级 #![allow(dead_code)]，改为对 10 个「已实现未接线」方法
//       逐个精确标注 #[allow(dead_code)]（含移除触发说明），使其余部分恢复死代码检测。
// 幂等；CRLF 安全；锚点命中数必须为 1，否则中止且不写盘。
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = process.cwd();

function findFile(relParts) {
  const direct = join(ROOT, ...relParts);
  if (existsSync(direct)) return direct;
  const target = relParts.join("/");
  const stack = [ROOT];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "target") continue;
        stack.push(full);
      } else if (full.split(sep).join("/").endsWith(target)) {
        return full;
      }
    }
  }
  return null;
}

const hostPath = findFile(["src-tauri", "src", "acp", "host.rs"]);
if (!hostPath) { console.error("✗ 未找到 src-tauri/src/acp/host.rs（请在仓库根目录运行）"); process.exit(1); }
console.log("• host.rs → " + hostPath);

const original = readFileSync(hostPath, "utf8");
const eol = original.includes("\r\n") ? "\r\n" : "\n";
let text = original.split("\r\n").join("\n");

function replaceOnce(oldStr, newStr, label) {
  const parts = text.split(oldStr);
  const hits = parts.length - 1;
  if (hits !== 1) {
    throw new Error("锚点[" + label + "]命中 " + hits + " 次（应为 1）——已中止，未写入任何改动。");
  }
  text = parts.join(newStr);
}

// ── 1) 去掉文件级 blanket allow（含其上两行说明注释）────────────────────────────
const blanketBlock =
  "// 过渡期：本模块部分薄宿主方法（web_search / web_fetch / restore_checkpoint 等）尚未\n" +
  "// 全部接线到宿主命令，crate 外暂无调用点；接线后移除该 allow。\n" +
  "#![allow(dead_code)]\n\n" +
  "use parking_lot::Mutex;";
let didBlanket = false;
if (text.includes("#![allow(dead_code)]")) {
  replaceOnce(blanketBlock, "use parking_lot::Mutex;", "移除文件级 #![allow(dead_code)]");
  didBlanket = true;
  console.log("✓ 已移除文件级 #![allow(dead_code)]");
} else {
  console.log("· 跳过：文件级 #![allow(dead_code)] 已不存在");
}

// ── 2) 对 10 个「已实现未接线」项逐个精确标注 #[allow(dead_code)] ────────────────
// [锚点(每行起始，含缩进), 说明, 标签]
const DEAD = [
  ["    pub async fn prompt(",                 "Layer6 主回合(session/prompt)尚未接线到命令，接线后删本行", "prompt"],
  ["    pub async fn prompt_with_stream_key(", "Layer6 主回合(session/prompt)尚未接线到命令，接线后删本行", "prompt_with_stream_key"],
  ["    fn replay_available_commands(",        "随 Layer6 主回合接线，接线后删本行", "replay_available_commands"],
  ["    pub async fn prompt_text(",            "Layer6 主回合(session/prompt)尚未接线到命令，接线后删本行", "prompt_text"],
  ["    pub async fn restore_checkpoint(",     "calamex.dev/checkpoint/restore 未接线到命令，接线后删本行", "restore_checkpoint"],
  ["    pub async fn web_search(",             "calamex.dev/web/search 未接线到命令，接线后删本行", "web_search"],
  ["    pub async fn web_fetch(",              "calamex.dev/web/fetch 未接线到命令，接线后删本行", "web_fetch"],
  ["    pub async fn warmup(",                 "calamex.dev/warmup 未接线到命令，接线后删本行", "warmup"],
  ["    pub async fn health(",                 "calamex.dev/health 未接线到命令，接线后删本行", "health"],
  ["fn build_available_commands_event(",       "仅随 Layer6 主回合调用，接线后删本行", "build_available_commands_event"],
];

let added = 0;
for (const [anchor, reason, label] of DEAD) {
  const indent = (anchor.match(/^(\s*)/) || ["", ""])[1];
  const attrLine = indent + "#[allow(dead_code)] // " + reason;
  if (text.includes(attrLine + "\n" + anchor)) { console.log("· 跳过(已标注)：" + label); continue; }
  replaceOnce(anchor, attrLine + "\n" + anchor, label);
  console.log("✓ 标注 dead_code：" + label);
  added++;
}

if (!didBlanket && added === 0) {
  console.log("✓ 已是目标状态，无需改动。");
  process.exit(0);
}

writeFileSync(hostPath, text.split("\n").join(eol), "utf8");
console.log("✓ 已写入 " + hostPath + "（eol=" + (eol === "\r\n" ? "CRLF" : "LF") + "）");
console.log("请运行：cargo build && cargo test");
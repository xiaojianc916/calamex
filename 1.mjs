// fix-acp-spawn-runtime.mjs  —— 保存为 1.mjs 后 node 1.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const file = "src-tauri/src/acp/client.rs";

// 锚点取「notif_seq 克隆 + 空行 + 外层 spawn + let result = Client」四行，
// 4 空格缩进的 spawn 只此一处（内层权限处理器的 spawn 是 24 空格缩进，不会误伤）。
const OLD = `    let notif_seq = seq.clone();

    tokio::spawn(async move {
        let result = Client`;

const NEW = `    let notif_seq = seq.clone();

    tauri::async_runtime::spawn(async move {
        let result = Client`;

function countOcc(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

const abs = resolve(root, file);
const raw = readFileSync(abs, "utf8");
const hadCRLF = raw.includes("\r\n");
const lf = raw.replace(/\r\n/g, "\n");

// 幂等 + 精确校验
if (countOcc(lf, NEW) > 0) {
  console.log("ℹ️ 已是 tauri::async_runtime::spawn，无需修改（幂等）。");
  process.exit(0);
}
const n = countOcc(lf, OLD);
if (n !== 1) throw new Error(`[校验失败] ${file} 锚点出现 ${n} 次（应为 1）`);

const patched = lf.replace(OLD, NEW);

// 残留检查：外层（4 空格缩进）不得再有裸 tokio::spawn
if (countOcc(patched, "\n    tokio::spawn(async move {") !== 0) {
  throw new Error("[校验失败] 仍存在 4 空格缩进的裸 tokio::spawn");
}

writeFileSync(abs, hadCRLF ? patched.replace(/\n/g, "\r\n") : patched, "utf8");
console.log(`✅ 已修补 ${file}`);
console.log("   外层 ACP 连接任务改用 tauri::async_runtime::spawn（与调用线程无关）。");
console.log("下一步：pnpm tauri dev（Rust 会重新编译该 crate）。");
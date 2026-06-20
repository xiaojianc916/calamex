// 5.mjs — 补丁#3：runtime 切到 provisioner 注册表（acp/runtime.rs）
// 用法：node 5.mjs   （或 node 5.mjs <runtime.rs路径> <provisioner.rs路径>）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const rtPath = resolve(process.argv[2] ?? "src-tauri/src/acp/runtime.rs");
const provPath = resolve(process.argv[3] ?? "src-tauri/src/acp/provisioner.rs");

// ---- 前置守卫：patch#2 必须已在工作区 ----
if (!existsSync(provPath) || !readFileSync(provPath, "utf8").includes("provisioner_for")) {
  console.error("❌ 未检测到 patch#2：acp/provisioner.rs 不存在或缺少 provisioner_for。请先运行 4.mjs，再跑本脚本。");
  process.exit(1);
}

const raw = readFileSync(rtPath, "utf8");
const usedCrlf = raw.includes("\r\n");
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("use super::provisioner::provisioner_for;")) {
  console.log("✓ 已应用过（runtime.rs 已接 provisioner_for），幂等跳过，未改动。");
  process.exit(0);
}

function dumpContext(needle) {
  const head = needle.split("\n")[0];
  const at = src.indexOf(head);
  console.error("---- 诊断：目标首行 = " + JSON.stringify(head));
  console.error("---- runtime.rs 中该首行位置 = " + at);
  if (at !== -1) console.error("---- 实际上下文 ----\n" + JSON.stringify(src.slice(at, at + 240)));
}

function applyOnce(label, needle, replacement) {
  const first = src.indexOf(needle);
  if (first === -1) {
    dumpContext(needle);
    console.error(`❌ [${label}] 未找到目标片段；runtime.rs 可能与预期版本(sha 12fd6434)不一致，已中止且未写入。`);
    process.exit(1);
  }
  if (src.indexOf(needle, first + needle.length) !== -1) {
    console.error(`❌ [${label}] 目标片段出现多于一次，为安全起见已中止。`);
    process.exit(1);
  }
  src = src.slice(0, first) + replacement + src.slice(first + needle.length);
  console.log(`✓ ${label}`);
}

// ---- 1/3 调整 import：去掉 build_acp_client_config_for，引入 provisioner_for ----
applyOnce(
  "1/3 runtime.rs import 引入 provisioner_for",
  "use super::launch::{AcpBackendId, build_acp_client_config_for};",
  "use super::launch::AcpBackendId;\nuse super::provisioner::provisioner_for;"
);

// ---- 2/3 get_or_spawn_backend 切到 provisioner（保持原顺序：先 launch_config，?早退不 seed，再 prepare）----
applyOnce(
  "2/3 get_or_spawn_backend 切到 provisioner_for",
  "        let config = build_acp_client_config_for(backend).map_err(AcpClientError::Transport)?;\n" +
  "        // 外部后端拉起前的凭证预置（Kimi：用项目已存网关配置写 ~/.kimi/config.toml；其余 no-op）。\n" +
  "        super::launch::prepare_external_backend_launch(backend);",
  "        // 经 provisioner 注册表统一驱动该后端的「启动配置 + 凭证预置」。\n" +
  "        // 新增 ACP agent 后端只需在 provisioner_for 注册一行，runtime 无需改动。\n" +
  "        let provisioner = provisioner_for(backend);\n" +
  "        // 启动配置解析失败（未找到 node / ACP 入口等）等价于「无法建立传输」，归入 Transport 错误。\n" +
  "        let config = provisioner\n" +
  "            .launch_config()\n" +
  "            .map_err(AcpClientError::Transport)?;\n" +
  "        // 外部后端拉起前的凭证预置（Kimi：写托管 KIMI_HOME/config.toml；Builtin/Codex 为 no-op）。\n" +
  "        provisioner.prepare();"
);

// ---- 3/3 restart_backend 切到 provisioner（同序）----
applyOnce(
  "3/3 restart_backend 切到 provisioner_for",
  "        let config = build_acp_client_config_for(backend).map_err(AcpClientError::Transport)?;\n" +
  "        // 重建外部后端前同样刷新凭证预置（Kimi 切模型 / 重启时随之刷新 ~/.kimi/config.toml）。\n" +
  "        super::launch::prepare_external_backend_launch(backend);",
  "        // 同 get_or_spawn_backend：经 provisioner 注册表统一驱动启动配置 + 凭证预置。\n" +
  "        let provisioner = provisioner_for(backend);\n" +
  "        let config = provisioner\n" +
  "            .launch_config()\n" +
  "            .map_err(AcpClientError::Transport)?;\n" +
  "        // 重建外部后端前同样刷新凭证预置（Kimi 切模型 / 重启时随之刷新托管 config.toml）。\n" +
  "        provisioner.prepare();"
);

writeFileSync(rtPath, usedCrlf ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("✅ 补丁#3 应用完成，已写回 " + (usedCrlf ? "(CRLF)" : "(LF)") + "：runtime.rs 现经 provisioner_for(...) 驱动启动配置 + 凭证预置。");
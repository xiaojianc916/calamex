// 6.mjs — 补丁#4：collect_kimi_model_entry 改用 credential::resolve_provider_base_url
// 用法：node 6.mjs   （或 node 6.mjs <launch.rs路径>）
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const lpPath = resolve(process.argv[2] ?? "src-tauri/src/acp/launch.rs");
const raw = readFileSync(lpPath, "utf8");
const usedCrlf = raw.includes("\r\n");
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("credential::resolve_provider_base_url")) {
  console.log("✓ 已应用过（launch.rs 已用 resolve_provider_base_url），幂等跳过，未改动。");
  process.exit(0);
}

function dumpContext(needle) {
  const head = needle.split("\n")[0];
  const at = src.indexOf(head);
  console.error("---- 诊断：目标首行 = " + JSON.stringify(head));
  console.error("---- launch.rs 中该首行位置 = " + at);
  if (at !== -1) console.error("---- 实际上下文 ----\n" + JSON.stringify(src.slice(at, at + 320)));
}

function applyOnce(label, needle, replacement) {
  const first = src.indexOf(needle);
  if (first === -1) {
    dumpContext(needle);
    console.error("❌ [" + label + "] 未找到目标片段；launch.rs 可能与预期版本(sha 1ef5e07d)不一致，已中止且未写入。");
    process.exit(1);
  }
  if (src.indexOf(needle, first + needle.length) !== -1) {
    console.error("❌ [" + label + "] 目标片段出现多于一次，为安全起见已中止。");
    process.exit(1);
  }
  src = src.slice(0, first) + replacement + src.slice(first + needle.length);
  console.log("✓ " + label);
}

// ---- 1/3 更新函数 doc 注释（去掉对 default_gateway_base_url 的引用，改述统一解析器）----
applyOnce(
  "1/3 collect_kimi_model_entry doc 注释",
  "/// 把一个 sidecar 模型配置解析成「provider + model」成对条目。base_url 优先取用户显式保存的\n" +
  "/// 网关地址，缺失时回退该厂商的默认 OpenAI 兼容端点（`default_gateway_base_url`）；仅当 model_id\n" +
  "/// 为空，或厂商既无显式地址又无默认端点时返回 None，交由调用方决定跳过或回退。",
  "/// 把一个 sidecar 模型配置解析成「provider + model」成对条目。base_url 经统一凭证解析器\n" +
  "/// credential::resolve_provider_base_url 派生（用户显式网关地址优先，否则回退该厂商默认 OpenAI\n" +
  "/// 兼容端点）；仅当 model_id 为空，或厂商既无显式地址又无默认端点时返回 None，交由调用方跳过或回退。"
);

// ---- 2/3 base_url 推导改走统一解析器 ----
applyOnce(
  "2/3 base_url 推导改用 resolve_provider_base_url",
  "    // base_url：优先用户在 AI 设置里显式保存的网关地址；缺失时回退该厂商官方 OpenAI 兼容端点。\n" +
  "    // 此前缺 base_url 会直接返回 None → 整份 config.toml 跳过 → Kimi 无凭证报 Authentication required。\n" +
  "    let base_url = config\n" +
  "        .base_url\n" +
  "        .as_deref()\n" +
  "        .map(str::trim)\n" +
  "        .filter(|value| !value.is_empty())\n" +
  "        .or_else(|| default_gateway_base_url(platform))?;",
  "    // base_url：经统一凭证解析器 credential::resolve_provider_base_url 派生——显式网关地址优先，\n" +
  "    // 缺失则回退该厂商默认 OpenAI 兼容端点；与内置边车 / 未来其他 agent 共用同一处解析（单一事实源），\n" +
  "    // 不再本地复制「显式优先、否则默认」控制流。返回 None（既无显式地址也无默认端点）时整体跳过、\n" +
  "    // 交回 Kimi 自身登录——此即修复 Authentication required 的关键路径。\n" +
  "    let base_url =\n" +
  "        crate::ai::credential::resolve_provider_base_url(platform, config.base_url.as_deref())?;"
);

// ---- 3/3 base_url 现为 String，直接 move 进结构体字段（去掉冗余 to_string）----
applyOnce(
  "3/3 KimiProviderEntry.base_url 直接 move",
  "            base_url: base_url.to_string(),",
  "            base_url,"
);

writeFileSync(lpPath, usedCrlf ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("✅ 补丁#4 应用完成，已写回 " + (usedCrlf ? "(CRLF)" : "(LF)") + "：Kimi seed 的 base_url 解析已收敛到 credential::resolve_provider_base_url。");
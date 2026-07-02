// fix-p9a-declare-caps.mjs —— 仅声明 client_capabilities + client_info（幂等，CRLF 安全）
import { readFileSync, writeFileSync } from "node:fs";

const f = "src-tauri/src/acp/client.rs";
let s = readFileSync(f, "utf8");
const orig = s;

// 1) 升级 initialize 调用（锚点唯一）
const anchor = "InitializeRequest::new(ProtocolVersion::V1)";
if (!s.includes(anchor)) throw new Error("找不到 InitializeRequest 锚点，请手动核对 client.rs");
if (!s.includes(".client_capabilities(")) {
  s = s.replace(
    anchor,
    `InitializeRequest::new(ProtocolVersion::V1)
    .client_capabilities(
        ClientCapabilities::new()
            .fs(FileSystemCapabilities::new()
                .read_text_file(true)
                .write_text_file(true))
            .terminal(true),
    )
    .client_info(Implementation::new("calamex", env!("CARGO_PKG_VERSION")))`
  );
}

// 2) 补齐 schema 导入（只加缺的标识符）
const need = ["ClientCapabilities", "FileSystemCapabilities", "Implementation"];
const useRe = /use agent_client_protocol::schema::\{/;
if (useRe.test(s)) {
  const head = s.split("connect_with")[0];
  const missing = need.filter((id) => !new RegExp(`\\b${id}\\b`).test(head));
  if (missing.length) s = s.replace(useRe, (m) => `${m}\n\t${missing.join(", ")},`);
} else {
  console.warn("未找到 schema use 块，请手动补 import：", need.join(", "));
}

if (s !== orig) { writeFileSync(f, s, "utf8"); console.log("✔ 已声明 fs(read/write)+terminal 能力与 client_info"); }
else console.log("• 已是最新，无需改动");
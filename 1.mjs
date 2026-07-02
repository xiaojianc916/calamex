import { readFileSync, writeFileSync, existsSync } from "node:fs";

const path = "src-tauri/src/acp/host.rs";
if (!existsSync(path)) throw new Error(`missing ${path}`);
const src = readFileSync(path, "utf8");
const nl = src.includes("\r\n") ? "\r\n" : "\n";
let lines = src.split(/\r?\n/);
const has = (needle) => lines.some((l) => l.includes(needle));

// (a) import AcpBridges after the approval use line
if (!has("use super::bridges::AcpBridges;")) {
  const i = lines.findIndex((l) => l.trim() === "use super::approval::{ApprovalError, ApprovalRegistry, ApprovalRequestInfo};");
  if (i < 0) throw new Error("anchor approval use line not found");
  lines.splice(i + 1, 0, "use super::bridges::AcpBridges;");
}

// (b) build disk-backed bridges + pass to spawn_acp_client
if (!has("let bridges = AcpBridges::disk_backed();")) {
  const i = lines.findIndex((l) => l.includes("let handle = spawn_acp_client(config, sink, resolver)?;"));
  if (i < 0) throw new Error("anchor spawn_acp_client call not found");
  const indent = lines[i].match(/^[ \t]*/)[0];
  lines.splice(i, 1,
    `${indent}let bridges = AcpBridges::disk_backed();`,
    `${indent}let handle = spawn_acp_client(config, sink, resolver, bridges)?;`,
  );
}

writeFileSync(path, lines.join(nl));
console.log("p9g: host.rs wired AcpBridges::disk_backed() into spawn_acp_client.");
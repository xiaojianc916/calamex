import { readFileSync, writeFileSync, existsSync } from "node:fs";

const bridgesPath = "src-tauri/src/acp/bridges.rs";
const fsBridgePath = "src-tauri/src/acp/fs_bridge.rs";
const modPath = "src-tauri/src/acp/mod.rs";

for (const p of [bridgesPath, modPath]) {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
}

const nlOf = (t) => (t.includes("\r\n") ? "\r\n" : "\n");

// ---- 1) bridges.rs -> fs-only ----
const nl1 = nlOf(readFileSync(bridgesPath, "utf8"));
const bridges = [
  "#![allow(dead_code)]",
  "",
  "use agent_client_protocol::{",
  "    BoxFuture,",
  "    schema::{",
  "        ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse,",
  "    },",
  "};",
  "use std::sync::Arc;",
  "",
  "pub type AcpResult<T> = Result<T, agent_client_protocol::Error>;",
  "",
  "pub type FsReadResolver = Arc<",
  "    dyn Fn(ReadTextFileRequest) -> BoxFuture<'static, AcpResult<ReadTextFileResponse>>",
  "        + Send",
  "        + Sync,",
  ">;",
  "",
  "pub type FsWriteResolver = Arc<",
  "    dyn Fn(WriteTextFileRequest) -> BoxFuture<'static, AcpResult<WriteTextFileResponse>>",
  "        + Send",
  "        + Sync,",
  ">;",
  "",
  "#[derive(Clone)]",
  "pub struct AcpBridges {",
  "    pub fs_read: FsReadResolver,",
  "    pub fs_write: FsWriteResolver,",
  "}",
  "",
  "impl AcpBridges {",
  "    pub fn disk_backed() -> Self {",
  "        Self {",
  "            fs_read: super::fs_bridge::fs_read_resolver(),",
  "            fs_write: super::fs_bridge::fs_write_resolver(),",
  "        }",
  "    }",
  "}",
  "",
].join(nl1);
writeFileSync(bridgesPath, bridges);

// ---- 2) fs_bridge.rs (new, disk-backed) ----
const fsNl = existsSync(fsBridgePath) ? nlOf(readFileSync(fsBridgePath, "utf8")) : nl1;
const fsBridge = [
  "use agent_client_protocol::{",
  "    BoxFuture, Error,",
  "    schema::{",
  "        ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse,",
  "    },",
  "};",
  "use std::sync::Arc;",
  "",
  "use super::bridges::{AcpResult, FsReadResolver, FsWriteResolver};",
  "",
  "pub fn fs_read_resolver() -> FsReadResolver {",
  "    Arc::new(",
  "        |req: ReadTextFileRequest| -> BoxFuture<'static, AcpResult<ReadTextFileResponse>> {",
  "            Box::pin(async move {",
  "                let path = req.path.clone();",
  "                let content = std::fs::read_to_string(&path).map_err(|err| {",
  "                    if err.kind() == std::io::ErrorKind::NotFound {",
  "                        Error::resource_not_found(Some(path.display().to_string()))",
  "                    } else {",
  "                        Error::into_internal_error(err)",
  "                    }",
  "                })?;",
  "                let sliced = slice_lines(&content, req.line, req.limit);",
  "                Ok(ReadTextFileResponse::new(sliced))",
  "            })",
  "        },",
  "    )",
  "}",
  "",
  "pub fn fs_write_resolver() -> FsWriteResolver {",
  "    Arc::new(",
  "        |req: WriteTextFileRequest| -> BoxFuture<'static, AcpResult<WriteTextFileResponse>> {",
  "            Box::pin(async move {",
  "                if let Some(parent) = req.path.parent()",
  "                    && !parent.as_os_str().is_empty()",
  "                {",
  "                    std::fs::create_dir_all(parent).map_err(Error::into_internal_error)?;",
  "                }",
  "                std::fs::write(&req.path, req.content.as_bytes())",
  "                    .map_err(Error::into_internal_error)?;",
  "                Ok(WriteTextFileResponse::new())",
  "            })",
  "        },",
  "    )",
  "}",
  "",
  "fn slice_lines(content: &str, line: Option<u32>, limit: Option<u32>) -> String {",
  "    if line.is_none() && limit.is_none() {",
  "        return content.to_string();",
  "    }",
  "    let start = line.map(|value| value.saturating_sub(1) as usize).unwrap_or(0);",
  "    let selected = content.lines().skip(start);",
  "    let collected: Vec<&str> = match limit {",
  "        Some(count) => selected.take(count as usize).collect(),",
  "        None => selected.collect(),",
  "    };",
  '    collected.join("\\n")',
  "}",
  "",
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  "",
  "    #[test]",
  "    fn slice_lines_returns_all_when_unbounded() {",
  '        let input = "a\\nb\\nc";',
  '        assert_eq!(slice_lines(input, None, None), "a\\nb\\nc");',
  "    }",
  "",
  "    #[test]",
  "    fn slice_lines_applies_offset_and_limit() {",
  '        let input = "a\\nb\\nc\\nd";',
  '        assert_eq!(slice_lines(input, Some(2), Some(2)), "b\\nc");',
  "    }",
  "}",
  "",
].join(fsNl);
writeFileSync(fsBridgePath, fsBridge);

// ---- 3) mod.rs: register mod fs_bridge; after pub mod bridges; ----
let mod = readFileSync(modPath, "utf8");
const modNl = nlOf(mod);
if (!/^[ \t]*mod fs_bridge;[ \t]*$/m.test(mod)) {
  if (!/^[ \t]*pub mod bridges;[ \t]*$/m.test(mod)) {
    throw new Error("anchor 'pub mod bridges;' not found in mod.rs");
  }
  mod = mod.replace(/^([ \t]*pub mod bridges;)[ \t]*$/m, `$1${modNl}mod fs_bridge;`);
  writeFileSync(modPath, mod);
}

console.log("p9d: bridges.rs (fs-only) + fs_bridge.rs written, mod fs_bridge registered.");
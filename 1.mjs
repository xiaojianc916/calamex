// 7.mjs — 统一 ShellCheck 管线：删除冗余的后端 analyze_script 引擎，
// 只保留 bash-language-server (LSP) 这一条诊断管线（不留新旧杂糅/兼容层）。
// 在仓库根目录运行：  node 7.mjs
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
let changed = 0;

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');

function edit(rel, ops, mustBeGone = []) {
  if (!existsSync(join(ROOT, rel))) throw new Error(`缺失文件：${rel}`);
  let c = read(rel);
  const eol = eolOf(c);
  const toEol = (s) => s.split('\n').join(eol);

  for (const op of ops) {
    if (op.find !== undefined) {
      const f = toEol(op.find), r = toEol(op.replace);
      if (!c.includes(f)) throw new Error(`[${rel}] 锚点未命中:\n${op.find.slice(0, 80)}…`);
      c = c.replace(f, r);
    } else {
      // cut: 删除 [start, end) ；end 省略表示删到文件末尾
      const s = toEol(op.cutStart);
      const i = c.indexOf(s);
      if (i < 0) throw new Error(`[${rel}] cutStart 未命中: ${op.cutStart.slice(0, 60)}…`);
      let j;
      if (op.cutEnd === undefined) {
        c = c.slice(0, i).replace(/(\r?\n)+$/, eol);
        continue;
      }
      const e = toEol(op.cutEnd);
      j = c.indexOf(e, i);
      if (j < 0) throw new Error(`[${rel}] cutEnd 未命中: ${op.cutEnd.slice(0, 60)}…`);
      c = c.slice(0, i) + c.slice(j);
    }
  }

  for (const token of mustBeGone) {
    if (c.includes(token)) throw new Error(`[${rel}] 残留未清除: ${token}`);
  }

  writeFileSync(join(ROOT, rel), c);
  changed++;
  console.log(`✓ 修改 ${rel}`);
}

// ── 1) 后端：命令注册表去掉 analyze_script ────────────────────────────────
edit('src-tauri/src/tauri_bindings.rs', [
  { find: `            shell_tools::analyze_script,\n            shell_tools::format_script,\n`,
    replace: `            shell_tools::format_script,\n` },
], ['analyze_script']);

// ── 2) 后端：mod.rs 去掉 4 个契约类型的再导出 ─────────────────────────────
edit('src-tauri/src/commands/mod.rs', [
  { find:
`pub use contracts::{
    AnalyzeScriptPayload, AnalyzeScriptRequest, DocumentEncoding, ExecutionEnvironment,
    ScriptDiagnosticPayload, ScriptDiagnosticSeverity,
    ExecutionOption, ExecutorKind, FormatDocumentPayload, FormatDocumentRequest,`,
    replace:
`pub use contracts::{
    DocumentEncoding, ExecutionEnvironment,
    ExecutionOption, ExecutorKind, FormatDocumentPayload, FormatDocumentRequest,` },
], ['AnalyzeScriptPayload', 'AnalyzeScriptRequest', 'ScriptDiagnosticPayload', 'ScriptDiagnosticSeverity']);

// ── 3) 后端：契约里删掉 4 个 ShellCheck 专用类型 ──────────────────────────
edit('src-tauri/src/commands/contracts/script.rs', [
  // 删除 ScriptDiagnosticSeverity 枚举 + TryFrom 实现
  { cutStart: `#[derive(Debug, Clone, Serialize, Deserialize, Type)]\n#[serde(rename_all = "lowercase")]\npub enum ScriptDiagnosticSeverity {`,
    cutEnd: `#[derive(Debug, Clone, Serialize, Type)]\n#[serde(rename_all = "camelCase")]\npub struct ScriptFilePayload {` },
  // 删除 AnalyzeScriptRequest / ScriptDiagnosticPayload / AnalyzeScriptPayload
  { cutStart: `#[derive(Debug, Clone, Deserialize, Type)]\n#[serde(rename_all = "camelCase")]\npub struct AnalyzeScriptRequest {`,
    cutEnd: `// ============================================================================\n// Execution environment` },
], ['ScriptDiagnosticSeverity', 'AnalyzeScriptRequest', 'AnalyzeScriptPayload', 'ScriptDiagnosticPayload']);

// ── 4) 后端：shell_tools.rs 删掉 analyze_script 及全部 ShellCheck 辅助/常量/结构/测试 ──
edit('src-tauri/src/commands/shell_tools.rs', [
  // 4a 收敛 import（去掉 4 个契约类型 / serde::Deserialize / OsString / Path）
  { find:
`use super::{
    AnalyzeScriptPayload, AnalyzeScriptRequest, FormatScriptPayload, FormatScriptRequest,
    ScriptDiagnosticPayload, ScriptDiagnosticSeverity, configure_std_command_for_background,
    configure_tokio_command_for_background, count_to_u32,
};
use serde::Deserialize;
use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::Arc,
    time::Duration,
};`,
    replace:
`use super::{
    FormatScriptPayload, FormatScriptRequest, configure_std_command_for_background,
    configure_tokio_command_for_background, count_to_u32,
};
use std::{
    env,
    path::PathBuf,
    process::{Command as StdCommand, Stdio},
    sync::Arc,
    time::Duration,
};` },
  // 4b 常量：只保留 SHFMT_TIMEOUT
  { find:
`const SHELLCHECK_TIMEOUT: Duration = Duration::from_secs(12);
const SHFMT_TIMEOUT: Duration = Duration::from_secs(12);
const SHELLCHECK_SCRIPT_EXTENSIONS: &[&str] = &["sh", "bash", "dash", "ksh", "bats"];
const SHELLCHECK_SCRIPT_NAMES: &[&str] = &[
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".profile",
    ".kshrc",
    "bashrc",
    "profile",
];`,
    replace:
`const SHFMT_TIMEOUT: Duration = Duration::from_secs(12);` },
  // 4c 结构体：删 ShellCheckCandidate / ShellCheckJsonPayload / ShellCheckComment，保留 ShfmtCandidate
  { cutStart: `struct ShellCheckCandidate {`, cutEnd: `struct ShfmtCandidate {` },
  // 4d 删 analyze_script 命令本体（保留紧随其后的 format_script）
  { cutStart: `#[tauri::command]\n#[specta::specta]\npub async fn analyze_script(payload: AnalyzeScriptRequest)`,
    cutEnd: `#[tauri::command]\n#[specta::specta]\npub async fn format_script(payload: FormatScriptRequest)` },
  // 4e 删 11 个 ShellCheck 辅助函数（到 bundled_resource_roots 文档注释前），保留 shfmt 路径
  { cutStart: `fn parse_shellcheck_diagnostics(output: &str) -> Result<Vec<ScriptDiagnosticPayload>, String> {`,
    cutEnd: `/// 候选「随包资源」根目录` },
  // 4f 删 ShellCheck 专用测试模块（到文件末尾）
  { cutStart: `#[cfg(test)]\nmod tests {` },
], ['analyze_script', 'ShellCheck', 'shellcheck', 'ScriptDiagnostic', 'OsString', 'SHELLCHECK_']);

// ── 5) 前端类型：types/editor 去掉 4 个导入 + 4 个别名 ─────────────────────
edit('src/types/editor/index.ts', [
  { find: `  AnalyzeScriptPayload,\n`, replace: `` },
  { find: `  AnalyzeScriptRequest,\n`, replace: `` },
  { find: `  ScriptDiagnosticPayload,\n`, replace: `` },
  { find: `  ScriptDiagnosticSeverity,\n`, replace: `` },
  { find: `export type TScriptDiagnosticSeverity = ScriptDiagnosticSeverity;\n`, replace: `` },
  { find:
`export type IScriptDiagnostic = ScriptDiagnosticPayload;

export type IAnalyzeScriptRequest = AnalyzeScriptRequest;

export type IAnalyzeScriptPayload = AnalyzeScriptPayload;

export type IImageAssetPayload = ImageAssetPayload;`,
    replace:
`export type IImageAssetPayload = ImageAssetPayload;` },
], ['AnalyzeScript', 'ScriptDiagnostic']);

// ── 6) 前端类型：ITauriService 去掉 analyzeScript 及其 2 个导入 ────────────
edit('src/types/tauri/index.ts', [
  { find: `  IAnalyzeScriptPayload,\n`, replace: `` },
  { find: `  IAnalyzeScriptRequest,\n`, replace: `` },
  { find: `  analyzeScript(payload: IAnalyzeScriptRequest): Promise<IAnalyzeScriptPayload>;\n`, replace: `` },
], ['AnalyzeScript', 'analyzeScript']);

// ── 7) 前端服务：workspace.ts 去掉 analyzeScript（Pick / meta / 方法） ──────
edit('src/services/tauri/workspace.ts', [
  { find: `  | 'analyzeScript'\n`, replace: `` },
  { find:
`  analyzeScript: {
    command: 'analyze_script',
    guardHint: '执行 ShellCheck 实时诊断',
    idempotent: true,
  },
  formatScript: {`,
    replace: `  formatScript: {` },
  { find:
`  analyzeScript(payload, options?: IIpcCallOptions) {
    return runCommand(WORKSPACE_COMMAND_META.analyzeScript, payload, options, () =>
      commands.analyzeScript(payload),
    );
  },

  formatScript(payload, options?: IIpcCallOptions) {`,
    replace: `  formatScript(payload, options?: IIpcCallOptions) {` },
], ['analyzeScript', 'analyze_script']);

// ── 8) 前端：useAiAssistant 去掉无人使用的 analysis 选项 + 其类型导入 ───────
edit('src/composables/ai/useAiAssistant.ts', [
  { find: `  IAnalyzeScriptPayload,\n`, replace: `` },
  { find: `  analysis: Ref<IAnalyzeScriptPayload>;\n`, replace: `` },
], ['IAnalyzeScriptPayload']);

// ── 9) 删除孤立的 ShellCheck host-tool 切片文件 ────────────────────────────
const shellcheckFile = 'src/composables/ai/useAiAssistant.shellcheck.ts';
if (existsSync(join(ROOT, shellcheckFile))) {
  unlinkSync(join(ROOT, shellcheckFile));
  changed++;
  console.log(`✓ 删除 ${shellcheckFile}`);
}

// ── 10) 全树自检：列出本机仍存在的引用（我无法遍历你本地全树，交给脚本扫描）──
const SCAN_DIRS = ['src', 'src-tauri/src'];
const SKIP = new Set(['node_modules', 'target', 'dist', '.git']);
const RE = /analyze_script|analyzeScript|AnalyzeScript|ScriptDiagnostic|runShellCheckForAppliedPatch|useAiAssistant\.shellcheck/;
const isGenerated = (p) => /(^|\/)bindings(\/|$)|(^|\/)generated(\/|$)|tauri\.contracts\.ts$|\/bindings\/tauri\.ts$/.test(p.split(sep).join('/'));

const action = [];
const expected = [];
function walk(dir) {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (SKIP.has(name)) continue;
    const rel = join(dir, name);
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) { walk(rel); continue; }
    if (!/\.(rs|ts|tsx|vue)$/.test(name)) continue;
    const lines = read(rel).split(/\r?\n/);
    lines.forEach((ln, i) => {
      if (RE.test(ln)) {
        const hit = `${rel.split(sep).join('/')}:${i + 1}: ${ln.trim().slice(0, 100)}`;
        (isGenerated(rel) ? expected : action).push(hit);
      }
    });
  }
}
for (const d of SCAN_DIRS) if (existsSync(join(ROOT, d))) walk(d);

console.log(`\n=== 完成：已修改 ${changed} 个文件 ===`);
console.log('\n[需手动处理 / vue-tsc 也会报错的剩余引用]');
console.log(action.length ? action.join('\n') : '  （无 —— 干净）');
console.log('\n[生成产物中的引用：重新生成 tauri 绑定后会自动消失，无需手改]');
console.log(expected.length ? expected.join('\n') : '  （无）');
console.log(`
后续：
  1) 重新生成 Tauri 绑定（你的 codegen，会刷新 src/bindings/tauri.ts 与 tauri.contracts.ts）
  2) cd src-tauri && cargo build && cargo test
  3) 前端 vue-tsc / 单测；若 [需手动处理] 列出了 useAiAssistant 的 analysis 入参处或 shellcheck 引用，把那几行贴回来，我直接给补丁。
`);
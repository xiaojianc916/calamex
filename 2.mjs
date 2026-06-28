#!/usr/bin/env node
// ==== EOL 归一 shim:必须在所有其它 import 之前 ====
import fs from 'node:fs'
const __rf = fs.readFileSync
const __wf = fs.writeFileSync
const __crlf = new Set()
fs.readFileSync = function (p, enc) {
	const s = __rf.call(fs, p, enc ?? 'utf8')
	if (typeof s === 'string') {
		if (s.includes('\r\n')) __crlf.add(String(p))
		return s.replace(/\r\n/g, '\n')
	}
	return s
}
fs.writeFileSync = function (p, data, opts) {
	let out = data
	if (typeof out === 'string' && __crlf.has(String(p))) out = out.replace(/\n/g, '\r\n')
	return __wf.call(fs, p, out, opts)
}
// ==== shim 结束 ====

// scripts/refactor/p5a-remove-orchestrate.mjs
//
// P5a — 删除 legacy `plan/orchestrate(+resume)` 私有扩展方法整条管线。
// (native plan mode 已取代它;feature-flag 后面,主聊天不走此路。)
//
// 保留:model/chat、warmup、checkpoint/restore、agent/chat(+resolve)、ask-user/resume、web/*、health。
// 只删除:plan/orchestrate 与 plan/orchestrate/resume 这一对重复的旧传输 + 其编排 runner/workflow/deps。
// CalamexAcpAgent / builtin-agent 自研 agent 本体完全保留。
//
// 事务性:所有编辑先在内存校验全通过才落盘;任一锚点失配 => 整体中止、零写入。
// 跑法(仓库根目录):  node scripts/refactor/p5a-remove-orchestrate.mjs
// 干跑(只校验不落盘):node scripts/refactor/p5a-remove-orchestrate.mjs --dry
// 全部可 `git revert` / `git checkout -- .` 回滚。

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

const ROOT = process.cwd();
const DRY = process.argv.includes("--dry");

// ---- repo-root sanity ----
for (const p of ["package.json", "src-tauri", "builtin-agent", "src"]) {
  if (!existsSync(join(ROOT, p))) {
    console.error(`✗ 这里不像仓库根目录(缺 ${p})。请在 calamex 根目录运行。`);
    process.exit(3);
  }
}

// ============================================================================
// 编辑表。op 类型:
//   { t:"replace",     find, repl, count? }     精确替换,出现次数必须 === count(默认 1)
//   { t:"cutBetween",  from, to }               删除 [from 起点, to 起点) 之间内容(含 from,不含 to)
//   { t:"cutFrom",     marker }                 从 marker 第一次出现处删到文件末尾
// ============================================================================
const EDITS = [
  { file: "builtin-agent/src/acp/ext-methods.ts", ops: [
    { t:"replace",
      find:" * - plan/orchestrate、plan/orchestrate/resume：原生计划编排（runtime.buildPlanOrchestrationWorkflow）\n *   的启动与挂起恢复；过程事件经会话的 session/update 流式下发，挂起/终态信封\n *   { runId, status, result } 作为方法返回值（由 acp/orchestration.ts 的 runner 执行）。\n",
      repl:"" },
    { t:"replace",
      find:"\tIAgentRuntimeInput,\n\tIAgentRuntimeModelConfigInput,\n\tICheckpointRestoreInput,\n",
      repl:"\tIAgentRuntimeInput,\n\tICheckpointRestoreInput,\n" },
    { t:"replace",
      find:"/** 原生计划编排扩展方法名（跑到挂起/终态，过程事件经 session/update 流式下发）。 */\nexport const ORCHESTRATE_METHOD = `${CALAMEX_EXT_NAMESPACE}/plan/orchestrate`\n/** 编排挂起点恢复扩展方法名（计划审批门 / 工具审批 / 逐步闸门通用）。 */\nexport const ORCHESTRATE_RESUME_METHOD = `${CALAMEX_EXT_NAMESPACE}/plan/orchestrate/resume`\n\n",
      repl:"" },
    { t:"replace",
      find:"\t\t\torchestrate: ORCHESTRATE_METHOD,\n\t\t\torchestrateResume: ORCHESTRATE_RESUME_METHOD,\n",
      repl:"" },
    { t:"cutFrom",
      marker:"/**\n * 执行模式 schema（interactive 人值守逐步 / autonomous 自主闭环）；缺省归一为 interactive，" },
  ]},

  { file: "builtin-agent/src/acp/agent.ts", ops: [
    { t:"replace", find:"\tORCHESTRATE_METHOD,\n\tORCHESTRATE_RESUME_METHOD,\n", repl:"" },
    { t:"replace", find:"\tparseOrchestrateParams,\n\tparseOrchestrateResumeParams,\n", repl:"" },
    { t:"replace", find:"\ttoOrchestrateExtResult,\n", repl:"" },
    { t:"replace",
      find:"import {\n\tAcpOrchestrationRunner,\n\ttype TOrchestrationEventSink,\n} from \"./orchestration.js\"\n",
      repl:"" },
    { t:"replace",
      find:"\t/** 原生计划编排 runner：持有运行中编排运行句柄与 TTL，支撑 orchestrate/resume 挂起恢复。 */\n\tprivate readonly orchestration: AcpOrchestrationRunner\n",
      repl:"" },
    { t:"replace", find:"\t\tthis.orchestration = new AcpOrchestrationRunner(runtime)\n", repl:"" },
    { t:"replace",
      find:"\t\t\tcase ORCHESTRATE_METHOD:\n\t\t\t\treturn this.handleOrchestrate(params)\n\t\t\tcase ORCHESTRATE_RESUME_METHOD:\n\t\t\t\treturn this.handleOrchestrateResume(params)\n",
      repl:"" },
    { t:"cutBetween",
      from:"\t/**\n\t * 受理原生计划编排启动扩展方法(plan/orchestrate)。编排不是 prompt 回合，不经会话登记表",
      to:"\t/**\n\t * 把一条运行时输出事件投影为 0..n 条 session/update 通知并下发。" },
  ]},

  { file: "builtin-agent/src/engines/runtime/runtime.ts", ops: [
    { t:"replace",
      find:"import type { TPlanOrchestrationWorkflow } from '../plan/orchestration-workflow.js';\n",
      repl:"" },
    { t:"replace",
      find:"    IAgentRuntimeInput,\n    IAgentRuntimeModelConfigInput,\n    IApprovalResolutionInput,\n",
      repl:"    IAgentRuntimeInput,\n    IApprovalResolutionInput,\n" },
    { t:"cutBetween",
      from:"    /**\n     * 可选：构建原生 Mastra 计划编排 workflow（Phase 2，默认关）。",
      to:"    /**\n     * 可选的优雅关闭钩子：释放运行时持有的长生命周期资源（如 MCP 子进程）。" },
  ]},

  { file: "builtin-agent/src/engines/runtime/composition.ts", ops: [
    { t:"replace",
      find:"import { createMastraPlanOrchestrationDeps } from '../plan/orchestration-deps.js';\n",
      repl:"" },
    { t:"replace",
      find:"import { PLAN_ORCHESTRATION_WORKFLOW_ID, createPlanOrchestrationWorkflow, type TPlanOrchestrationWorkflow } from '../plan/orchestration-workflow.js';\n",
      repl:"" },
    { t:"replace", find:"import { Mastra } from '@mastra/core/mastra';\n", repl:"" },
    { t:"cutBetween",
      from:"    /**\n     * Phase 2：构建原生 Mastra 计划编排 workflow（默认关，由 server.ts 的",
      to:"    /**\n     * 原始模型透传（仿 Zed 独立模型请求的 utility 用法：标题生成 / 行内补全 / 连接测试）。" },
  ]},

  { file: "src-tauri/src/acp/client.rs", ops: [
    { t:"cutBetween",
      from:"#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]\n#[serde(rename_all = \"camelCase\")]\n#[request(method = \"calamex.dev/plan/orchestrate\", response = Value)]\npub struct OrchestrateExtRequest {",
      to:"/// `calamex.dev/agent/chat` 扩展方法的单条消息。" },
    { t:"replace",
      find:"    Orchestrate {\n        request: OrchestrateExtRequest,\n        reply: oneshot::Sender<Result<Value, String>>,\n    },\n    OrchestrateResume {\n        request: OrchestrateResumeExtRequest,\n        reply: oneshot::Sender<Result<Value, String>>,\n    },\n",
      repl:"" },
    { t:"cutBetween",
      from:"    pub async fn orchestrate(\n        &self,\n        request: OrchestrateExtRequest,",
      to:"    /// 发起一轮 agent 模式对话(扩展方法 `calamex.dev/agent/chat`)." },
  ]},

  { file: "src-tauri/src/acp/host.rs", ops: [
    { t:"replace",
      find:"    AgentSidecarHealthPayload, AgentSidecarOrchestratePayload, AgentSidecarResponsePayload,\n",
      repl:"    AgentSidecarHealthPayload, AgentSidecarResponsePayload,\n" },
    { t:"replace",
      find:"    HealthExtRequest, ModelChatExtRequest, OrchestrateExtRequest, OrchestrateResumeExtRequest,\n    WarmupExtRequest, WebFetchExtRequest, WebSearchExtRequest, spawn_acp_client,\n",
      repl:"    HealthExtRequest, ModelChatExtRequest,\n    WarmupExtRequest, WebFetchExtRequest, WebSearchExtRequest, spawn_acp_client,\n" },
    { t:"cutBetween",
      from:"/// 一次 `orchestrate` 编排启动的宿主侧入参。",
      to:"/// 宿主侧 ACP 编排句柄。可作为 Tauri 托管状态长驻：内部协作件均为" },
    { t:"cutBetween",
      from:"    /// 启动一次原生计划编排（扩展方法 `calamex.dev/plan/orchestrate`）。",
      to:"    /// 发起一轮 agent 模式对话（扩展方法 `calamex.dev/agent/chat`）。" },
  ]},

  { file: "src-tauri/src/acp/mod.rs", ops: [
    { t:"replace",
      find:"    AcpHost, AcpOrchestrateResume, AcpOrchestrateStart, ApprovalEmitter, StreamEmitter,\n",
      repl:"    AcpHost, ApprovalEmitter, StreamEmitter,\n" },
  ]},

  { file: "src-tauri/src/commands/builtin_agent.rs", ops: [
    { t:"replace",
      find:"    AgentSidecarModelConfigPayload, AgentSidecarOrchestratePayload, AgentSidecarOrchestrateRequest,\n    AgentSidecarOrchestrateResumeRequest, AgentSidecarResponsePayload,\n",
      repl:"    AgentSidecarModelConfigPayload, AgentSidecarResponsePayload,\n" },
    { t:"cutBetween",
      from:"#[tauri::command]\n#[specta::specta]\npub async fn builtin_agent_orchestrate(\n    app: AppHandle,\n    payload: AgentSidecarOrchestrateRequest,",
      to:"#[cfg(test)]\nmod tests {" },
  ]},

  { file: "src-tauri/src/commands/contracts/mod.rs", ops: [
    { t:"replace", find:"mod agent_orchestration;\n", repl:"" },
    { t:"replace", find:"pub use agent_orchestration::*;\n", repl:"" },
  ]},

  { file: "src-tauri/src/tauri_bindings.rs", ops: [
    { t:"replace",
      find:"            builtin_agent::builtin_agent_orchestrate,\n            builtin_agent::builtin_agent_orchestrate_resume,\n",
      repl:"" },
  ]},

  { file: "src/services/tauri/sidecar.ts", ops: [
    { t:"replace",
      find:"  type AgentSidecarOrchestrateRequest_Deserialize,\n  type AgentSidecarOrchestrateResumeRequest_Deserialize,\n",
      repl:"" },
    { t:"replace",
      find:"  IAgentExternalChatResultPayload,\n  IAgentSidecarOrchestratePayload,\n  IAgentSidecarResponsePayload,\n",
      repl:"  IAgentExternalChatResultPayload,\n  IAgentSidecarResponsePayload,\n" },
    { t:"cutBetween",
      from:"  agentSidecarOrchestrate: {\n    command: 'builtin_agent_orchestrate',",
      to:"} satisfies Record<string, ICommandMeta>;" },
    { t:"replace",
      find:"  | 'agentSidecarOrchestrate'\n  | 'agentSidecarOrchestrateResume'\n",
      repl:"" },
    { t:"cutBetween",
      from:"  agentSidecarOrchestrate(payload, options?: IIpcCallOptions) {",
      to:"  async onAgentSidecarStream(handler) {" },
  ]},

  { file: "src/types/ai/sidecar.ts", ops: [
    { t:"replace",
      find:"import type { TAiExecutionMode } from '@/types/ai/execution-mode';\n",
      repl:"" },
    { t:"cutBetween",
      from:"/* ============================================================================\n * Native orchestration (orchestration workflow) request / response",
      to:"/* ============================================================================\n * 外部 ACP 编码 agent（Kimi / Codex，ADR-0015）发送契约" },
  ]},

  { file: "src/types/tauri/index.ts", ops: [
    { t:"replace",
      find:"  IAgentSidecarOrchestratePayload,\n  IAgentSidecarOrchestrateRequest,\n  IAgentSidecarOrchestrateResumeRequest,\n",
      repl:"" },
    { t:"cutBetween",
      from:"  agentSidecarOrchestrate(\n    payload: IAgentSidecarOrchestrateRequest,",
      to:"  onAgentSidecarStream(" },
  ]},
];

// 仅含编排的整文件 —— 直接删除。tolerant=true 的缺失即跳过(spec 可能本就不存在)。
const DELETIONS = [
  { p: "builtin-agent/src/acp/orchestration.ts" },
  { p: "builtin-agent/src/acp/orchestration-events.ts" },
  { p: "builtin-agent/src/engines/plan/orchestration-workflow.ts" },
  { p: "builtin-agent/src/engines/plan/orchestration-deps.ts" },
  { p: "src-tauri/src/commands/contracts/agent_orchestration.rs" },
  { p: "builtin-agent/src/acp/orchestration.spec.ts", tolerant: true },
  { p: "builtin-agent/src/acp/orchestration-events.spec.ts", tolerant: true },
  { p: "builtin-agent/src/engines/plan/orchestration-workflow.spec.ts", tolerant: true },
  { p: "builtin-agent/src/engines/plan/orchestration-deps.spec.ts", tolerant: true },
];

// ---- 残留扫描:剔除注释后扫 /orchestrat/i ----
const SCAN_DIRS = ["builtin-agent/src", "src-tauri/src", "src"];
const SCAN_EXTS = new Set([".ts", ".tsx", ".rs", ".js", ".mjs", ".vue"]);
const SCAN_EXCLUDE = ["src/bindings", "node_modules", "dist", "target", ".git"]; // bindings 由 tauri-specta 构建期再生成

// ============================================================================
function applyOp(content, op, label) {
  if (op.t === "replace") {
    const want = op.count ?? 1;
    let n = 0, i = 0;
    while ((i = content.indexOf(op.find, i)) !== -1) { n++; i += op.find.length; }
    if (n !== want) throw new Error(`replace 期望命中 ${want} 次,实际 ${n} 次 @ ${label}\n  片段: ${JSON.stringify(op.find.slice(0, 60))}…`);
    return content.split(op.find).join(op.repl);
  }
  if (op.t === "cutBetween") {
    const a = content.indexOf(op.from);
    if (a === -1) throw new Error(`cutBetween 起点未找到 @ ${label}\n  from: ${JSON.stringify(op.from.slice(0, 60))}…`);
    const b = content.indexOf(op.to, a + op.from.length);
    if (b === -1) throw new Error(`cutBetween 终点未找到 @ ${label}\n  to: ${JSON.stringify(op.to.slice(0, 60))}…`);
    return content.slice(0, a) + content.slice(b);
  }
  if (op.t === "cutFrom") {
    const a = content.indexOf(op.marker);
    if (a === -1) throw new Error(`cutFrom 标记未找到 @ ${label}\n  marker: ${JSON.stringify(op.marker.slice(0, 60))}…`);
    return content.slice(0, a).replace(/\s*$/, "") + "\n";
  }
  throw new Error(`未知 op 类型 ${op.t} @ ${label}`);
}

function stripComments(src, ext) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, " "); // 块注释
  return s.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n"); // 行注释(// //! /// 同理)
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full).split(sep).join("/");
    if (SCAN_EXCLUDE.some((ex) => rel === ex || rel.startsWith(ex + "/"))) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else { const dot = name.lastIndexOf("."); if (dot >= 0 && SCAN_EXTS.has(name.slice(dot))) out.push(full); }
  }
}

// ---------------- Phase 1:全量内存校验(零写入) ----------------
const staged = [];
const failures = [];
for (const { file, ops } of EDITS) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) { failures.push(`✗ 缺文件: ${file}`); continue; }
  let content = readFileSync(abs, "utf8");
  const before = content;
  try {
    for (let k = 0; k < ops.length; k++) content = applyOp(content, ops[k], `${file}#op${k + 1}`);
  } catch (e) { failures.push("✗ " + e.message); continue; }
  if (content === before) failures.push(`✗ 无变化(疑似已改/锚点漂移): ${file}`);
  else staged.push({ abs, file, content });
}

if (failures.length) {
  console.error("【中止】事务校验未通过,未写入任何文件:\n");
  console.error(failures.join("\n\n"));
  console.error("\n→ 多半是该文件你本地已改过,或树已漂移。手动核对上述片段后再跑。");
  process.exit(1);
}

// ---------------- Phase 2:落盘 + 删除 ----------------
if (DRY) {
  console.log("【dry-run】校验全部通过。将改写:");
  for (const s of staged) console.log("  ~ " + s.file);
  for (const d of DELETIONS) if (existsSync(join(ROOT, d.p))) console.log("  - " + d.p);
  console.log("\n去掉 --dry 即可落盘。");
} else {
  for (const s of staged) writeFileSync(s.abs, s.content, "utf8");
  for (const d of DELETIONS) {
    const abs = join(ROOT, d.p);
    if (existsSync(abs)) { rmSync(abs); console.log("  - 删除 " + d.p); }
    else if (!d.tolerant) { console.error(`✗ 应删但不存在: ${d.p}`); process.exit(1); }
  }
  for (const s of staged) console.log("  ~ 改写 " + s.file);
  console.log(`\n✓ 已应用 ${staged.length} 个文件编辑 + 删除整编排文件。`);
}

// ---------------- Phase 3:残留扫描门禁 ----------------
const hits = [];
for (const d of SCAN_DIRS) { const abs = join(ROOT, d); if (existsSync(abs)) walk(abs, []); }
const files = [];
for (const d of SCAN_DIRS) { const abs = join(ROOT, d); if (existsSync(abs)) walk(abs, files); }
const selfRel = "scripts/refactor/p5a-remove-orchestrate.mjs";
for (const f of files) {
  const rel = relative(ROOT, f).split(sep).join("/");
  if (rel === selfRel) continue;
  const stripped = stripComments(readFileSync(f, "utf8"), f);
  stripped.split("\n").forEach((line, i) => {
    if (/orchestrat/i.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}

if (hits.length) {
  console.error(`\n【残留门禁:未通过】仍有 ${hits.length} 处代码级 orchestrat 引用待清:\n`);
  console.error(hits.join("\n"));
  console.error("\n→ 已知会落在这里(超出我单次读取窗口的两处) + 任何前端调用方:");
  console.error("   • src-tauri/src/acp/client.rs  spawn_acp_client 命令循环里的 `Command::Orchestrate{..}` / `Command::OrchestrateResume{..}` 两条 match 臂");
  console.error("   • src-tauri/src/acp/client.rs  测试 `fn orchestrate_ext_request_serializes_to_camel_case_params()`");
  console.error("   • src/services/ipc/ai.service.ts  `sidecarOrchestrate` / `sidecarOrchestrateResume` 两个方法 + 顶部 3 个 IAgentSidecarOrchestrate* 类型 import");
  console.error("   • 若前端有 UI 调用 aiService.sidecarOrchestrate*,在此一并删除");
  console.error("   按上面 file:line 删干净后重跑此脚本,直到门禁通过(退出 0)。");
  process.exit(2);
}
console.log("\n✓ 残留门禁通过:src/ · src-tauri/src/ · builtin-agent/src/ 已无代码级 orchestrat 引用。");
console.log("  (src/bindings/tauri.ts 为生成文件,由构建期 tauri-specta 重新导出,勿手改。)");
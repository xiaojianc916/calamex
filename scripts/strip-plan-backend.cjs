#!/usr/bin/env node
// scripts/strip-plan-backend.cjs
// 一次性移除「旧 plan/execute HTTP 通道」：后端路由 + 对应集成测试（原子操作）。
// 只改动 agent-sidecar/src/server.ts 与 agent-sidecar/src/server.spec.ts。
// 不创建备份；UTF-8 读写；可重复运行（已应用则跳过）；任一标记异常则中止且不写盘。
// 保留：/agent/chat、/agent/warmup、/approval/resolve、/rollback/restore、
//       所有 /agent/plan/orchestrate*、/health、引擎方法、schema 校验测试、鉴权测试。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const SERVER = path.join(ROOT, 'agent-sidecar/src/server.ts');
const SPEC = path.join(ROOT, 'agent-sidecar/src/server.spec.ts');

function read(file) {
    if (!fs.existsSync(file)) {
        throw new Error(`[abort] 找不到文件：${file}（请在仓库根目录运行）`);
    }
    return fs.readFileSync(file, 'utf8');
}

// 精确单处替换；已应用则跳过；找不到且未应用则中止。
function replaceOnce(content, find, replace, label) {
    const count = content.split(find).length - 1;
    if (count === 1) {
        console.log(`[ok]   ${label}`);
        return content.replace(find, replace);
    }
    if (count === 0 && content.includes(replace)) {
        console.log(`[skip] ${label}（已应用）`);
        return content;
    }
    throw new Error(`[abort] ${label}：预期命中 1 处，实际 ${count} 处（且未检测到已应用状态）`);
}

// 删除 [startAnchor, endAnchor) 之间整段（含 startAnchor，不含 endAnchor）。
// startAnchor 已不存在则跳过；endAnchor 缺失或顺序异常则中止。
function cutBetween(content, startAnchor, endAnchor, label) {
    const startIdx = content.indexOf(startAnchor);
    if (startIdx === -1) {
        console.log(`[skip] ${label}（起始标记缺失，疑似已删除）`);
        return content;
    }
    const endIdx = content.indexOf(endAnchor);
    if (endIdx === -1) {
        throw new Error(`[abort] ${label}：找不到结束锚点`);
    }
    if (startIdx >= endIdx) {
        throw new Error(`[abort] ${label}：起始锚点位于结束锚点之后`);
    }
    console.log(`[ok]   ${label}`);
    return content.slice(0, startIdx) + content.slice(endIdx);
}

// ---------- server.ts ----------
let server = read(SERVER);

// 1) 裁剪 request-schemas 导入：移除 8 个仅被旧路由使用的 schema。
server = replaceOnce(
    server,
    `import {
  agentSidecarChatRequestSchema,
  agentSidecarExecuteRequestSchema,
  agentSidecarOrchestrateRequestSchema,
  agentSidecarOrchestrateResumeRequestSchema,
  agentSidecarPlanApproveRequestSchema,
  agentSidecarPlanFinishRequestSchema,
  agentSidecarPlanQueryRequestSchema,
  agentSidecarPlanRejectRequestSchema,
  agentSidecarPlanReplanRequestSchema,
  agentSidecarPlanRequestSchema,
  agentSidecarPlanValidateRequestSchema,
  agentSidecarRollbackRestoreRequestSchema,
  approvalResolutionSchema,
} from './server/request-schemas.js';`,
    `import {
  agentSidecarChatRequestSchema,
  agentSidecarOrchestrateRequestSchema,
  agentSidecarOrchestrateResumeRequestSchema,
  agentSidecarRollbackRestoreRequestSchema,
  approvalResolutionSchema,
} from './server/request-schemas.js';`,
    'server.ts: 裁剪 request-schemas 导入（移除 8 个 schema）',
);

// 2) 移除仅被 GET /agent/plan/ 使用的 handleRuntimeResponse 导入。
server = replaceOnce(
    server,
    `  handlePostStream,
  handleRuntimeResponse,
  handleWarmupPost,`,
    `  handlePostStream,
  handleWarmupPost,`,
    'server.ts: 移除 handleRuntimeResponse 导入',
);

// 3) 删除 GET /agent/plan/:id 查询路由（位于 /health 与 POST /agent/chat 之间）。
server = cutBetween(
    server,
    `if (request.method === 'GET' && parsedUrl.pathname.startsWith('/agent/plan/')) {`,
    `if (request.method === 'POST' && (url === '/agent/chat' || url === '/model/chat')) {`,
    'server.ts: 删除 GET /agent/plan/:id 路由',
);

// 4) 删除连续的旧 plan/execute POST 路由（/agent/plan … /agent/execute/stream），
//    保留其后的 /approval/resolve。
server = cutBetween(
    server,
    `if (request.method === 'POST' && url === '/agent/plan') {`,
    `if (request.method === 'POST' && url === '/approval/resolve') {`,
    'server.ts: 删除旧 plan/execute POST 路由（10 条）',
);

// ---------- server.spec.ts ----------
let spec = read(SPEC);

// 5) 删除唯一命中已删路由的 HTTP 集成测试（POST /agent/plan/query + GET /agent/plan/:id）。
//    其余 golden 测试命中保留路由（/agent/chat/stream、/agent/warmup、/health），全部保留。
spec = cutBetween(
    spec,
    `it('returns persisted plan records through POST and GET query routes', async () => {`,
    `it('reports injected runtime metadata on health without changing the protocol field', async () => {`,
    'server.spec.ts: 删除 plan 查询 HTTP 集成测试',
);

// ---------- 写盘 ----------
fs.writeFileSync(SERVER, server, 'utf8');
fs.writeFileSync(SPEC, spec, 'utf8');
console.log('\n完成。建议接着运行 sidecar 自检（见下文）。');
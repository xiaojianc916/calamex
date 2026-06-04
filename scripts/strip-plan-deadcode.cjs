#!/usr/bin/env node
'use strict';

// 清理 plan/execute 砍除后遗留的死代码：
//   - src-tauri/src/agent_sidecar/mod.rs            （8 个客户端函数 + 精简契约导入）
//   - src-tauri/src/commands/contracts/agent_sidecar.rs（8 个请求结构体 + 2 个 execute 测试）
//   - src/types/ai/sidecar.ts                       （8 个 plan/execute 请求接口）
//   - src/types/ai/sidecar.schema.ts                （对应的 zod schema）
// 不动编排（orchestrate）相关、不动 chat/approval/rollback/health 等保留路径。

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd();

function eol(content) {
    return content.includes('\r\n') ? '\r\n' : '\n';
}
function read(rel) {
    const p = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(p)) throw new Error(`[abort] 找不到文件：${rel}（请在仓库根目录运行）`);
    return fs.readFileSync(p, 'utf8');
}
function write(rel, content) {
    fs.writeFileSync(path.join(REPO_ROOT, rel), content);
}

// 多行查找替换：必须恰好命中 1 处；若已是目标状态则跳过（幂等）；否则中止。
function replaceOnce(content, find, replace, label) {
    if (content.includes(replace) && !content.includes(find)) {
        console.log(`  [skip] ${label}（已是目标状态）`);
        return content;
    }
    const count = content.split(find).length - 1;
    if (count !== 1) throw new Error(`[abort] ${label}：预期命中 1 处，实际 ${count} 处`);
    console.log(`  [ok]   ${label}`);
    return content.replace(find, replace);
}

// 删除 [startAnchor, endAnchor) 之间内容，保留 endAnchor。
// startAnchor 不存在 -> 视为已删除并跳过（幂等）；endAnchor 缺失/顺序异常 -> 中止。
function cutBetween(content, startAnchor, endAnchor, label) {
    const start = content.indexOf(startAnchor);
    if (start === -1) {
        console.log(`  [skip] ${label}（起点已不存在，视为已删除）`);
        return content;
    }
    const end = content.indexOf(endAnchor, start);
    if (end === -1 || end < start) throw new Error(`[abort] ${label}：未找到结束锚点或顺序异常`);
    console.log(`  [ok]   ${label}`);
    return content.slice(0, start) + content.slice(end);
}

// ── 1) src-tauri/src/agent_sidecar/mod.rs ──────────────────────────────────
console.log('mod.rs');
{
    const rel = 'src-tauri/src/agent_sidecar/mod.rs';
    let s = read(rel);
    const NL = eol(s);
    const j = (lines) => lines.join(NL);

    const importFind = j([
        'use crate::commands::contracts::{',
        '    AgentSidecarApprovalResolveRequest, AgentSidecarChatRequest,',
        '    AgentSidecarCheckpointRestoreRequest, AgentSidecarExecuteRequest, AgentSidecarHealthPayload,',
        '    AgentSidecarModelConfigPayload, AgentSidecarPlanApproveRequest, AgentSidecarPlanFinishRequest,',
        '    AgentSidecarPlanQueryRequest, AgentSidecarPlanRejectRequest, AgentSidecarPlanReplanRequest,',
        '    AgentSidecarPlanRequest, AgentSidecarPlanValidateRequest, AgentSidecarResponsePayload,',
        '    AgentSidecarWarmupPayload, AgentSidecarWarmupRequest, AiWebFetchInput, AiWebFetchPayload,',
        '    AiWebSearchInput, AiWebSearchPayload,',
        '};',
    ]);
    const importReplace = j([
        'use crate::commands::contracts::{',
        '    AgentSidecarApprovalResolveRequest, AgentSidecarChatRequest,',
        '    AgentSidecarCheckpointRestoreRequest, AgentSidecarHealthPayload,',
        '    AgentSidecarModelConfigPayload, AgentSidecarResponsePayload, AgentSidecarWarmupPayload,',
        '    AgentSidecarWarmupRequest, AiWebFetchInput, AiWebFetchPayload, AiWebSearchInput,',
        '    AiWebSearchPayload,',
        '};',
    ]);
    s = replaceOnce(s, importFind, importReplace, '精简契约导入（去掉 8 个未用类型）');

    // chat 与 resolve_approval 之间的 8 个函数连续，整段删除
    s = cutBetween(s, 'pub async fn plan(', 'pub async fn resolve_approval(',
        '删除 8 个 plan/execute 客户端函数');

    write(rel, s);
}

// ── 2) src-tauri/src/commands/contracts/agent_sidecar.rs ───────────────────
console.log('contracts/agent_sidecar.rs');
{
    const rel = 'src-tauri/src/commands/contracts/agent_sidecar.rs';
    let s = read(rel);
    const NL = eol(s);
    const j = (lines) => lines.join(NL);

    // 2a) 8 个连续结构体：PlanRequest .. PlanFinishRequest（保留 ApprovalResolveRequest）
    const structStart = j([
        '#[derive(Debug, Clone, Serialize, Deserialize, Type)]',
        '#[serde(rename_all = "camelCase")]',
        'pub struct AgentSidecarPlanRequest {',
    ]);
    const structEnd = j([
        '#[derive(Debug, Clone, Serialize, Deserialize, Type)]',
        '#[serde(rename_all = "camelCase")]',
        'pub struct AgentSidecarApprovalResolveRequest {',
    ]);
    s = cutBetween(s, structStart, structEnd, '删除 8 个 plan/execute 请求结构体');

    // 2b) 测试导入去掉 ExecuteRequest
    const testImportFind = j([
        '    use super::{',
        '        AgentSidecarChatRequest, AgentSidecarCheckpointRestoreRequest, AgentSidecarExecuteRequest,',
        '        AgentSidecarMessagePayload, AgentSidecarRollbackStepPath,',
        '    };',
    ]);
    const testImportReplace = j([
        '    use super::{',
        '        AgentSidecarChatRequest, AgentSidecarCheckpointRestoreRequest,',
        '        AgentSidecarMessagePayload, AgentSidecarRollbackStepPath,',
        '    };',
    ]);
    s = replaceOnce(s, testImportFind, testImportReplace, '测试导入去掉 ExecuteRequest');

    // 2c) 2 个 execute 契约测试（连续，保留其后的 restore_checkpoint 测试）
    const execTestStart = j([
        '    #[test]',
        '    fn execute_request_omits_absent_optional_fields() {',
    ]);
    const execTestEnd = j([
        '    #[test]',
        '    fn restore_checkpoint_request_omits_absent_optional_fields() {',
    ]);
    s = cutBetween(s, execTestStart, execTestEnd, '删除 2 个 execute 契约测试');

    write(rel, s);
}

// ── 3) src/types/ai/sidecar.ts ─────────────────────────────────────────────
console.log('sidecar.ts');
{
    const rel = 'src/types/ai/sidecar.ts';
    let s = read(rel);
    const NL = eol(s);
    // PlanRequest .. PlanFinishRequest 8 个接口连续，结束于 ApprovalResolve 的文档注释（保留）
    s = cutBetween(
        s,
        'export interface IAgentSidecarPlanRequest extends',
        '/**' + NL + ' * approval resolve',
        '删除 8 个 plan/execute 请求接口',
    );
    write(rel, s);
}

// ── 4) src/types/ai/sidecar.schema.ts ──────────────────────────────────────
console.log('sidecar.schema.ts');
{
    const rel = 'src/types/ai/sidecar.schema.ts';
    let s = read(rel);
    const NL = eol(s);
    // 同上，结束于 Approval resolve 文档注释（保留）
    s = cutBetween(
        s,
        'export const agentSidecarPlanRequestSchema = ',
        '/**' + NL + ' * Approval resolve',
        '删除 plan/execute 请求 schema',
    );
    write(rel, s);
}

console.log('\n完成。请运行验证：pnpm tsc --noEmit / cargo build / 相关测试。');
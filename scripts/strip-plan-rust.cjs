// scripts/strip-plan-rust.cjs
// 删除 Rust 侧 8 个 plan/execute 命令入口（本地操作，不推送、不留备份）
const fs = require('fs');
const path = require('path');
const root = process.cwd();

function read(rel) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) throw new Error(`找不到文件：${rel}`);
    return { abs, src: fs.readFileSync(abs, 'utf8') };
}

// ===== 1) src-tauri/src/commands/agent_sidecar.rs =====
{
    const { abs, src } = read('src-tauri/src/commands/agent_sidecar.rs');
    let out = src;

    // (a) 替换 import 块：去掉 8 个不再用到的请求类型
    const importOld =
        `use crate::commands::contracts::{
    AgentSidecarApprovalResolveRequest, AgentSidecarChatRequest,
    AgentSidecarCheckpointRestoreRequest, AgentSidecarExecuteRequest, AgentSidecarHealthPayload,
    AgentSidecarOrchestratePayload, AgentSidecarOrchestrateRequest,
    AgentSidecarOrchestrateResumeRequest, AgentSidecarPlanApproveRequest,
    AgentSidecarPlanFinishRequest, AgentSidecarPlanQueryRequest, AgentSidecarPlanRejectRequest,
    AgentSidecarPlanReplanRequest, AgentSidecarPlanRequest, AgentSidecarPlanValidateRequest,
    AgentSidecarResponsePayload, AgentSidecarWarmupPayload,
};`;
    const importNew =
        `use crate::commands::contracts::{
    AgentSidecarApprovalResolveRequest, AgentSidecarChatRequest,
    AgentSidecarCheckpointRestoreRequest, AgentSidecarHealthPayload,
    AgentSidecarOrchestratePayload, AgentSidecarOrchestrateRequest,
    AgentSidecarOrchestrateResumeRequest, AgentSidecarResponsePayload, AgentSidecarWarmupPayload,
};`;
    if (out.includes(importNew) && !out.includes(importOld)) {
        console.log('  - import 块已处理，跳过');
    } else {
        if (out.split(importOld).length - 1 !== 1) throw new Error('import 块未唯一匹配，已中止');
        out = out.replace(importOld, importNew);
        console.log('  - import 块已精简');
    }

    // (b) 删除 8 个命令函数（从 agent_sidecar_plan 到 agent_sidecar_execute，含其属性行）
    const fnStart = '#[tauri::command]\n#[specta::specta]\npub async fn agent_sidecar_plan(';
    const fnEnd = '#[tauri::command]\n#[specta::specta]\npub async fn agent_sidecar_resolve_approval(';
    const s = out.indexOf(fnStart);
    if (s === -1) {
        if (out.indexOf(fnEnd) !== -1) console.log('  - 8 个命令函数已删除，跳过');
        else throw new Error('找不到命令函数起点且终点缺失，已中止');
    } else {
        const e = out.indexOf(fnEnd, s);
        if (e === -1) throw new Error('找到命令函数起点但找不到终点，已中止');
        out = out.slice(0, s) + out.slice(e);
        console.log('  - 已删除 8 个命令函数');
    }

    // 校验：8 个命令名应全部消失，保留项仍在
    for (const n of ['agent_sidecar_plan(', 'agent_sidecar_plan_approve(', 'agent_sidecar_plan_query(',
        'agent_sidecar_plan_reject(', 'agent_sidecar_plan_finish(', 'agent_sidecar_plan_validate(',
        'agent_sidecar_plan_replan(', 'agent_sidecar_execute(']) {
        if (out.includes('pub async fn ' + n)) throw new Error(`仍残留命令函数：${n}`);
    }
    for (const keep of ['agent_sidecar_chat(', 'agent_sidecar_resolve_approval(',
        'agent_sidecar_restore_checkpoint(', 'agent_sidecar_orchestrate(', 'agent_sidecar_orchestrate_resume(']) {
        if (!out.includes('pub async fn ' + keep)) throw new Error(`误删了应保留的函数：${keep}`);
    }

    fs.writeFileSync(abs, out, 'utf8');
    console.log('  ✓ 已写回 src-tauri/src/commands/agent_sidecar.rs\n');
}

// ===== 2) src-tauri/src/tauri_bindings.rs =====
{
    const { abs, src } = read('src-tauri/src/tauri_bindings.rs');
    const remove = new Set([
        'agent_sidecar::agent_sidecar_plan,',
        'agent_sidecar::agent_sidecar_plan_approve,',
        'agent_sidecar::agent_sidecar_plan_query,',
        'agent_sidecar::agent_sidecar_plan_reject,',
        'agent_sidecar::agent_sidecar_plan_finish,',
        'agent_sidecar::agent_sidecar_plan_validate,',
        'agent_sidecar::agent_sidecar_plan_replan,',
        'agent_sidecar::agent_sidecar_execute,',
    ]);
    const lines = src.split('\n');
    const kept = lines.filter((l) => !remove.has(l.trim()));
    const removed = lines.length - kept.length;
    if (removed === 0 && !src.includes('agent_sidecar::agent_sidecar_plan,')) {
        console.log('  - collect_commands 已处理，跳过');
    } else if (removed !== 8) {
        throw new Error(`collect_commands 预期删 8 行，实际匹配 ${removed} 行，已中止`);
    } else {
        fs.writeFileSync(abs, kept.join('\n'), 'utf8');
        console.log('  ✓ 已从 collect_commands 删除 8 行登记\n');
    }
}

console.log('完成。下一步：cargo build 重新生成 src/bindings/tauri.ts，再跑 verify-ai-cutover.ps1。');
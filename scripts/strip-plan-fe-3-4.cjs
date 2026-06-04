// scripts/strip-plan-fe-3-4.cjs
// 删除 FE 第 3、第 4 个文件里的 8 个 plan/execute 入口（本地操作，不推送、不留备份）
const fs = require('fs');
const path = require('path');

const root = process.cwd();

// 从 startMarker（含）删到 endMarker（不含）。
// 找不到 start：若 end 还在，视为已删过，跳过；否则报错并中止（不写文件）。
function cut(src, label, startMarker, endMarker) {
    const start = src.indexOf(startMarker);
    if (start === -1) {
        if (src.indexOf(endMarker) !== -1) {
            console.log(`  - [${label}] 已删除，跳过`);
            return src;
        }
        throw new Error(`[${label}] 找不到起始锚点，且结束锚点也不存在——文件与预期不符，已中止`);
    }
    const end = src.indexOf(endMarker, start);
    if (end === -1) throw new Error(`[${label}] 找到起始锚点但找不到结束锚点，已中止`);
    const removed = src.slice(start, end);
    console.log(`  - [${label}] 删除 ${removed.split('\n').length - 1} 行`);
    return src.slice(0, start) + src.slice(end);
}

function processFile(relPath, edits) {
    const abs = path.join(root, relPath);
    if (!fs.existsSync(abs)) throw new Error(`找不到文件：${relPath}`);
    let src = fs.readFileSync(abs, 'utf8');
    console.log(`\n处理 ${relPath}`);
    for (const e of edits) src = cut(src, e.label, e.start, e.end);
    fs.writeFileSync(abs, src, 'utf8');
    console.log(`  ✓ 已写回 ${relPath}`);
}

// ============ 第 3 个：src/services/tauri.sidecar.ts ============
processFile('src/services/tauri.sidecar.ts', [
    {
        label: '8 个 const *Ipc 定义',
        start: 'const agentSidecarPlanIpc = (',
        end: 'const agentSidecarResolveApprovalIpc = (',
    },
    {
        label: 'Pick<> 联合类型里的 8 行',
        start: "  | 'agentSidecarPlan'\n",
        end: "  | 'agentSidecarResolveApproval'",
    },
    {
        label: 'sidecarTauriService 对象里的 8 个键',
        start: '  agentSidecarPlan: agentSidecarPlanIpc,',
        end: '  agentSidecarResolveApproval: agentSidecarResolveApprovalIpc,',
    },
]);

// ============ 第 4 个：src/services/tauri.spec.ts ============
processFile('src/services/tauri.spec.ts', [
    {
        label: "删除 'agentSidecarPlan accepts persisted plan_ready payload' 测试",
        start: "  it('agentSidecarPlan accepts persisted plan_ready payload', async () => {",
        end: "  it('agentSidecarRestart invokes the restart command and validates health payload', async () => {",
    },
]);

console.log('\n全部完成。');
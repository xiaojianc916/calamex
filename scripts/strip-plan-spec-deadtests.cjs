// scripts/strip-plan-spec-deadtests.cjs
// 用途：① 清理 useAiAssistant.spec.ts 里残留的旧「手动计划/执行」测试脚手架；
//      ② 顺手补全回滚(AED)造数据工具缺的新字段，让本文件 tsc 通过。
// 只动这一个文件。仓库根目录运行：node scripts/strip-plan-spec-deadtests.cjs
const fs = require('fs');
const path = require('path');

const FILE = path.join('src', 'composables', 'ai', 'useAiAssistant.spec.ts');
const log = [];

function read(p) {
    if (!fs.existsSync(p)) throw new Error('找不到文件: ' + p);
    return fs.readFileSync(p, 'utf8');
}

// 删除从 startAnchor 所在行 到 endAnchor 所在行（不含）之间的整段
function cutBlock(content, startAnchor, endAnchor, label) {
    const s = content.indexOf(startAnchor);
    if (s === -1) { log.push('[skip] ' + label + '（未找到起点，可能已清理）'); return content; }
    const e = content.indexOf(endAnchor, s + startAnchor.length);
    if (e === -1) throw new Error('找到起点但找不到终点，已中止: ' + label);
    const lineStart = content.lastIndexOf('\n', s) + 1;
    const endLineStart = content.lastIndexOf('\n', e) + 1;
    if (endLineStart <= lineStart) throw new Error('区间异常，已中止: ' + label);
    log.push('[cut ] ' + label);
    return content.slice(0, lineStart) + content.slice(endLineStart);
}

// 按整行删除（全局）并校验出现次数
function removeLines(content, regex, label, expected) {
    const m = content.match(regex);
    const count = m ? m.length : 0;
    if (count === 0) { log.push('[skip] ' + label + '（0 处，可能已清理）'); return content; }
    if (expected != null && count !== expected)
        throw new Error(label + ' 期望 ' + expected + ' 处，实际 ' + count + ' 处，已中止');
    log.push('[del ] ' + label + '（' + count + ' 处）');
    return content.replace(regex, '');
}

function replaceAll(content, find, replace, label) {
    if (!content.includes(find)) { log.push('[skip] ' + label + '（未找到，可能已替换）'); return content; }
    const n = content.split(find).length - 1;
    log.push('[repl] ' + label + '（' + n + ' 处）');
    return content.split(find).join(replace);
}

// 在唯一锚点处插入（CRLF 安全：复用捕获到的换行）
function insertOnce(content, regex, replacement, label) {
    const g = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    const m = content.match(g);
    const count = m ? m.length : 0;
    if (count === 0) { log.push('[skip] ' + label + '（未找到，可能已修复）'); return content; }
    if (count !== 1) throw new Error(label + ' 期望 1 处，实际 ' + count + ' 处，已中止');
    log.push('[fix ] ' + label);
    return content.replace(regex, replacement);
}

let c = read(FILE);

// ===== 第一部分：plan-mode 旧脚手架清理 =====

// 1) 删掉一整段连续旧脚手架：planTask + createSidecarPlanResponse + sidecarPlan + sidecarPlanQuery
c = cutBlock(
    c,
    'const planTask = vi.fn(async () => ({',
    'const createSidecarExecuteResponse = (goal: string',
    '旧 planTask / createSidecarPlanResponse / sidecarPlan / sidecarPlanQuery 段',
);

// 2) 删掉旧的 approvePlan mock（终点是 mock 对象的 return {）
c = cutBlock(c, 'const approvePlan = vi.fn(async () => ({', 'return {', '旧 approvePlan mock');

// 3) 已删类型 IAgentSidecarExecuteRequest 全部换成现行 IAgentSidecarChatRequest
c = replaceAll(c, 'IAgentSidecarExecuteRequest', 'IAgentSidecarChatRequest',
    'IAgentSidecarExecuteRequest -> IAgentSidecarChatRequest');

// 4) createSidecarExecuteResponse 入参放宽（ChatRequest.goal 可选）
c = replaceAll(c,
    'const createSidecarExecuteResponse = (goal: string):',
    'const createSidecarExecuteResponse = (goal: string | undefined):',
    'createSidecarExecuteResponse 入参放宽');

// 5) import 里移除另外两个已删类型
c = removeLines(c, /^[ \t]*IAgentSidecarPlanQueryRequest,[ \t]*\r?\n/gm, 'import: PlanQueryRequest', 1);
c = removeLines(c, /^[ \t]*IAgentSidecarPlanRequest,[ \t]*\r?\n/gm, 'import: PlanRequest', 1);

// 6) mock 返回对象里移除旧字段
c = removeLines(c, /^[ \t]*planTask,[ \t]*\r?\n/gm, 'return: planTask', 1);
c = removeLines(c, /^[ \t]*sidecarPlan,[ \t]*\r?\n/gm, 'return: sidecarPlan', 1);
c = removeLines(c, /^[ \t]*sidecarPlanQuery,[ \t]*\r?\n/gm, 'return: sidecarPlanQuery', 1);
c = removeLines(c, /^[ \t]*approvePlan,[ \t]*\r?\n/gm, 'return: approvePlan', 1);

// 7) vi.mock 映射里移除旧方法
c = removeLines(c, /^[ \t]*planTask: aiServiceMock\.planTask,[ \t]*\r?\n/gm, 'vi.mock: planTask', 1);
c = removeLines(c, /^[ \t]*sidecarPlan: aiServiceMock\.sidecarPlan,[ \t]*\r?\n/gm, 'vi.mock: sidecarPlan', 1);
c = removeLines(c, /^[ \t]*sidecarPlanQuery: aiServiceMock\.sidecarPlanQuery,[ \t]*\r?\n/gm, 'vi.mock: sidecarPlanQuery', 1);
c = removeLines(c, /^[ \t]*approvePlan: aiServiceMock\.approvePlan,[ \t]*\r?\n/gm, 'vi.mock: approvePlan', 1);

// 8) reset() 里移除旧 mockClear
c = removeLines(c, /^[ \t]*planTask\.mockClear\(\);[ \t]*\r?\n/gm, 'reset: planTask', 1);
c = removeLines(c, /^[ \t]*sidecarPlan\.mockClear\(\);[ \t]*\r?\n/gm, 'reset: sidecarPlan', 1);
c = removeLines(c, /^[ \t]*sidecarPlanQuery\.mockClear\(\);[ \t]*\r?\n/gm, 'reset: sidecarPlanQuery', 1);
c = removeLines(c, /^[ \t]*approvePlan\.mockClear\(\);[ \t]*\r?\n/gm, 'reset: approvePlan', 1);

// 9) 测试体里移除「断言旧方法未被调用」的废行（各 2 处）
c = removeLines(c, /^[ \t]*expect\(aiServiceMock\.sidecarPlan\)\.toHaveBeenCalledTimes\(0\);[ \t]*\r?\n/gm, 'assert: sidecarPlan 未调用', 2);
c = removeLines(c, /^[ \t]*expect\(aiServiceMock\.planTask\)\.toHaveBeenCalledTimes\(0\);[ \t]*\r?\n/gm, 'assert: planTask 未调用', 2);

// ===== 第二部分：补全回滚(AED)造数据工具缺的新字段（存量红，与本次清理无关）=====

// 10) IAiSnapshot 新增 contentAvailable + pinned：插在 createAiEditSnapshot 的 sizeBytes 与 }); 之间
c = insertOnce(
    c,
    /( {2}sizeBytes: 0,)(\r?\n)(\}\);)/,
    '$1$2  contentAvailable: true,$2  pinned: false,$2$3',
    'createAiEditSnapshot 补 contentAvailable/pinned',
);

// 11) IAiEditOperation 新增 pinned：插在 createAiEditOperation 的 toolCallId 与 ...overrides 之间
c = insertOnce(
    c,
    /( {2}toolCallId: null,)(\r?\n)( {2}\.\.\.overrides,)/,
    '$1$2  pinned: false,$2$3',
    'createAiEditOperation 补 pinned',
);

fs.writeFileSync(FILE, c, 'utf8');
console.log('已更新 ' + FILE + '\n' + log.join('\n'));
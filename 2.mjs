#!/usr/bin/env node
// fix-ai-review-batch-4.mjs
// 批次 4：B1（createRuntimePreview 早停）、C1（restoreCheckpoint failRestore 去重）、D（删失效注释）
// 在仓库根目录运行：node fix-ai-review-batch-4.mjs
// 改动均为行为等价 / 纯注释清理，幂等，自动适配 CRLF/LF。

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const eolOf = (s) => (s.includes("\r\n") ? "\r\n" : "\n");

function replaceBlock(rel, oldLines, newLines, label) {
    const file = resolve(ROOT, rel);
    const s = readFileSync(file, "utf8");
    const eol = eolOf(s);
    const oldStr = oldLines.join(eol);
    const newStr = newLines.join(eol);
    const n = s.split(oldStr).length - 1;
    if (n === 0) {
        if (s.includes(newStr)) {
            console.log(`= 跳过（已是目标态）：${label}`);
            return;
        }
        throw new Error(`未找到锚点，源码可能已变动：${label} @ ${rel}`);
    }
    if (n > 1) throw new Error(`锚点应唯一，实际 ${n} 次：${label} @ ${rel}`);
    writeFileSync(file, s.replace(oldStr, newStr));
    console.log(`✓ 已修改：${label}`);
}

function insertAfter(rel, anchorLines, insertLines, marker, label) {
    const file = resolve(ROOT, rel);
    const s = readFileSync(file, "utf8");
    const eol = eolOf(s);
    if (s.includes(marker)) {
        console.log(`= 跳过（已插入）：${label}`);
        return;
    }
    const anchor = anchorLines.join(eol);
    const n = s.split(anchor).length - 1;
    if (n === 0) throw new Error(`未找到插入锚点：${label} @ ${rel}`);
    if (n > 1) throw new Error(`插入锚点应唯一，实际 ${n} 次：${label} @ ${rel}`);
    const insert = insertLines.join(eol);
    writeFileSync(file, s.replace(anchor, `${anchor}${eol}${eol}${insert}`));
    console.log(`✓ 已插入：${label}`);
}

const UTILS = "builtin-agent/src/engines/shared/utils.ts";
const COMPOSITION = "builtin-agent/src/engines/runtime/composition.ts";

// ---------------------------------------------------------------------------
// B1：createRuntimePreview —— 有界早停替代对整段字符串 Array.from 码位物化
// 行为等价：码位数 <= limit 时原样返回；否则取前 limit 个码位 + "..."。
// ---------------------------------------------------------------------------
replaceBlock(
    UTILS,
    [
        "    const characters = Array.from(normalized);",
        "    const clipped = characters.length <= limit",
        "        ? normalized",
        "        : `${characters.slice(0, limit).join('')}...`;",
        "",
        "    return clipped;",
    ],
    [
        "    // 只扫描到第 limit 个码位即可判定是否需要截断，避免对超长 tool 预览整段物化成码位数组。",
        "    const prefix: string[] = [];",
        "    let truncated = false;",
        "    for (const char of normalized) {",
        "        if (prefix.length >= limit) {",
        "            truncated = true;",
        "            break;",
        "        }",
        "        prefix.push(char);",
        "    }",
        "",
        "    return truncated ? `${prefix.join('')}...` : normalized;",
    ],
    "B1 createRuntimePreview 有界早停",
);

// ---------------------------------------------------------------------------
// C1：restoreCheckpoint —— 5 处 rollback.restore.failed 模板抽成 failRestore
// 所有分支的返回串都是 `Mastra 回滚恢复失败：` + errorMessage，统一收口。
// ---------------------------------------------------------------------------
replaceBlock(
    COMPOSITION,
    [
        "                pushUiEvent(events, createRuntimeEvent({",
        "                    type: 'rollback.restore.failed',",
        "                    visibility: 'user',",
        "                    level: 'error',",
        "                    snapshotId,",
        "                    errorMessage: '未找到可恢复的 checkpoint。',",
        "                }), options);",
        "",
        "                return createErrorResponse(",
        "                    sessionId,",
        "                    'Mastra 回滚恢复失败：未找到可恢复的 checkpoint。',",
        "                    events,",
        "                    options,",
        "                );",
    ],
    ["                return failRestore('未找到可恢复的 checkpoint。');"],
    "C1 failRestore 调用①",
);
replaceBlock(
    COMPOSITION,
    [
        "                pushUiEvent(events, createRuntimeEvent({",
        "                    type: 'rollback.restore.failed',",
        "                    visibility: 'user',",
        "                    level: 'error',",
        "                    snapshotId,",
        "                    errorMessage: '当前 run 仍在执行，暂时不能回滚。',",
        "                }), options);",
        "",
        "                return createErrorResponse(",
        "                    sessionId,",
        "                    'Mastra 回滚恢复失败：当前 run 仍在执行，暂时不能回滚。',",
        "                    events,",
        "                    options,",
        "                );",
    ],
    ["                return failRestore('当前 run 仍在执行，暂时不能回滚。');"],
    "C1 failRestore 调用②",
);
replaceBlock(
    COMPOSITION,
    [
        "                pushUiEvent(events, createRuntimeEvent({",
        "                    type: 'rollback.restore.failed',",
        "                    visibility: 'user',",
        "                    level: 'error',",
        "                    snapshotId,",
        "                    errorMessage: 'checkpoint 缺少可恢复的系统提示词。',",
        "                }), options);",
        "",
        "                return createErrorResponse(",
        "                    sessionId,",
        "                    'Mastra 回滚恢复失败：checkpoint 缺少可恢复的系统提示词。',",
        "                    events,",
        "                    options,",
        "                );",
    ],
    ["                return failRestore('checkpoint 缺少可恢复的系统提示词。');"],
    "C1 failRestore 调用③",
);
replaceBlock(
    COMPOSITION,
    [
        "                pushUiEvent(events, createRuntimeEvent({",
        "                    type: 'rollback.restore.failed',",
        "                    visibility: 'user',",
        "                    level: 'error',",
        "                    snapshotId,",
        "                    errorMessage: normalizeMastraError(error),",
        "                }), options);",
        "",
        "                return createErrorResponse(",
        "                    sessionId,",
        "                    `Mastra 回滚恢复失败：${normalizeMastraError(error)}`,",
        "                    events,",
        "                    options,",
        "                );",
    ],
    ["                return failRestore(normalizeMastraError(error));"],
    "C1 failRestore 调用④（内层 catch）",
);
replaceBlock(
    COMPOSITION,
    [
        "            pushUiEvent(events, createRuntimeEvent({",
        "                type: 'rollback.restore.failed',",
        "                visibility: 'user',",
        "                level: 'error',",
        "                snapshotId,",
        "                errorMessage: normalizeMastraError(error),",
        "            }), options);",
        "",
        "            return createErrorResponse(",
        "                sessionId,",
        "                `Mastra 回滚恢复失败：${normalizeMastraError(error)}`,",
        "                events,",
        "                options,",
        "            );",
    ],
    ["            return failRestore(normalizeMastraError(error));"],
    "C1 failRestore 调用⑤（外层 catch）",
);
// 注入 failRestore 闭包（在 createRuntimeEvent 声明之后；仅 restoreCheckpoint 含该声明，唯一）
insertAfter(
    COMPOSITION,
    [
        "        const createRuntimeEvent = createRuntimeEventFactory({",
        "            runId: input.runId,",
        "            sessionId,",
        "            agentId: DEFAULT_EXECUTION_AGENT_ID,",
        "            ...(this.now ? { now: this.now } : {}),",
        "        });",
    ],
    [
        "        const failRestore = (errorMessage: string): IAgentRuntimeResponse => {",
        "            pushUiEvent(events, createRuntimeEvent({",
        "                type: 'rollback.restore.failed',",
        "                visibility: 'user',",
        "                level: 'error',",
        "                snapshotId,",
        "                errorMessage,",
        "            }), options);",
        "",
        "            return createErrorResponse(",
        "                sessionId,",
        "                `Mastra 回滚恢复失败：${errorMessage}`,",
        "                events,",
        "                options,",
        "            );",
        "        };",
        "",
    ],
    "const failRestore =",
    "C1 注入 failRestore 闭包",
);

// ---------------------------------------------------------------------------
// D：删除 modelChat 注释里指向「已删文件 + 不存在函数 + 不存在路径」的失效说明
// ---------------------------------------------------------------------------
replaceBlock(
    COMPOSITION,
    [
        "     * 非流式：utility 调用要的是完整结果，故用 agent.generate 而非 stream。",
        "     * DeepSeek reasoning 透传 shim 仅在回放「带 tool_calls 的 assistant 消息」时生效，",
        "     * 本路径无工具调用，故无需 runWithDeepSeekReasoningContext 包裹",
        "     * （见 models/providers/deepseek-reasoning-fetch.ts）。",
        "     */",
    ],
    [
        "     * 非流式：utility 调用要的是完整结果，故用 agent.generate 而非 stream。",
        "     */",
    ],
    "D 删除失效的 DeepSeek reasoning shim 注释",
);

console.log("\n批次 4 完成。请运行：pnpm -C builtin-agent typecheck && pnpm -C builtin-agent test");
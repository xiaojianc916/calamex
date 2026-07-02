// scripts/fix-p4-tooluseid.mjs   用法：node 1.mjs
// P4: (1) tool-error 事件补回 toolUseId（从 FIFO 队列恢复，纯附加，且修复原队列泄漏）
//     (2) IAgentToolStartedEvent.toolUseId 收紧为必填（isToolCallChunk 守卫已保证恒有值）
// 自动对齐 CRLF/LF 行尾，锚点匹配不上会大声报错、绝不静默改坏。
import { readFile, writeFile } from "node:fs/promises"

const detectEol = (t) => (t.includes("\r\n") ? "\r\n" : "\n")
const toEol = (s, e) => s.replace(/\n/g, e)

async function patch(path, edits) {
  let text = await readFile(path, "utf8")
  const eol = detectEol(text)
  for (const { old, next, label } of edits) {
    const o = toEol(old, eol)
    if (!text.includes(o)) {
      console.error(`❌ 未找到锚点（${label}），请手动核对：`, path)
      process.exit(1)
    }
    text = text.replace(o, toEol(next, eol))
    console.log(`✅ ${label}`)
  }
  await writeFile(path, text, "utf8")
}

// ---- (1) base.ts：tool-error 分支从 FIFO 队列恢复 toolUseId ----
const OLD_ERR = `if (isToolErrorChunk(chunk)) {
                const errorMessage = normalizeMastraError(chunk.payload.error);

                if (createRuntimeEvent) {
                    pushUiEvent(events, createRuntimeEvent({
                        type: 'agent.tool.completed',
                        visibility: 'user',
                        level: 'error',
                        toolName: chunk.payload.toolName,
                        ok: false,
                        errorMessage,
                    }), options);
                }
                continue;
            }`

const NEW_ERR = `if (isToolErrorChunk(chunk)) {
                const errorMessage = normalizeMastraError(chunk.payload.error);
                // 与 tool-result 同源：从按名 FIFO 队列出队恢复 toolCallId，使失败状态挂到正确的
                // tool_call（同名并发也不串台），顺带回收原本永不出队的泄漏条目。
                const pendingToolErrorIds = pendingToolCallIdsByName.get(chunk.payload.toolName) ?? [];
                const queuedToolErrorId = pendingToolErrorIds.shift();
                if (pendingToolErrorIds.length === 0) {
                    pendingToolCallIdsByName.delete(chunk.payload.toolName);
                }
                const toolErrorUseId =
                    (chunk.payload as { toolCallId?: string }).toolCallId ?? queuedToolErrorId;

                if (createRuntimeEvent) {
                    pushUiEvent(events, createRuntimeEvent({
                        type: 'agent.tool.completed',
                        visibility: 'user',
                        level: 'error',
                        toolName: chunk.payload.toolName,
                        ok: false,
                        ...(toolErrorUseId ? { toolUseId: toolErrorUseId } : {}),
                        errorMessage,
                    }), options);
                }
                continue;
            }`

await patch("builtin-agent/src/engines/runtime/base.ts", [
  { old: OLD_ERR, next: NEW_ERR, label: "(1) base.ts：tool-error 事件已恢复 toolUseId（FIFO 出队 + 修复队列泄漏）" },
])

// ---- (2) stream-types.ts：started.toolUseId 收紧为必填 ----
await patch("builtin-agent/src/streaming/stream-types.ts", [
  {
    old: "type: 'agent.tool.started';\n  toolUseId?: string;",
    next: "type: 'agent.tool.started';\n  toolUseId: string;",
    label: "(2) stream-types.ts：IAgentToolStartedEvent.toolUseId 收紧为必填 string",
  },
])

console.log("➡️ 跑一遍 `pnpm -C builtin-agent tsc`（或你的构建）确认无回归。")
// fix-ai-review-batch-3.mjs  (A7：移除 reasoning 兼容垫片；CRLF 兼容；幂等)
// 在仓库根目录执行：node fix-ai-review-batch-3.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (rel) => readFileSync(join(root, rel), "utf8");
const write = (rel, s) => writeFileSync(join(root, rel), s);
const eolOf = (s) => (s.includes("\r\n") ? "\r\n" : "\n");

function replaceBlock(rel, oldLines, newLines, label) {
  const s = read(rel);
  const eol = eolOf(s);
  const oldStr = oldLines.join(eol);
  const newStr = newLines.join(eol);
  const n = s.split(oldStr).length - 1;
  if (n === 0) {
    if (s.includes(newStr)) {
      console.log(`[skip] ${label}（已应用）`);
      return;
    }
    throw new Error(`未找到锚点: ${label} @ ${rel}`);
  }
  if (n > 1) throw new Error(`锚点出现 ${n} 次(应唯一): ${label} @ ${rel}`);
  write(rel, s.replace(oldStr, newStr));
  console.log(`[fix] ${label}`);
}

const TYPES = "builtin-agent/src/engines/shared/types.ts";
const UTILS = "builtin-agent/src/engines/stream/stream-utils.ts";

// (1) types.ts：清理 import 里不再使用的 ReasoningDeltaPayload。
replaceBlock(
  TYPES,
  ["import type { AgentChunkType, DataChunkType, DynamicToolResultPayload, ReasoningDeltaPayload, ToolResultPayload } from '@mastra/core/stream';"],
  ["import type { AgentChunkType, DataChunkType, DynamicToolResultPayload, ToolResultPayload } from '@mastra/core/stream';"],
  "A7: types.ts 移除未用的 ReasoningDeltaPayload import",
);

// (2) types.ts：删除整段 TCompatibleReasoningDeltaChunk（连同其后换行），保留下一行类型。
replaceBlock(
  TYPES,
  [
    "export type TCompatibleReasoningDeltaChunk = TMastraReasoningDeltaChunk & {",
    "    payload: ReasoningDeltaPayload & {",
    "        reasoningText?: string;",
    "        delta?: string;",
    "        reasoning_content?: string;",
    "        reasoningContent?: string;",
    "    };",
    "};",
    "export type TCompatibleToolResultPayload = ToolResultPayload | DynamicToolResultPayload;",
  ],
  [
    "export type TCompatibleToolResultPayload = ToolResultPayload | DynamicToolResultPayload;",
  ],
  "A7: types.ts 删除 TCompatibleReasoningDeltaChunk",
);

// (3) stream-utils.ts：import 改引官方 TMastraReasoningDeltaChunk。
replaceBlock(
  UTILS,
  ["type TCompatibleReasoningDeltaChunk"],
  ["type TMastraReasoningDeltaChunk"],
  "A7: stream-utils.ts import 改用 TMastraReasoningDeltaChunk",
);

// (4) stream-utils.ts：类型谓词改用官方类型。
replaceBlock(
  UTILS,
  ["): chunk is TCompatibleReasoningDeltaChunk => chunk.type === 'reasoning-delta';"],
  ["): chunk is TMastraReasoningDeltaChunk => chunk.type === 'reasoning-delta';"],
  "A7: stream-utils.ts isReasoningDeltaChunk 谓词",
);

// (5) stream-utils.ts：getReasoningDelta 收敛到官方 text 一路。
replaceBlock(
  UTILS,
  [
    "export const getReasoningDelta = (chunk: TMastraStreamChunk): string | null => {",
    "    if (isReasoningDeltaChunk(chunk)) {",
    "        return chunk.payload.text",
    "            ?? chunk.payload.reasoningText",
    "            ?? chunk.payload.delta",
    "            ?? chunk.payload.reasoning_content",
    "            ?? chunk.payload.reasoningContent",
    "            ?? null;",
    "    }",
    "",
    "    return null;",
    "};",
  ],
  [
    "export const getReasoningDelta = (chunk: TMastraStreamChunk): string | null =>",
    "    isReasoningDeltaChunk(chunk) ? (chunk.payload.text ?? null) : null;",
  ],
  "A7: stream-utils.ts getReasoningDelta 收敛单路",
);

console.log("\n全部完成。建议执行：pnpm -C builtin-agent typecheck && pnpm -C builtin-agent test");
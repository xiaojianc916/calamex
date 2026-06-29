// fix-ai-review-batch-2.mjs  (A3 + A6；兼容 Windows CRLF；幂等)
// 在仓库根目录执行：node fix-ai-review-batch-2.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (rel) => readFileSync(join(root, rel), "utf8");
const write = (rel, s) => writeFileSync(join(root, rel), s);
const eolOf = (s) => (s.includes("\r\n") ? "\r\n" : "\n");

// 替换一段连续文本（幂等：原锚点已消失但新文本已存在则跳过）。
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

// 在锚点之后插入文本（幂等：marker 已存在则跳过）。
function insertAfter(rel, anchorLines, insertLines, marker, label) {
  const s = read(rel);
  const eol = eolOf(s);
  if (s.includes(marker)) {
    console.log(`[skip] ${label}（已应用）`);
    return;
  }
  const anchor = anchorLines.join(eol);
  const n = s.split(anchor).length - 1;
  if (n === 0) throw new Error(`未找到锚点: ${label} @ ${rel}`);
  if (n > 1) throw new Error(`锚点出现 ${n} 次(应唯一): ${label} @ ${rel}`);
  write(rel, s.replace(anchor, anchor + eol + eol + insertLines.join(eol)));
  console.log(`[fix] ${label}`);
}

// ════════ A3：acp/agent.ts —— 抽取 buildExtRunOptions 消除 5 处重复 ════════
const AGENT = "builtin-agent/src/acp/agent.ts";

// (1) 在 extMethod 之后插入私有 helper。
insertAfter(
  AGENT,
  [
    "\t\t\tdefault:",
    "\t\t\t\tthrow RequestError.methodNotFound(method)",
    "\t\t}",
    "\t}",
  ],
  [
    "\t/**",
    "\t * 构造一次带外（非 prompt 回合）运行时调用的 run options：调用作用域的",
    "\t * AbortController + 逐次新生 requestId + advisory 超时；携带 sessionId 时附加",
    "\t * onEvent 投影（实时预览下发），否则不投影。抽出以消除各扩展 handler 间重复（A3）。",
    "\t */",
    "\tprivate buildExtRunOptions(sessionId?: string): IAgentRuntimeRunOptions {",
    "\t\tconst controller = new AbortController()",
    "\t\treturn {",
    "\t\t\tcontext: {",
    "\t\t\t\trequestId: this.generateRequestId(),",
    "\t\t\t\tsignal: controller.signal,",
    "\t\t\t\ttimeoutMs: this.turnTimeoutMs,",
    "\t\t\t},",
    "\t\t\t...(sessionId !== undefined",
    "\t\t\t\t? {",
    "\t\t\t\t\t\tonEvent: (event: TAgentRuntimeOutputEvent) =>",
    "\t\t\t\t\t\t\tthis.emitOutputEvent(sessionId, event),",
    "\t\t\t\t\t}",
    "\t\t\t\t: {}),",
    "\t\t}",
    "\t}",
  ],
  "private buildExtRunOptions(",
  "A3: agent.ts 插入 buildExtRunOptions helper",
);

// (2) 替换 5 个 handler 中重复的 run-options 构造。
const OPTS_SESSION = [
  "\t\tconst controller = new AbortController()",
  "\t\tconst { sessionId } = input",
  "\t\tconst options: IAgentRuntimeRunOptions = {",
  "\t\t\tcontext: {",
  "\t\t\t\trequestId: this.generateRequestId(),",
  "\t\t\t\tsignal: controller.signal,",
  "\t\t\t\ttimeoutMs: this.turnTimeoutMs,",
  "\t\t\t},",
  "\t\t\t...(sessionId !== undefined",
  "\t\t\t\t? {",
  "\t\t\t\t\t\tonEvent: (event: TAgentRuntimeOutputEvent) =>",
  "\t\t\t\t\t\t\tthis.emitOutputEvent(sessionId, event),",
  "\t\t\t\t\t}",
  "\t\t\t\t: {}),",
  "\t\t}",
];
const OPTS_NO_SESSION = [
  "\t\tconst controller = new AbortController()",
  "\t\tconst options: IAgentRuntimeRunOptions = {",
  "\t\t\tcontext: {",
  "\t\t\t\trequestId: this.generateRequestId(),",
  "\t\t\t\tsignal: controller.signal,",
  "\t\t\t\ttimeoutMs: this.turnTimeoutMs,",
  "\t\t\t},",
  "\t\t}",
];

const handlers = [
  { parse: "parseCheckpointRestoreParams", call: "this.runtime.restoreCheckpoint", arg: "input.sessionId", session: true },
  { parse: "parseModelChatParams", call: "this.runtime.modelChat", arg: "", session: false },
  { parse: "parseAgentChatParams", call: "this.runtime.chat", arg: "input.sessionId", session: true },
  { parse: "parseAgentChatResolveParams", call: "this.runtime.resolveApproval", arg: "input.sessionId", session: true },
  { parse: "parseAgentAskUserResumeParams", call: "this.runtime.resolveAskUser", arg: "input.sessionId", session: true },
];

for (const h of handlers) {
  const inputLine = `\t\tconst input = ${h.parse}(params)`;
  const oldLines = [
    inputLine,
    ...(h.session ? OPTS_SESSION : OPTS_NO_SESSION),
    `\t\tconst response = await ${h.call}(input, options)`,
  ];
  const newLines = [
    inputLine,
    `\t\tconst response = await ${h.call}(`,
    "\t\t\tinput,",
    `\t\t\tthis.buildExtRunOptions(${h.arg}),`,
    "\t\t)",
  ];
  replaceBlock(AGENT, oldLines, newLines, `A3: agent.ts ${h.call} 改用 buildExtRunOptions`);
}

// ════════ A6：models/output-budget.ts —— grapheme 改惰性单遍，去掉整串物化 ════════
const BUDGET = "builtin-agent/src/models/output-budget.ts";

// (1) IGraphemeSegment 增加 index（Intl.Segmenter 原生即带 index）。
replaceBlock(
  BUDGET,
  ["interface IGraphemeSegment {", "  segment: string;", "}"],
  ["interface IGraphemeSegment {", "  segment: string;", "  index: number;", "}"],
  "A6: IGraphemeSegment 增加 index",
);

// (2) 用惰性 iterateGraphemes + 单遍 measureGraphemes 取代 segmentGraphemes。
replaceBlock(
  BUDGET,
  [
    "const segmentGraphemes = (value: string, locale: string): string[] => {",
    "  const segmenter = getGraphemeSegmenter(locale);",
    "  if (segmenter) {",
    "    return Array.from(segmenter.segment(value), (segment) => segment.segment);",
    "  }",
    "  // 兜底：按 Unicode codepoint 切分。能正确处理代理对，但 ZWJ 复合 emoji 会被拆成多个，",
    "  // 仅用于预算估算可接受（会略偏多）。",
    "  return Array.from(value);",
    "};",
  ],
  [
    "// 惰性逐 grapheme 遍历：产出每个 grapheme 及其在原串中的起始 code-unit 下标，",
    "// 供计数与「按下标切片」复用同一遍，避免把整串物化成数组（大输出热路径的额外分配）。",
    "function* iterateGraphemes(",
    "  value: string,",
    "  locale: string,",
    "): Generator<IGraphemeSegment> {",
    "  const segmenter = getGraphemeSegmenter(locale);",
    "  if (segmenter) {",
    "    yield* segmenter.segment(value);",
    "    return;",
    "  }",
    "  // 兜底：按 Unicode codepoint 切分。能正确处理代理对，但 ZWJ 复合 emoji 会被拆成多个，",
    "  // 仅用于预算估算可接受（会略偏多）。",
    "  let index = 0;",
    "  for (const codePoint of value) {",
    "    yield { segment: codePoint, index };",
    "    index += codePoint.length;",
    "  }",
    "}",
    "",
    "interface IGraphemeMeasurement {",
    "  count: number;",
    "  // 第 clipAt 个 grapheme 的起始 code-unit 下标；未到达 clipAt 时为 -1。",
    "  clipIndex: number;",
    "}",
    "",
    "// 单遍测量：返回 grapheme 总数，并在恰好数到第 clipAt 个 grapheme 时记录其起始",
    "// code-unit 下标（用于按原串切片得到「前 clipAt 个 grapheme」，无需 join）。",
    "const measureGraphemes = (",
    "  value: string,",
    "  locale: string,",
    "  clipAt: number,",
    "): IGraphemeMeasurement => {",
    "  let count = 0;",
    "  let clipIndex = -1;",
    "  for (const { index } of iterateGraphemes(value, locale)) {",
    "    if (count === clipAt) {",
    "      clipIndex = index;",
    "    }",
    "    count += 1;",
    "  }",
    "  return { count, clipIndex };",
    "};",
  ],
  "A6: 引入 iterateGraphemes + measureGraphemes",
);

// (3) countModelOutputChars 改用 measureGraphemes（不再物化数组）。
replaceBlock(
  BUDGET,
  [
    "export const countModelOutputChars = (value: string, locale = DEFAULT_LOCALE): number =>",
    "  segmentGraphemes(value, locale).length;",
  ],
  [
    "export const countModelOutputChars = (value: string, locale = DEFAULT_LOCALE): number =>",
    "  measureGraphemes(value, locale, Number.POSITIVE_INFINITY).count;",
  ],
  "A6: countModelOutputChars 改用 measureGraphemes",
);

// (4) truncateModelOutputText 改为单遍：按下标切片，不再 slice+join 数组。
replaceBlock(
  BUDGET,
  [
    "  const safeMaxChars = Math.max(0, Math.floor(maxChars));",
    "  const locale = options.locale ?? DEFAULT_LOCALE;",
    "  const graphemes = segmentGraphemes(value, locale);",
    "  const originalCharCount = graphemes.length;",
    "  if (originalCharCount <= safeMaxChars) {",
    "    return {",
    "      text: value,",
    "      truncated: false,",
    "      originalCharCount,",
    "      omittedCharCount: 0,",
    "    };",
    "  }",
    "  const clippedText = graphemes.slice(0, safeMaxChars).join('');",
    "  const omittedCharCount = originalCharCount - safeMaxChars;",
  ],
  [
    "  const safeMaxChars = Math.max(0, Math.floor(maxChars));",
    "  const locale = options.locale ?? DEFAULT_LOCALE;",
    "  // 单遍惰性遍历：拿到总字数与截断点下标，避免物化整串 grapheme 数组再 join。",
    "  const { count: originalCharCount, clipIndex } = measureGraphemes(",
    "    value,",
    "    locale,",
    "    safeMaxChars,",
    "  );",
    "  if (originalCharCount <= safeMaxChars) {",
    "    return {",
    "      text: value,",
    "      truncated: false,",
    "      originalCharCount,",
    "      omittedCharCount: 0,",
    "    };",
    "  }",
    "  const clippedText = clipIndex >= 0 ? value.slice(0, clipIndex) : '';",
    "  const omittedCharCount = originalCharCount - safeMaxChars;",
  ],
  "A6: truncateModelOutputText 改用单遍 measureGraphemes",
);

console.log(
  "\n全部完成。建议执行：pnpm -C builtin-agent typecheck && pnpm -C builtin-agent test",
);
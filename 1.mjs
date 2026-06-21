#!/usr/bin/env node
// apply-phase1.mjs
// Phase 1:把外部(Kimi)流式回合的收尾从 legacy displayMessages round-trip 切到 entries 真源
//          (保留 thought,修「推理完成后消失」)+ 正文开始后推理停止流式(修「思考与正文一起流」)。
// 用法:
//   node apply-phase1.mjs                       # 在仓库根目录运行
//   node apply-phase1.mjs D:\com.xiaojianc\my_desktop_app
//   node apply-phase1.mjs --dry                 # 只校验匹配,不写盘
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const root = resolve(argv.find((a) => !a.startsWith("--")) ?? process.cwd());
const j = (...lines) => lines.join("\n");

const F_ASSIST = "src/composables/ai/useAiAssistant.ts";
const F_TIMELINE = "src/components/business/ai/thread/projection/thread-entries-to-timeline.ts";
const F_SPEC = "src/components/business/ai/thread/projection/thread-entries-to-timeline.spec.ts";

const edits = [
  // ── useAiAssistant.ts ① 声明本回合事件快照(executeExternalAgentRequest 内,initialActivityText 锚定唯一) ──
  {
    file: F_ASSIST,
    label: "useAiAssistant: 声明 finalEvents 快照",
    marker: "    let finalEvents: readonly TAgentUiEvent[] = [];",
    old: j(
      "      applySidecarLiveEventsToAgentMessage(",
      "        assistantMessageId,",
      "        targetThreadId,",
      "        initialActivityText,",
      "        events,",
      "      );",
      "      updateLiveThreadFromSidecarEvents(assistantMessageId, targetThreadId, events);",
      "    });",
      "    let unlistenSidecarStream: (() => void) | null = null;",
    ),
    new: j(
      "      applySidecarLiveEventsToAgentMessage(",
      "        assistantMessageId,",
      "        targetThreadId,",
      "        initialActivityText,",
      "        events,",
      "      );",
      "      updateLiveThreadFromSidecarEvents(assistantMessageId, targetThreadId, events);",
      "    });",
      "    let unlistenSidecarStream: (() => void) | null = null;",
      "    let finalEvents: readonly TAgentUiEvent[] = [];",
    ),
  },

  // ── useAiAssistant.ts ② flush 后快照事件 + 去掉 completed 分支的 legacy 收口 ──
  {
    file: F_ASSIST,
    label: "useAiAssistant: 快照事件并撤掉 completed 分支的 commit",
    marker: "      finalEvents = liveEventBuffer.events.slice();",
    old: j(
      "      liveEventBuffer.flush();",
      "      unlistenSidecarStream?.();",
      "      unlistenSidecarStream = null;",
      "",
      "      if (!requestAbortController.signal.aborted) {",
      "        const currentMessage = findMessageById(assistantMessageId);",
      "        updateAgentExecutionMessage({",
      "          messageId: assistantMessageId,",
      "          content: currentMessage?.content ?? '',",
      "          toolCalls: currentMessage?.toolCalls ?? [],",
      "          streamStatus: 'completed',",
      "          finalAnswerStarted: hasMeaningfulAssistantText(currentMessage?.content),",
      "        });",
      "        commitDisplayMessagesToStore(targetThreadId);",
      "      }",
    ),
    new: j(
      "      liveEventBuffer.flush();",
      "      finalEvents = liveEventBuffer.events.slice();",
      "      unlistenSidecarStream?.();",
      "      unlistenSidecarStream = null;",
      "",
      "      if (!requestAbortController.signal.aborted) {",
      "        const currentMessage = findMessageById(assistantMessageId);",
      "        updateAgentExecutionMessage({",
      "          messageId: assistantMessageId,",
      "          content: currentMessage?.content ?? '',",
      "          toolCalls: currentMessage?.toolCalls ?? [],",
      "          streamStatus: 'completed',",
      "          finalAnswerStarted: hasMeaningfulAssistantText(currentMessage?.content),",
      "        });",
      "        // 收尾落库交给 finally 的 entries 覆盖,不再走会抹掉推理 entry 的 legacy round-trip。",
      "      }",
    ),
  },

  // ── useAiAssistant.ts ③ finally 收口改为 entries 覆盖(catch+finally 组合体全局唯一) ──
  {
    file: F_ASSIST,
    label: "useAiAssistant: finally 以 entries 真源收尾",
    marker: "      if (!requestAbortController.signal.aborted && finalEvents.length > 0) {",
    old: j(
      "    } catch (error) {",
      "      if (requestAbortController.signal.aborted) {",
      "        disposeSidecarAnswerStream(assistantMessageId);",
      "      } else {",
      "        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));",
      "      }",
      "    } finally {",
      "      liveEventBuffer.dispose();",
      "      unlistenSidecarStream?.();",
      "      activeAbortController.value = null;",
      "      activeAgentMessageId.value = null;",
      "      commitDisplayMessagesToStore(targetThreadId);",
      "      clearActiveBufferedThread(targetThreadId);",
      "      isSending.value = false;",
      "      syncDisplayMessagesFromActiveThread();",
      "    }",
    ),
    new: j(
      "    } catch (error) {",
      "      if (requestAbortController.signal.aborted) {",
      "        disposeSidecarAnswerStream(assistantMessageId);",
      "      } else {",
      "        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));",
      "      }",
      "    } finally {",
      "      liveEventBuffer.dispose();",
      "      unlistenSidecarStream?.();",
      "      activeAbortController.value = null;",
      "      activeAgentMessageId.value = null;",
      "      // 正常收尾:以 reduce 真源(保留 thought)覆盖权威活动线程,取代会抹掉推理 entry 的",
      "      // legacy displayMessages round-trip。取消/异常(无事件)仍走 legacy 收尾。",
      "      if (!requestAbortController.signal.aborted && finalEvents.length > 0) {",
      "        updateLiveThreadFromSidecarEvents(assistantMessageId, targetThreadId, finalEvents);",
      "      } else {",
      "        commitDisplayMessagesToStore(targetThreadId);",
      "      }",
      "      clearActiveBufferedThread(targetThreadId);",
      "      isSending.value = false;",
      "      syncDisplayMessagesFromActiveThread();",
      "    }",
    ),
  },

  // ── thread-entries-to-timeline.ts ④ 正文开始后推理停止流式 ──
  {
    file: F_TIMELINE,
    label: "timeline: 正文开始后 reasoning 停止流式",
    marker: "  const finalAnswerStarted = messageTexts.length > 0;",
    old: j(
      "  const projected: TAiThreadEntry[] = [];",
      "  if (thoughtSegments.length > 0) {",
      "    const reasoning: IAiThreadReasoningEntry = {",
      "      kind: 'reasoning',",
      "      id: `${entry.id}:reasoning`,",
      "      messageId: entry.id,",
      "      segments: thoughtSegments,",
      "      // 与 runtime 时间线对齐:多段(>1)才视为长推理,渲染层默认折叠。",
      "      isLong: thoughtSegments.length > 1,",
      "      streaming,",
      "    };",
      "    projected.push(reasoning);",
      "  }",
    ),
    new: j(
      "  // 正文一旦开始,推理即结束流式(随后由 useThreadEntryExpansion 自动折叠);",
      "  // 正文条目仍保留自身 streaming。修复「思考与正文一起流式输出」。",
      "  const finalAnswerStarted = messageTexts.length > 0;",
      "  const projected: TAiThreadEntry[] = [];",
      "  if (thoughtSegments.length > 0) {",
      "    const reasoning: IAiThreadReasoningEntry = {",
      "      kind: 'reasoning',",
      "      id: `${entry.id}:reasoning`,",
      "      messageId: entry.id,",
      "      segments: thoughtSegments,",
      "      // 与 runtime 时间线对齐:多段(>1)才视为长推理,渲染层默认折叠。",
      "      isLong: thoughtSegments.length > 1,",
      "      streaming: streaming && !finalAnswerStarted,",
      "    };",
      "    projected.push(reasoning);",
      "  }",
    ),
  },

  // ── thread-entries-to-timeline.spec.ts ⑤ 追加断言用例 ──
  {
    file: F_SPEC,
    label: "timeline.spec: 新增「正文开始后推理停止流式」用例",
    marker: "  it('正文开始后推理停止流式(仅正文保持 streaming)', () => {",
    old: j(
      "    expect(timeline.map((e) => e.kind)).toEqual(['user-message', 'assistant-text']);",
      "  });",
      "});",
    ),
    new: j(
      "    expect(timeline.map((e) => e.kind)).toEqual(['user-message', 'assistant-text']);",
      "  });",
      "",
      "  it('正文开始后推理停止流式(仅正文保持 streaming)', () => {",
      "    const entries: IAiThreadEntry[] = [",
      "      {",
      "        type: 'assistant_message',",
      "        id: 'a3',",
      "        createdAt: ISO,",
      "        chunks: [",
      "          { type: 'thought', block: { type: 'text', text: 'thinking' } },",
      "          { type: 'message', block: { type: 'text', text: 'answer' } },",
      "        ],",
      "      },",
      "    ];",
      "    const timeline = threadEntriesToTimeline(entries, { streamingMessageId: 'a3' });",
      "    expect(timeline.map((e) => e.kind)).toEqual(['reasoning', 'assistant-text']);",
      "    const reasoning = timeline[0];",
      "    const text = timeline[1];",
      "    if (reasoning.kind === 'reasoning') {",
      "      expect(reasoning.streaming).toBe(false);",
      "    }",
      "    if (text.kind === 'assistant-text') {",
      "      expect(text.streaming).toBe(true);",
      "    }",
      "  });",
      "});",
    ),
  },
];

// ── 执行 ──
const byFile = new Map();
for (const e of edits) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}

let hadError = false;
const log = [];

for (const [rel, list] of byFile) {
  const abs = join(root, rel);
  let content;
  try {
    content = readFileSync(abs, "utf8");
  } catch (err) {
    hadError = true;
    log.push(`✗ 读取失败 ${rel}: ${err.message}`);
    continue;
  }
  const original = content;
  let fileError = false;

  for (const e of list) {
    if (content.includes(e.marker)) {
      log.push(`•  跳过(已应用) ${e.label}`);
      continue;
    }
    const count = content.split(e.old).length - 1;
    if (count === 0) {
      hadError = true;
      fileError = true;
      log.push(`✗ 未匹配 ${e.label} — 源码可能已变更,请人工核对`);
      continue;
    }
    if (count > 1) {
      hadError = true;
      fileError = true;
      log.push(`✗ 命中 ${count} 处(预期 1) ${e.label} — 已跳过以免误改`);
      continue;
    }
    content = content.replace(e.old, () => e.new); // 函数替换:避免 $ 被特殊解释
    log.push(`✓ 应用 ${e.label}`);
  }

  if (fileError) {
    log.push(`✗ ${rel} 有未应用的修改,本文件不写盘`);
    continue;
  }
  if (content !== original) {
    if (dry) {
      log.push(`(dry) 将写入 ${rel}`);
    } else {
      writeFileSync(abs, content, "utf8");
      log.push(`💾 写入 ${rel}`);
    }
  } else {
    log.push(`=  ${rel} 无变化`);
  }
}

console.log(`仓库根目录: ${root}\n`);
console.log(log.join("\n"));
console.log(
  hadError
    ? "\n完成,但存在错误(见上),请人工核对未匹配项。"
    : dry
      ? "\n校验通过(dry,未写盘)。"
      : "\n全部应用完成。",
);
process.exit(hadError ? 1 : 0);
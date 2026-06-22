#!/usr/bin/env node
/**
 * FIX(chat 卡死回归):executeAiRequest 的流式缓冲回调里,settle() 是 chat 回合唯一的完成信号,
 * 却被排在 applySidecarLiveEventsToAgentMessage / updateLiveThreadFromSidecarEvents 之后。
 * 这两步(今天 C1.2/a7357baa 重写)每帧做 legacy-adapter 全量往返 + overlay 写权威 store,
 * 任一抛错——因回调跑在缓冲 raf/timeout flush 中,是游离异步异常,不会 reject 外层 await——
 * 就会饿死 settle(),导致 isSending 永久 true、永久"正在准备回复"。
 *
 * 修复:先探测 done/error;渲染写入入 try/catch(失败仅记日志/报错,不阻断);finally 恒定 settle。
 * 仅改 chat 路径(agent/外部 agent 的完成靠 awaited RPC,不受影响)。Happy path 行为等价、可逆。
 *
 * 用法:
 *   node 1.mjs            # 干跑
 *   node 1.mjs --apply    # 写回
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/composables/ai/useAiAssistant.ts';
const APPLY = process.argv.includes('--apply');

const raw = readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
let text = crlf ? raw.split('\r\n').join('\n') : raw;

const FIND = [
  "      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));",
  "      const liveRenderState = applySidecarLiveEventsToAgentMessage(",
  "        assistantMessageId,",
  "        targetThreadId,",
  "        '',",
  "        events,",
  "      );",
  "      updateLiveThreadFromSidecarEvents(",
  "        assistantMessageId,",
  "        targetThreadId,",
  "        events,",
  "        liveRenderState,",
  "      );",
  "",
  "      const { doneEvent, errorEvent } = getLatestSidecarLiveEvents(events);",
  "",
  "      if (errorEvent) {",
  "        errorMessage.value = errorEvent.message;",
  "      }",
  "",
  "      if (doneEvent || errorEvent) {",
  "        settle();",
  "      }",
].join('\n');

const REPLACE = [
  "      // 关键修复(chat 卡死回归):settle() 是本回合唯一的完成信号(解开 await、复位 isSending),",
  "      // 必须在收到 done/error 帧时永远触发,不能被渲染富集写入的异常饿死——该回调跑在缓冲的",
  "      // raf/timeout flush 里,抛错是游离的未处理异常,不会 reject 外层 await,会造成永久「正在准备回复」。",
  "      const { doneEvent, errorEvent } = getLatestSidecarLiveEvents(events);",
  "",
  "      try {",
  "        appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));",
  "        const liveRenderState = applySidecarLiveEventsToAgentMessage(",
  "          assistantMessageId,",
  "          targetThreadId,",
  "          '',",
  "          events,",
  "        );",
  "        updateLiveThreadFromSidecarEvents(",
  "          assistantMessageId,",
  "          targetThreadId,",
  "          events,",
  "          liveRenderState,",
  "        );",
  "      } catch (error) {",
  "        logger.error({ event: 'ai.chat.live_render_failed', err: error });",
  "        if (!errorMessage.value) {",
  "          errorMessage.value = toErrorMessage(error, MSG_CALL_FAILED);",
  "        }",
  "      } finally {",
  "        if (errorEvent) {",
  "          errorMessage.value = errorEvent.message;",
  "        }",
  "        if (doneEvent || errorEvent) {",
  "          settle();",
  "        }",
  "      }",
].join('\n');

const n = text.split(FIND).length - 1;
if (n !== 1) {
  console.error(`✗ 期望命中 1 处 chat 缓冲回调,实际 ${n}。文件可能已变动,中止以免误改。`);
  process.exit(1);
}
text = text.replace(FIND, () => REPLACE);

// 终检:settle() 总数不变(仍 1 处),且新结构标记就位。
const settleCount = (text.match(/(^|[^.\w])settle\(\);/g) || []).length;
if (!text.includes("event: 'ai.chat.live_render_failed'")) {
  console.error('✗ 终检失败:未发现新 catch 标记。'); process.exit(1);
}
if (settleCount < 2) {
  console.error(`✗ 终检失败:settle(); 调用点异常(${settleCount})。`); process.exit(1);
}

const out = crlf ? text.split('\n').join('\r\n') : text;
if (APPLY) {
  writeFileSync(FILE, out, 'utf8');
  console.log(`✓ 已写回 ${FILE}(EOL:${crlf ? 'CRLF' : 'LF'})。`);
} else {
  console.log('✓ 干跑通过:命中唯一 chat 回调,将以 try/finally 保证 settle()。加 --apply 写回。');
}
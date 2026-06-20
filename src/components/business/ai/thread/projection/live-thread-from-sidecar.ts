/**
 * 边车事件流 -> 活动线程(entries 真源)的纯前向组合器。
 *
 * 把「逐事件规范化」(sidecarEventToReduceEvents)与「reduce 单写入」(reduceThreadAll)
 * 串成单一前向管线:边车 UI 事件流 flatMap 成 reduce 规范化事件,再整体回放到基线
 * 线程上,得到 entries 模型的活动线程。等价于
 * reduceThreadAll(baseThread, events.flatMap(normalize))，把两步显式串成一条管线，
 * 作为后续「实时渲染从 legacy-adapter 翻到前向管线」的接入缝。
 *
 * 设计取舍:
 * - 纯函数、无副作用、不持状态、不读时钟:now 与 assistantMessageId 由调用方(回合
 *   监听层)注入,保证确定性与可单测。
 * - 仅组合既有纯函数,不复制其逻辑:标题/压缩文案 presenter、工具状态机、chunk 合并
 *   等全部由下游两函数负责,本层只负责「串起来」。
 * - 层次方向:本文件属 projection 层,依赖 store 的 reduce 与同层 normalizer;store
 *   不反向依赖 projection(避免循环依赖)。
 */
import { reduceThreadAll } from '@/store/aiThread/reduce';
import type { TAgentUiEvent } from '@/types/ai/sidecar';
import type { IAiThread } from '@/types/ai/thread';

import { sidecarEventToReduceEvents } from './from-sidecar-events';

export interface IBuildLiveThreadFromSidecarOptions {
  /** 回放基线线程:通常是本回合开始前的活动线程(entries 真源)。 */
  baseThread: IAiThread;
  /** 本回合 assistant 消息 id(正文与思维链共用,见 normalizer)。 */
  assistantMessageId: string;
  /** 顶层无内联时间戳事件(message_delta / done / error)的 createdAt(ISO)。 */
  now: string;
}

/**
 * 把一段边车 UI 事件流前向组合为活动线程。纯函数:不修改入参、无副作用。
 */
export const buildLiveThreadFromSidecarEvents = (
  events: readonly TAgentUiEvent[],
  options: IBuildLiveThreadFromSidecarOptions,
): IAiThread => {
  const reduceEvents = events.flatMap((event) =>
    sidecarEventToReduceEvents(event, {
      now: options.now,
      assistantMessageId: options.assistantMessageId,
    }),
  );
  return reduceThreadAll(options.baseThread, reduceEvents);
};

/**
 * ACP 模块对外入口（barrel）。
 *
 * - protocol：ACP 线上协议契约（单一事实来源）。
 * - from-runtime-event：运行时富事件 → SessionUpdate 的唯一投影边界。
 */
export * from "./protocol"
export * from "./from-runtime-event"

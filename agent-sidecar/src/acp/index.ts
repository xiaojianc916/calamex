/**
 * ACP 模块对外入口（barrel）。
 *
 * - protocol：ACP 线上协议契约（单一事实来源）。
 * - jsonrpc：ACP 传输层 JSON-RPC 2.0 信封与方法名/错误码注册表。
 * - from-runtime-event：运行时富事件 → SessionUpdate 的唯一投影边界。
 * - session-stream：投影结果 → session/update 通知信封的出口成帧。
 * - usage：done token 快照 → usage_update 的纯映射。
 */
export * from "./protocol"
export * from "./jsonrpc"
export * from "./from-runtime-event"
export * from "./session-stream"
export * from "./usage"

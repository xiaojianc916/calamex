/**
 * ACP 模块对外入口（barrel）。
 *
 * - protocol：ACP 线上协议契约（单一事实来源）。
 * - jsonrpc：ACP 传输层 JSON-RPC 2.0 信封与方法名/错误码注册表。
 * - request-client：agent 侧出站请求（session/request_permission 等）的 id 分配与响应关联。
 * - initialize：initialize 握手的请求/响应、客户端/Agent 能力与 Implementation/AuthMethod 契约。
 * - prompt-turn：session/prompt 请求/响应、StopReason 与 session/cancel 通知契约。
 * - mcp-server：session/new 与 session/load 中的 MCP 服务器配置（stdio/http/sse 传输）。
 * - session-mode：会话模式集合（SessionMode/State）与 session/set_mode 切换契约。
 * - session-config：会话配置选择器（SessionConfigOption）与 session/set_config_option 契约。
 * - new-session：session/new 与 session/load 的请求/响应（组合 mcp-server / session-mode / session-config）。
 * - from-runtime-event：运行时富事件 → SessionUpdate 的唯一投影边界。
 * - session-stream：投影结果 → session/update 通知信封的出口成帧。
 * - usage：done token 快照 → usage_update 的纯映射。
 * - turn-egress：一次 prompt 回合的整体出口组装（过程通知 + 收尾 usage_update + prompt 响应）。
 */
export * from "./protocol"
export * from "./jsonrpc"
export * from "./request-client"
export * from "./initialize"
export * from "./prompt-turn"
export * from "./mcp-server"
export * from "./session-mode"
export * from "./session-config"
export * from "./new-session"
export * from "./from-runtime-event"
export * from "./session-stream"
export * from "./usage"
export * from "./turn-egress"

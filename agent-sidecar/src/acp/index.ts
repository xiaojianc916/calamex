/**
 * ACP 模块对外入口(barrel)。
 *
 * ACP 线上协议契约、JSON-RPC 传输、initialize 握手与会话生命周期类型,统一由官方
 * @agentclientprotocol/sdk 提供(单一事实来源),不再在本模块内手写镜像——消费方
 * 直接从 "@agentclientprotocol/sdk" 导入类型(如 SessionUpdate / SessionNotification /
 * ContentBlock / McpServer / StopReason / PromptResponse 等),传输与边界校验由
 * AgentSideConnection 承担。
 *
 * 本 barrel 导出 calamex 专有的「运行时 ↔ ACP」投影、会话状态与值构造器,以及
 * 将它们接成一个 ACP Agent 的 dispatcher:
 * - helpers            ：SDK 未提供的零依赖值构造器(textBlock / promptResponse)。
 * - from-runtime-event ：运行时富事件 → SessionUpdate 的唯一出站投影边界。
 * - to-runtime-input   ：ACP PromptRequest 内容块 → 运行时输入的入站投影。
 * - session-stream     ：投影结果 → session/update 通知信封的出口成帧。
 * - output-event-stream：运行时输出事件 → session/update 出口投影(计划汇总与审批不走通知)。
 * - session-registry   ：Agent 侧按 sessionId 持有的会话状态与回合取消句柄。
 * - usage              ：done token 快照 → usage_update 的纯映射。
 * - turn-egress        ：一次 prompt 回合的整体出口组装(过程通知 + 收尾 usage_update + prompt 响应)。
 * - agent              ：实现 SDK Agent 接口、把上述投影接到 runtime 的 dispatcher。
 *
 * 注:可执行入口 stdio-entry.ts 含进程启动副作用,故**不**进 barrel。
 */
export * from "./helpers.js"
export * from "./from-runtime-event.js"
export * from "./to-runtime-input.js"
export * from "./session-stream.js"
export * from "./output-event-stream.js"
export * from "./session-registry.js"
export * from "./usage.js"
export * from "./turn-egress.js"
export * from "./agent.js"

/**
 * ACP 会话建立契约 —— session/new 与 session/load 的请求/响应。
 *
 * 忠实镜像 agentclientprotocol/agent-client-protocol v1 的稳定 JSON Schema（schema/v1/schema.json）：
 * - NewSessionRequest   { cwd, mcpServers, additionalDirectories? }            x-method session/new
 * - NewSessionResponse  { sessionId, modes?, configOptions? }
 * - LoadSessionRequest  { cwd, mcpServers, sessionId, additionalDirectories? } x-method session/load
 * - LoadSessionResponse { modes?, configOptions? }
 *
 * 复用 ./mcp-server 的 mcpServerSchema、./session-mode 的 sessionModeStateSchema、
 * ./session-config 的 sessionConfigOptionSchema，避免重复建模。
 * session/new、session/prompt、session/cancel、session/update 为所有 Agent 的基线能力；
 * session/load 受顶层 loadSession 能力门控。SessionId 同既有 slice 以 z.string() 内联。
 * 约定同 ./protocol：camelCase、.passthrough() 透传 _meta。
 */
import { z } from "zod"

import { mcpServerSchema } from "./mcp-server.js"
import { sessionModeStateSchema } from "./session-mode.js"
import { sessionConfigOptionSchema } from "./session-config.js"

/** NewSessionRequest：创建新会话。 */
export const newSessionRequestSchema = z
	.object({
		cwd: z.string(),
		mcpServers: z.array(mcpServerSchema),
		additionalDirectories: z.array(z.string()).optional(),
	})
	.passthrough()
export type TNewSessionRequest = z.infer<typeof newSessionRequestSchema>

/** NewSessionResponse：返回新会话标识及可选的初始模式集/配置选项。 */
export const newSessionResponseSchema = z
	.object({
		sessionId: z.string(),
		modes: sessionModeStateSchema.nullish(),
		configOptions: z.array(sessionConfigOptionSchema).nullish(),
	})
	.passthrough()
export type TNewSessionResponse = z.infer<typeof newSessionResponseSchema>

/** LoadSessionRequest：加载既有会话（需 loadSession 能力）。 */
export const loadSessionRequestSchema = z
	.object({
		cwd: z.string(),
		mcpServers: z.array(mcpServerSchema),
		sessionId: z.string(),
		additionalDirectories: z.array(z.string()).optional(),
	})
	.passthrough()
export type TLoadSessionRequest = z.infer<typeof loadSessionRequestSchema>

/** LoadSessionResponse：与 NewSessionResponse 同形但不含 sessionId。 */
export const loadSessionResponseSchema = z
	.object({
		modes: sessionModeStateSchema.nullish(),
		configOptions: z.array(sessionConfigOptionSchema).nullish(),
	})
	.passthrough()
export type TLoadSessionResponse = z.infer<typeof loadSessionResponseSchema>

/** 构造 session/new 响应：sessionId 必填，modes/configOptions 可选。 */
export const newSessionResponse = (
	sessionId: string,
	rest: Pick<TNewSessionResponse, "modes" | "configOptions"> = {},
): TNewSessionResponse => ({ sessionId, ...rest })

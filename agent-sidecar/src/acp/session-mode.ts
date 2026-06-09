/**
 * ACP 会话模式契约 —— Agent 可运行的若干模式及其切换。
 *
 * 忠实镜像 agentclientprotocol/agent-client-protocol v1 的稳定 JSON Schema（schema/v1/schema.json）
 * 与 src/v1/agent.rs：
 * - SessionModeId          模式唯一标识（string newtype）
 * - SessionMode            { id, name, description? }
 * - SessionModeState       { currentModeId, availableModes }（session/new、session/load 响应中报告的初始模式集）
 * - SetSessionModeRequest  { sessionId, modeId }（session/set_mode）
 * - SetSessionModeResponse {}（仅 _meta）
 *
 * 约定同 ./protocol：字段 camelCase、对象一律 .passthrough()（透传含 _meta 的未知字段）。
 * SessionId 同既有 slice（prompt-turn）以 z.string() 内联，不另设 newtype。
 * current_mode_update 这一 SessionUpdate 变体归 ./protocol 的 sessionUpdate 统辖，不在本槽建模。
 */
import { z } from "zod"

/** SessionModeId：会话模式的唯一标识。 */
export const sessionModeIdSchema = z.string()
export type TSessionModeId = z.infer<typeof sessionModeIdSchema>

/** SessionMode：Agent 可运行的一种模式。 */
export const sessionModeSchema = z
	.object({
		id: sessionModeIdSchema,
		name: z.string(),
		description: z.string().nullish(),
	})
	.passthrough()
export type TSessionMode = z.infer<typeof sessionModeSchema>

/** SessionModeState：可用模式集合与当前激活的模式。 */
export const sessionModeStateSchema = z
	.object({
		currentModeId: sessionModeIdSchema,
		availableModes: z.array(sessionModeSchema),
	})
	.passthrough()
export type TSessionModeState = z.infer<typeof sessionModeStateSchema>

/** SetSessionModeRequest：session/set_mode 请求 —— 将指定会话切换到某模式。 */
export const setSessionModeRequestSchema = z
	.object({
		sessionId: z.string(),
		modeId: sessionModeIdSchema,
	})
	.passthrough()
export type TSetSessionModeRequest = z.infer<typeof setSessionModeRequestSchema>

/** SetSessionModeResponse：session/set_mode 响应（无字段，仅 _meta）。 */
export const setSessionModeResponseSchema = z.object({}).passthrough()
export type TSetSessionModeResponse = z.infer<typeof setSessionModeResponseSchema>

/** 构造 session/set_mode 的空响应。 */
export const setSessionModeResponse = (): TSetSessionModeResponse => ({})

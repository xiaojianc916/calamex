/**
 * ACP (Agent Client Protocol) wire schema — the single source of truth for the
 * `session/update` notification payloads exchanged over the sidecar transport.
 *
 * Mirrors the upstream Rust definitions verbatim (camelCase JSON, snake_case
 * enum + discriminator values), pinned to ACP protocol version 1:
 *   - SessionUpdate / ContentChunk / Usage  -> agent-client-protocol src/v1/client.rs
 *   - ContentBlock                          -> src/v1/content.rs
 *   - ToolCall / ToolCallUpdate / ToolKind  -> src/v1/tool_call.rs
 *   - Plan / PlanEntry                      -> src/v1/plan.rs
 *
 * Forward-compatibility (mirrors ACP's serde_with contract):
 *   - objects are `.passthrough()` so `_meta` and future fields survive a round-trip;
 *   - open enums use `.catch(default)` to degrade unknown variants to the ACP default
 *     (`ToolKind::Other` / `ToolCallStatus::Pending`) instead of throwing;
 *   - `parseSessionUpdate` returns null on unknown `sessionUpdate` variants, matching
 *     ACP's `VecSkipError` "drop the item, keep the stream" philosophy.
 */
import { z } from 'zod';

/** Negotiated ACP protocol version this schema targets. */
export const ACP_PROTOCOL_VERSION = 1 as const;

// --- Content blocks (src/v1/content.rs) ------------------------------------

const roleSchema = z.enum(['assistant', 'user']);

const annotationsSchema = z
  .object({
    audience: z.array(roleSchema).optional(),
    lastModified: z.string().optional(),
    priority: z.number().optional(),
  })
  .passthrough();

const resourceContentsSchema = z.union([
  z.object({ uri: z.string(), text: z.string(), mimeType: z.string().optional() }).passthrough(),
  z.object({ uri: z.string(), blob: z.string(), mimeType: z.string().optional() }).passthrough(),
]);

export const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), annotations: annotationsSchema.optional() }).passthrough(),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string(), uri: z.string().optional(), annotations: annotationsSchema.optional() }).passthrough(),
  z.object({ type: z.literal('audio'), data: z.string(), mimeType: z.string(), annotations: annotationsSchema.optional() }).passthrough(),
  z.object({ type: z.literal('resource_link'), name: z.string(), uri: z.string(), title: z.string().optional(), description: z.string().optional(), mimeType: z.string().optional(), size: z.number().int().optional() }).passthrough(),
  z.object({ type: z.literal('resource'), resource: resourceContentsSchema }).passthrough(),
]);
export type TContentBlock = z.infer<typeof contentBlockSchema>;

/** Convenience constructor for the overwhelmingly common text block. */
export const textBlock = (text: string): TContentBlock => ({ type: 'text', text });

// --- Tool calls (src/v1/tool_call.rs) --------------------------------------

export const toolKindSchema = z
  .enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])
  .catch('other');

export const toolCallStatusSchema = z
  .enum(['pending', 'in_progress', 'completed', 'failed'])
  .catch('pending');

const toolCallLocationSchema = z.object({ path: z.string(), line: z.number().int().optional() }).passthrough();

const toolCallContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('content'), content: contentBlockSchema }).passthrough(),
  z.object({ type: z.literal('diff'), path: z.string(), oldText: z.string().nullable().optional(), newText: z.string() }).passthrough(),
  z.object({ type: z.literal('terminal'), terminalId: z.string() }).passthrough(),
]);

/** Fields shared by `ToolCall` and `ToolCallUpdate` (the latter makes `title` optional). */
const toolCallFields = {
  kind: toolKindSchema.optional(),
  status: toolCallStatusSchema.optional(),
  content: z.array(toolCallContentSchema).optional(),
  locations: z.array(toolCallLocationSchema).optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
};

export const toolCallSchema = z.object({ toolCallId: z.string(), title: z.string(), ...toolCallFields }).passthrough();
export type TToolCall = z.infer<typeof toolCallSchema>;

export const toolCallUpdateSchema = z.object({ toolCallId: z.string(), title: z.string().optional(), ...toolCallFields }).passthrough();
export type TToolCallUpdate = z.infer<typeof toolCallUpdateSchema>;

// --- Plan (src/v1/plan.rs) -------------------------------------------------

const planEntrySchema = z
  .object({
    content: z.string(),
    priority: z.enum(['high', 'medium', 'low']).catch('medium'),
    status: z.enum(['pending', 'in_progress', 'completed']).catch('pending'),
  })
  .passthrough();

export const planSchema = z.object({ entries: z.array(planEntrySchema) }).passthrough();

// --- Streamed chunks & usage (src/v1/client.rs) ----------------------------

const contentChunkSchema = z.object({ content: contentBlockSchema, messageId: z.string().optional() }).passthrough();

const usageUpdateSchema = z
  .object({
    used: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    cost: z.object({ amount: z.number(), currency: z.string() }).passthrough().optional(),
  })
  .passthrough();

// --- SessionUpdate (src/v1/client.rs `SessionUpdate`) ----------------------
// Tagged by `sessionUpdate`; each variant inlines its payload fields. This is the
// core streaming spine every ACP transport speaks. Variants tied to subsystems
// still being rebuilt (current_mode / available_commands / config_option /
// session_info) are intentionally omitted here and tolerated by
// `parseSessionUpdate`'s skip-unknown behaviour until their owning PRs land.
export const sessionUpdateSchema = z.discriminatedUnion('sessionUpdate', [
  contentChunkSchema.extend({ sessionUpdate: z.literal('user_message_chunk') }),
  contentChunkSchema.extend({ sessionUpdate: z.literal('agent_message_chunk') }),
  contentChunkSchema.extend({ sessionUpdate: z.literal('agent_thought_chunk') }),
  toolCallSchema.extend({ sessionUpdate: z.literal('tool_call') }),
  toolCallUpdateSchema.extend({ sessionUpdate: z.literal('tool_call_update') }),
  planSchema.extend({ sessionUpdate: z.literal('plan') }),
  usageUpdateSchema.extend({ sessionUpdate: z.literal('usage_update') }),
]);
export type TSessionUpdate = z.infer<typeof sessionUpdateSchema>;

/** A `session/update` notification body: `{ sessionId, update }`. */
export const sessionNotificationSchema = z.object({ sessionId: z.string(), update: sessionUpdateSchema }).passthrough();
export type TSessionNotification = z.infer<typeof sessionNotificationSchema>;

/**
 * Parse one SessionUpdate, returning `null` for unknown/invalid variants instead
 * of throwing — lets a consumer skip a frame it does not understand without
 * tearing down the whole stream (ACP `VecSkipError` semantics).
 */
export const parseSessionUpdate = (value: unknown): TSessionUpdate | null => {
  const result = sessionUpdateSchema.safeParse(value);
  return result.success ? result.data : null;
};

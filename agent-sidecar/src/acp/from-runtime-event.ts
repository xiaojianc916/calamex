/**
 * Projects the sidecar's internal runtime events onto ACP `SessionUpdate`s.
 *
 * Only the core streaming spine that maps 1:1 onto ACP today is projected:
 *   message_delta -> agent_message_chunk
 *   tool_start    -> tool_call        (status: in_progress)
 *   tool_result   -> tool_call_update (status: completed)
 *
 * Everything else returns `[]` on purpose. Those events either belong to a
 * subsystem being rebuilt in a later PR (plan -> PR-3, approval -> PR-5,
 * diff -> PR-6) or are not modelled as `session/update` in ACP at all
 * (`done`/`error` ride the `session/prompt` response, not an update).
 *
 * The runtime emits tool_start/tool_result without a stable id, so — like the
 * legacy AG-UI adapter — calls are correlated by tool name. Concurrent calls to
 * the same tool would collide; a runtime-issued tool-call id (later PR) removes
 * that limitation.
 */
import { randomUUID } from 'node:crypto';
import type { TAgentRuntimeOutputEvent } from '../engines/contracts/runtime-contracts.js';
import { textBlock, type TSessionUpdate } from './schema.js';

export interface IAcpProjector {
  /** Map one runtime event to zero or more ACP session updates. */
  project(event: TAgentRuntimeOutputEvent): TSessionUpdate[];
}

/**
 * Creates a per-run projector. Its only state — the tool-name -> id correlation
 * table — is scoped to one run, so create a fresh projector per streamed request.
 *
 * @param newId Tool-call id factory; injectable for deterministic tests.
 */
export const createAcpProjector = (newId: () => string = randomUUID): IAcpProjector => {
  const toolCallIdByName = new Map<string, string>();

  const openToolCall = (toolName: string): string => {
    const id = newId();
    toolCallIdByName.set(toolName, id);
    return id;
  };

  const closeToolCall = (toolName: string): string => {
    const id = toolCallIdByName.get(toolName);
    if (id === undefined) return newId();
    toolCallIdByName.delete(toolName);
    return id;
  };

  const project = (event: TAgentRuntimeOutputEvent): TSessionUpdate[] => {
    switch (event.type) {
      case 'message_delta':
        return event.text
          ? [{ sessionUpdate: 'agent_message_chunk', content: textBlock(event.text) }]
          : [];
      case 'tool_start':
        return [
          {
            sessionUpdate: 'tool_call',
            toolCallId: openToolCall(event.toolName),
            title: event.toolName,
            status: 'in_progress',
            rawInput: event.input,
          },
        ];
      case 'tool_result':
        return [
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: closeToolCall(event.toolName),
            status: 'completed',
            rawOutput: event.output,
          },
        ];
      default:
        return [];
    }
  };

  return { project };
};

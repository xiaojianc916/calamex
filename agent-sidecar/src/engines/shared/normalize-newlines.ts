/**
 * Normalize all line endings (\r\n, bare \r) to \n.
 *
 * Shared across agent-sidecar engines. The same logic exists in the frontend
 * (src/utils/file/normalize-line-endings.ts) and Rust gateway (shell_tools.rs).
 * Agent-sidecar cannot import frontend utils, so this local copy is kept in sync.
 */
export const normalizeNewlines = (value: string): string =>
    value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');

/**
 * Normalize all line endings (\r\n, bare \r) to \n.
 *
 * Shared across agent-sidecar engines. The same logic exists in the frontend
 * (src/utils/file/normalize-line-endings.ts) and Rust gateway (shell_tools.rs).
 * Agent-sidecar cannot import frontend utils, so this local copy is kept in sync.
 */
export const normalizeNewlines = (value: string): string => {
    // Fast path: Linux/macOS stdout almost never contains \r.
    // Skip two O(n) replace passes when no \r is present.
    if (!value.includes('\r')) {
        return value;
    }
    return value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
};

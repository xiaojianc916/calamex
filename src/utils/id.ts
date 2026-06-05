/**
 * 唯一标识符生成工具。
 *
 * 统一使用 Web Crypto 标准的 `crypto.randomUUID()`（UUID v4，密码学级随机）生成 ID：
 *  - 在 Tauri webview 与 Node（≥ 19，本项目 engines 要求 ≥ 26）下均为原生可用，
 *    无需引入 nanoid / uuid 等第三方依赖。
 *  - 相比自行用「时间戳 + 自增计数 / Math.random」拼接，UUID 不依赖进程内状态，
 *    跨重载 / 多窗口也不会碍撞，更适合作为会话等长生命周期实体的标识。
 */
export const createUniqueId = (): string => globalThis.crypto.randomUUID();

/**
 * 生成带语义前缀的唯一 ID，便于在日志 / 调试中辨识来源。
 * 例如 `createPrefixedId('terminal')` => `'terminal-1f2e3d4c-...'`。
 */
export const createPrefixedId = (prefix: string): string => `${prefix}-${createUniqueId()}`;

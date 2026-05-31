/**
 * 统一的唯一 ID 生成工具。
 *
 * 优先使用运行时提供的 crypto.randomUUID()(现代浏览器、Tauri WebView 与 Node 均支持),
 * 仅在缺失该 API 的环境下回退到「时间戳 + 进程内自增序列 + 随机串」组合,
 * 借助自增序列保证即便在同一毫秒、且 Math.random 偶发重复时也不会产生碰撞。
 *
 * 背景:editor 与 aiConversation 两个 store 此前各自手写了一份 ID 生成逻辑
 * (前者带 crypto 回退,后者仅 Date.now() + Math.random()),现统一收敛到此处,
 * 既消除重复,也让会话 ID 一并获得 crypto 强随机性。
 */

let idSequence = 0;

/**
 * 生成带前缀的唯一 ID,例如 createUniqueId('document') => 'document-3f1c…'。
 *
 * @param prefix 语义前缀,便于在日志 / 调试中辨认 ID 归属。
 */
export const createUniqueId = (prefix: string): string => {
  const cryptoRef =
    typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return `${prefix}-${cryptoRef.randomUUID()}`;
  }
  idSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
};

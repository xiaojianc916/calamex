/**
 * 文件相关文本的统一归一化入口。
 *
 * 历史上 workspace.ts 与 ssh-file-preview.ts 各自实现了一份归一化，语义不同：
 * - 工作区查询：仅 trim + 默认 locale 小写（不做 NFC），用于路径/名称子串过滤。
 * - 搜索图素：NFC + zh-CN locale 小写，用于逐图素精确匹配。
 * 这里集中维护，保持两种语义各自不变，便于未来统一演进。
 */

/** 工作区查询归一化：trim + 默认 locale 小写（不做 NFC）。 */
export const normalizeWorkspaceQuery = (value: string): string => value.trim().toLocaleLowerCase();

/** 搜索图素归一化：NFC + zh-CN locale 小写。 */
export const normalizeSearchGrapheme = (value: string): string =>
  value.normalize('NFC').toLocaleLowerCase('zh-CN');

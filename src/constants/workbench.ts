export const WORKBENCH_TAB_LIMITS = {
  /**
   * 标签页上限：防止一次性打开过多文件导致状态、持久化和渲染开销失控。
   */
  maxOpenTabs: 30,
  /**
   * 会话只保存标签元数据；与可打开标签上限保持一致。
   */
  maxPersistedOpenTabs: 30,
  /**
   * 只让最近使用的干净文本缓冲区常驻内存。
   * 活动标签、未保存标签、预览类标签不受该值影响。
   */
  maxLoadedCleanTextBuffers: 20,
  maxViewStateEntries: 120,
  maxDraftEntries: 80,
} as const;

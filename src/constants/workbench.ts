export const WORKBENCH_TAB_LIMITS = {
  /**
   * 标签页是轻量元数据：允许大量保留，避免用户工作流被 30 个标签硬打断。
   */
  maxOpenTabs: 500,
  /**
   * 会话只保存标签元数据，不保存正文；因此可与 maxOpenTabs 保持一致。
   */
  maxPersistedOpenTabs: 500,
  /**
   * 只让最近使用的干净文本缓冲区常驻内存。
   * 活动标签、未保存标签、预览类标签不受该值影响。
   */
  maxLoadedCleanTextBuffers: 20,
  maxViewStateEntries: 120,
  maxDraftEntries: 80,
} as const;

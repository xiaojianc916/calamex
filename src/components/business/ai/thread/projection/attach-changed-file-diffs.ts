import {
  buildAiPatchPreviewFiles,
  formatAiPatchDisplayPath,
} from '@/components/business/ai/edit/patch-preview';
import type { IAiPatchSet } from '@/types/ai';
import type {
  IAiAgentChangedFile,
  IAiAgentPatchSummary,
  IAiDiffEditorPreview,
  IAiDiffHunkPreview,
} from '@/types/ai/patch';
import type { IAiThreadToolCall } from '@/types/ai/thread';

/**
 * 把 patch 摘要里的改动文件作为内联 diff 挂到产生它的工具调用上,从
 * build-thread-entries 提取为共享纯函数,供遗留消息投影(legacy-adapter)与
 * IAiChatMessage 投影(build-thread-entries)复用同一归属逻辑,避免两条投影管线漂移。
 *
 * 关联策略:优先按路径精确关联;关联不上时归到最后一个编辑类工具调用;再不行则跳过
 *(仅由末尾「已更改文件」汇总条目呈现)。就地 push 到 toolCall.content,调用方需保证
 * 传入的工具调用对象可安全改写(新建或已复制 content 数组)。
 */

/** 工具调用是否引用某文件(标题里出现完整路径或文件名)。 */
const toolCallReferencesPath = (toolCall: IAiThreadToolCall, filePath: string): boolean => {
  const fileName = filePath.split(/[\\/]/u).pop() ?? filePath;
  return toolCall.title.includes(filePath) || toolCall.title.includes(fileName);
};

/** 编辑类工具(协议 kind=edit);用于无法按路径关联时的兜底归属。 */
const isEditLikeToolCall = (toolCall: IAiThreadToolCall): boolean => toolCall.kind === 'edit';

/**
 * 从本消息补丁集中解析「路径 → hunk」。复用「已更改文件」汇总卡片完全一致的
 * buildAiPatchPreviewFiles,避免内联 diff 与汇总卡片行为漂移(不另造解析)。
 * 仅按路径键匹配,不依赖 workspaceRootPath(其只影响展示路径,不影响 hunk 与键)。
 */
const resolveHunksByPath = (patches: readonly IAiPatchSet[]): Map<string, IAiDiffHunkPreview[]> => {
  const byPath = new Map<string, IAiDiffHunkPreview[]>();
  for (const patch of patches) {
    for (const previewFile of buildAiPatchPreviewFiles(patch, undefined)) {
      for (const key of [previewFile.path, previewFile.displayPath]) {
        const normalized = formatAiPatchDisplayPath(key);
        byPath.set(normalized, [...(byPath.get(normalized) ?? []), ...previewFile.hunks]);
      }
    }
  }
  return byPath;
};

/** 改动文件 → 协议 diff 预览(复用 aiDiffEditorPreview,不另造 diff 模型)。 */
const buildDiffPreview = (
  file: IAiAgentChangedFile,
  summary: IAiAgentPatchSummary,
  hunksByPath: Map<string, IAiDiffHunkPreview[]>,
): IAiDiffEditorPreview => ({
  id: `${summary.id}:${file.path}`,
  title: file.path,
  filePath: file.path,
  diffRef: file.diffRef,
  patchRef: summary.patchRef,
  runId: summary.runId,
  stepId: summary.stepId,
  hunks: hunksByPath.get(formatAiPatchDisplayPath(file.path)) ?? [],
});

/**
 * 把改动文件内联 diff 就地挂到对应工具调用的 content 上。详见文件头说明。
 */
export const attachChangedFileDiffsToToolCalls = (
  toolCalls: readonly IAiThreadToolCall[],
  summary: IAiAgentPatchSummary,
  patches: readonly IAiPatchSet[],
): void => {
  if (toolCalls.length === 0) {
    return;
  }
  const hunksByPath = resolveHunksByPath(patches);
  const editToolCalls = toolCalls.filter(isEditLikeToolCall);
  const fallback = editToolCalls.at(-1);

  for (const file of summary.files) {
    const target =
      toolCalls.find((toolCall) => toolCallReferencesPath(toolCall, file.path)) ?? fallback;
    if (target === undefined) {
      continue;
    }
    target.content.push({
      type: 'diff',
      diff: buildDiffPreview(file, summary, hunksByPath),
    });
  }
};

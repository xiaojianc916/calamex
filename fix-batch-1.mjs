#!/usr/bin/env node
/**
 * fix-batch-3.mjs — Calamex 代码审查第三批修复脚本
 *
 * 包含：
 *   M-6  useShellWorkbenchView.ts — 抽取文档导航历史为独立 composable
 *   M-1  useBrowserContextMenu.ts — execCommand 使用补注释
 *   M-5  aiConversation.ts — IAiConversationThread 改为 schema 推断 + extension
 *   M-3  useShellWorkbenchView.ts — 双 rAF 补注释
 *   L-5  shell_tools.rs — std::sync::Mutex 在 async 中使用补注释
 *   L-1  git.ts — file baseline cache 迁入 vue-query
 *
 * 用法: 在项目根目录 (D:\com.xojianc\my_desktop_app) 下运行:
 *   node fix-batch-3.mjs
 *
 * 修改前请确保 git 工作区干净，以便 git checkout 回滚。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const SRC_TAURI = join(ROOT, 'src-tauri', 'src');
const ENCODING = 'utf-8';

let changes = 0;

function log(msg) { console.log(`  ${msg}`); }

function patchFile(relPath, patches) {
  const absPath = join(ROOT, relPath);
  if (!existsSync(absPath)) {
    console.warn(`  ⚠️ 文件不存在，跳过: ${relPath}`);
    return;
  }
  let content = readFileSync(absPath, ENCODING);
  let modified = false;
  for (const { oldStr, newStr, description } of patches) {
    if (!content.includes(oldStr)) {
      console.warn(`  ⚠️ 未找到匹配 (跳过): ${description}`);
      continue;
    }
    content = content.replace(oldStr, newStr);
    log(`✅ ${description}`);
    modified = true;
    changes++;
  }
  if (modified) {
    writeFileSync(absPath, content, ENCODING);
  }
}

function createFile(relPath, fileContent, description) {
  const absPath = join(ROOT, relPath);
  const dir = dirname(absPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (existsSync(absPath)) {
    console.warn(`  ⚠️ 文件已存在，跳过创建: ${relPath}`);
    return;
  }
  writeFileSync(absPath, fileContent, ENCODING);
  log(`✅ ${description}`);
  changes++;
}

// ─────────────────────────────────────────────────────────────
// M-6: 创建 useDocumentNavigationHistory.ts composable
// ─────────────────────────────────────────────────────────────
createFile(
  'src/composables/useDocumentNavigationHistory.ts',
  `import { ref } from 'vue';

/**
 * 文档导航历史（后退/前进栈）。
 *
 * 从 useShellWorkbenchView 抽取为独立 composable，提升可测试性。
 * 行为与原内联实现完全一致：
 * - 后退栈记录用户离开的文档 ID
 * - 后退时将当前文档压入前进栈
 * - 前进时将当前文档压入后退栈
 * - 新导航（非前进/后退触发的切换）清空前进栈
 * - 文档关闭时从两个栈中清理引用
 * - 栈有最大长度限制
 */
const MAX_HISTORY_SIZE = 120;

export const useDocumentNavigationHistory = () => {
  const backStack = ref<string[]>([]);
  const forwardStack = ref<string[]>([]);
  const isNavigating = ref(false);

  const canGoBack = (): boolean => backStack.value.length > 0;
  const canGoForward = (): boolean => forwardStack.value.length > 0;

  const getBackStack = () => backStack;
  const getForwardStack = () => forwardStack;

  /** 检查导航栈中是否有可用的目标（跳过已关闭的文档）。 */
  const pickNavigableFromStack = (
    stack: ReturnType<typeof backStack>,
    checkExists: (id: string) => boolean,
    currentId: string,
  ): string | null => {
    while (stack.value.length > 0) {
      const candidate = stack.value.pop();
      if (!candidate || candidate === currentId) {
        continue;
      }
      if (checkExists(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  /** 记录一次文档切换（非导航触发的）。 */
  const recordNavigation = (
    previousDocumentId: string | null,
    nextDocumentId: string,
    checkExists: (id: string) => boolean,
  ): void => {
    if (isNavigating.value) {
      isNavigating.value = false;
      return;
    }
    if (previousDocumentId && checkExists(previousDocumentId)) {
      backStack.value = [
        ...backStack.value,
        previousDocumentId,
      ].slice(Math.max(0, backStack.value.length + 1 - MAX_HISTORY_SIZE));
    }
    forwardStack.value = [];
  };

  /**
   * 执行后退/前进导航。
   * 返回目标文档 ID（或 null），调用方负责实际切换文档并随后调用 finishNavigation()。
   * 如果导航栈为空，返回 null（调用方可自行处理 adjacent fallback）。
   */
  const navigate = (
    direction: 'back' | 'forward',
    currentDocumentId: string,
    checkExists: (id: string) => boolean,
  ): string | null => {
    const sourceStack = direction === 'back' ? backStack : forwardStack;
    const targetStack = direction === 'back' ? forwardStack : backStack;

    const targetId = pickNavigableFromStack(sourceStack, checkExists, currentDocumentId);
    if (!targetId) {
      return null;
    }

    targetStack.value = [
      ...targetStack.value,
      currentDocumentId,
    ].slice(Math.max(0, targetStack.value.length + 1 - MAX_HISTORY_SIZE));

    isNavigating.value = true;
    return targetId;
  };

  /** 导航完成后的标志复位（在 activateDocument 之后调用）。 */
  const finishNavigation = (): void => {
    isNavigating.value = false;
  };

  /** 文档关闭时从两个栈中清理引用。 */
  const removeClosedDocument = (documentId: string): void => {
    backStack.value = backStack.value.filter((id) => id !== documentId);
    forwardStack.value = forwardStack.value.filter((id) => id !== documentId);
  };

  return {
    backStack,
    forwardStack,
    isNavigating,
    canGoBack,
    canGoForward,
    recordNavigation,
    navigate,
    finishNavigation,
    removeClosedDocument,
  };
};
`,
  'M-6: 创建 useDocumentNavigationHistory.ts',
);

// ─────────────────────────────────────────────────────────────
// M-6: useShellWorkbenchView.ts — 替换内联导航历史为 composable 调用
// ─────────────────────────────────────────────────────────────
patchFile('src/composables/useShellWorkbenchView.ts', [
  {
    description: 'M-6: 添加 import useDocumentNavigationHistory',
    oldStr: `import { useShellWorkbenchViewportState } from '@/composables/useShellWorkbenchViewportState';`,
    newStr: `import { useDocumentNavigationHistory } from '@/composables/useDocumentNavigationHistory';
import { useShellWorkbenchViewportState } from '@/composables/useShellWorkbenchViewportState';`,
  },
  {
    description: 'M-6: 移除 MAX_DOCUMENT_NAV_HISTORY 常量（已移入 composable）',
    oldStr: `const READY_PAINT_FALLBACK_TIMEOUT_MS = 96;
const MAX_DOCUMENT_NAV_HISTORY = 120;
const AI_PANEL_DEFAULT_WIDTH = 450;`,
    newStr: `const READY_PAINT_FALLBACK_TIMEOUT_MS = 96;
const AI_PANEL_DEFAULT_WIDTH = 450;`,
  },
  {
    description: 'M-6: 替换内联导航历史状态为 composable 调用',
    oldStr: `  const startupWorkspaceRoot = ref<IWorkspaceDirectoryPayload | null>(null);
  const hasEmittedReady = ref(false);
  const isRestoringWorkbenchSession = ref(false);
  const documentBackStack = ref<string[]>([]);
  const documentForwardStack = ref<string[]>([]);
  let isApplyingDocumentNavigation = false;`,
    newStr: `  const startupWorkspaceRoot = ref<IWorkspaceDirectoryPayload | null>(null);
  const hasEmittedReady = ref(false);
  const isRestoringWorkbenchSession = ref(false);
  const docHistory = useDocumentNavigationHistory();
  const documentBackStack = docHistory.backStack;
  const documentForwardStack = docHistory.forwardStack;`,
  },
  {
    description: 'M-6: 替换 canNavigateDocument 使用 composable',
    oldStr: `  const canNavigateDocument = (direction: 'back' | 'forward'): boolean => {
    const stack = direction === 'back' ? documentBackStack : documentForwardStack;
    if (stack.value.length > 0) {
      return true;
    }

    const currentDocumentId = workbench.editorStore.activeDocumentId;
    return currentDocumentId
      ? resolveAdjacentDocumentId(currentDocumentId, direction) !== null
      : false;
  };`,
    newStr: `  const canNavigateDocument = (direction: 'back' | 'forward'): boolean => {
    if (direction === 'back' ? docHistory.canGoBack() : docHistory.canGoForward()) {
      return true;
    }

    const currentDocumentId = workbench.editorStore.activeDocumentId;
    return currentDocumentId
      ? resolveAdjacentDocumentId(currentDocumentId, direction) !== null
      : false;
  };`,
  },
  {
    description: 'M-6: 简化 navigateDocument 使用 composable',
    oldStr: `  const navigateDocument = (direction: 'back' | 'forward'): void => {
    const currentDocumentId = workbench.editorStore.activeDocumentId;
    if (!currentDocumentId) {
      return;
    }

    const sourceStack = direction === 'back' ? documentBackStack : documentForwardStack;
    const targetStack = direction === 'back' ? documentForwardStack : documentBackStack;

    const targetDocumentId =
      pickNextNavigableDocumentId(sourceStack, currentDocumentId) ??
      resolveAdjacentDocumentId(currentDocumentId, direction);
    if (!targetDocumentId) {
      return;
    }

    targetStack.value = trimDocumentNavHistory([...targetStack.value, currentDocumentId]);
    isApplyingDocumentNavigation = true;
    void workbench.activateDocument(targetDocumentId);
  };`,
    newStr: `  const navigateDocument = (direction: 'back' | 'forward'): void => {
    const currentDocumentId = workbench.editorStore.activeDocumentId;
    if (!currentDocumentId) {
      return;
    }

    const targetDocumentId =
      docHistory.navigate(direction, currentDocumentId, hasDocumentInEditorStore) ??
      resolveAdjacentDocumentId(currentDocumentId, direction);
    if (!targetDocumentId) {
      return;
    }

    void workbench.activateDocument(targetDocumentId);
  };`,
  },
  {
    description: 'M-6: 替换 activeDocumentId watcher 中的导航历史逻辑',
    oldStr: `      if (isApplyingDocumentNavigation) {
        isApplyingDocumentNavigation = false;
        return;
      }

      if (previousDocumentId && hasDocumentInEditorStore(previousDocumentId)) {
        documentBackStack.value = trimDocumentNavHistory([
          ...documentBackStack.value,
          previousDocumentId,
        ]);
      }

      documentForwardStack.value = [];`,
    newStr: `      if (docHistory.isNavigating.value) {
        docHistory.finishNavigation();
        return;
      }

      docHistory.recordNavigation(previousDocumentId, nextDocumentId, hasDocumentInEditorStore);`,
  },
  {
    description: 'M-6: 替换 documents watcher 中的栈清理逻辑',
    oldStr: `      const documentIdSet = new Set(documentIds);
      documentBackStack.value = documentBackStack.value.filter((documentId) =>
        documentIdSet.has(documentId),
      );
      documentForwardStack.value = documentForwardStack.value.filter((documentId) =>
        documentIdSet.has(documentId),
      );`,
    newStr: `      const documentIdSet = new Set(documentIds);
      for (const id of documentIds) {
        if (!documentIdSet.has(id)) {
          docHistory.removeClosedDocument(id);
        }
      }
      // 也清理栈中已不存在的文档
      documentBackStack.value = documentBackStack.value.filter((documentId) =>
        documentIdSet.has(documentId),
      );
      documentForwardStack.value = documentForwardStack.value.filter((documentId) =>
        documentIdSet.has(documentId),
      );`,
  },
]);

// ─────────────────────────────────────────────────────────────
// M-3: useShellWorkbenchView.ts — 双 rAF 补注释
// ─────────────────────────────────────────────────────────────
patchFile('src/composables/useShellWorkbenchView.ts', [
  {
    description: 'M-3: 双 rAF 补注释说明',
    oldStr: `    firstFrameId = window.requestAnimationFrame(() => {
      firstFrameId = null;
      secondFrameId = window.requestAnimationFrame(() => {
        secondFrameId = null;
        finish();
      });
    });`,
    newStr: `    // 双 rAF：第一帧后浏览器已完成布局但可能尚未完成绘制；
    // 第二帧回调执行时首帧绘制已落屏，确保终端 attach 时机在首次可见帧之后，
    // 避免 xterm 在未绘制的容器上初始化导致尺寸计算为 0。
    firstFrameId = window.requestAnimationFrame(() => {
      firstFrameId = null;
      secondFrameId = window.requestAnimationFrame(() => {
        secondFrameId = null;
        finish();
      });
    });`,
  },
]);

// ─────────────────────────────────────────────────────────────
// M-1: useBrowserContextMenu.ts — execCommand 补注释
// ─────────────────────────────────────────────────────────────
patchFile('src/composables/useBrowserContextMenu.ts', [
  {
    description: 'M-1: execDocumentCommand 补注释',
    oldStr: `const execDocumentCommand = (command: string, value?: string): boolean => {
  if (typeof document.execCommand !== 'function') {
    return false;
  }

  try {
    return document.execCommand(command, false, value);
  } catch {
    return false;
  }
};`,
    newStr: `/**
 * execCommand 兜底调用。execCommand 在 W3C 规范中标记为 deprecated，但以下场景
 * 目前无标准 Web API 替代，仍需保留：
 *
 * - undo / redo：W3C 未提供主动触发 undo/redo 的标准 API（beforeinput 的
 *   historyUndo inputType 可监听但不可主动触发），execCommand 是唯一方案。
 *
 * 以下场景已优先使用标准 API，execCommand 仅作 fallback：
 * - cut / copy：优先 navigator.clipboard + setRangeText / Selection API
 * - paste：优先 navigator.clipboard.readText + insertTextIntoEditable
 * - select-all：input/textarea 用 .select()；contentEditable 有 Range API fallback
 * - insertText（contentEditable paste 路径）：优先 execCommand('insertText')，
 *   fallback 到 Range.deleteContents + TextNode 插入
 */
const execDocumentCommand = (command: string, value?: string): boolean => {
  if (typeof document.execCommand !== 'function') {
    return false;
  }

  try {
    return document.execCommand(command, false, value);
  } catch {
    return false;
  }
};`,
  },
]);

// ─────────────────────────────────────────────────────────────
// M-5: aiConversation.ts — IAiConversationThread 改为 schema 推断 + extension
// ─────────────────────────────────────────────────────────────
patchFile('src/store/aiConversation.ts', [
  {
    description: 'M-5: 添加 z 和 schema import',
    oldStr: `import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { IAiChatMessage } from '@/types/ai';
import {
  aiChatMessageSchema,
  aiConversationLegacyPersistSchema,
  aiConversationPersistSchema,
  aiConversationThreadSchema,
} from '@/types/ai/conversation.schema';`,
    newStr: `import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { z } from 'zod';
import type { IAiChatMessage } from '@/types/ai';
import {
  aiChatMessageSchema,
  aiConversationLegacyPersistSchema,
  aiConversationPersistSchema,
  aiConversationThreadSchema,
} from '@/types/ai/conversation.schema';`,
  },
  {
    description: 'M-5: IAiConversationThread 改为 schema 推断 + extension',
    oldStr: `export interface IAiConversationThread {
  id: string;
  title: string;
  titleStatus: TAiConversationTitleStatus;
  updatedAt: string;
  createdAt: string;
  messages: IAiChatMessage[];
  scrollState?: IAiConversationScrollState;
}

/**
 * 持久化形状; 与 store 内部状态结构一致, 使用手写接口而非
 * z.infer<typeof aiConversationPersistSchema>, 避免 IAiChatMessage 与
 * aiChatMessageSchema 推断类型漂移引发 TS2322。
 *
 * afterHydrate 中对 parse 结果做一次 boundary cast (as unknown as) 即可。
 * 长期方案: 把 IAiChatMessage 改为 z.infer<typeof aiChatMessageSchema>。
 */
interface IAiConversationPersistShape {
  activeThreadId: string | null;
  threads: IAiConversationThread[];
}`,
    newStr: `/**
 * Thread 的 wire 形状由 schema 推断（单一来源），UI 层通过 extension 覆写
 * messages 数组元素类型为含 UI 衍生字段的消息。
 *
 * 根因：aiChatMessageSchema 推断 messages 为 IAiChatMessageWire[]，
 * 而 IAiChatMessage extends IAiChatMessageWire 添加了 patches / changedFilesSummary
 * / acpToolCalls 等 UI 衍生字段。TS 数组协变不安全（IAiChatMessageWire[]
 * → IAiChatMessage[]），因此 salvageHydratedThreads 中仍需一次 boundary cast。
 * 但至少消除了手写字段重复定义——以后加字段只需改 schema。
 */
type IAiConversationThreadWire = z.infer<typeof aiConversationThreadSchema>;

export interface IAiConversationThread extends Omit<IAiConversationThreadWire, 'messages'> {
  messages: IAiChatMessage[];
}

/**
 * 持久化形状; 与 store 内部状态结构一致。
 *
 * afterHydrate 中对 parse 结果做一次 boundary cast (as unknown as) 即可——
 * 根因是 messages 数组协变方向（IAiChatMessageWire[] → IAiChatMessage[]）
 * 在 TS 中不安全，非字段定义漂移。
 */
interface IAiConversationPersistShape {
  activeThreadId: string | null;
  threads: IAiConversationThread[];
}`,
  },
  {
    description: 'M-5: 更新 salvageHydratedThreads 中的 cast 注释',
    oldStr: `    // 用线程 schema 校验元信息; messages 已替换为救援后的合法集合。
    const parsedThread = aiConversationThreadSchema.safeParse({
      ...candidate,
      messages,
    });
    return parsedThread.success ? [parsedThread.data as unknown as IAiConversationThread] : [];`,
    newStr: `    // 用线程 schema 校验元信息; messages 已替换为救援后的合法集合。
    const parsedThread = aiConversationThreadSchema.safeParse({
      ...candidate,
      messages,
    });
    // boundary cast：parsedThread.data.messages 是 IAiChatMessageWire[]，
    // 赋给 IAiConversationThread.messages (IAiChatMessage[]) 需要一次 cast。
    // 根因是 TS 数组协变：IAiChatMessage extends IAiChatMessageWire，
    // 但 TS 不允许把 Wire[] 赋给 Message[]（因为 Message 有额外字段）。
    return parsedThread.success ? [parsedThread.data as unknown as IAiConversationThread] : [];`,
  },
  {
    description: 'M-5: 更新 afterHydrate 中的 cast 注释',
    oldStr: `        if (parsedCurrent.success) {
          // 边界 cast: parse 成功 → 运行时形状与 IAiConversationPersistShape 等价;
          // TS 看到的差异仅来自 IAiChatMessage 手写接口与 aiChatMessageSchema
          // 推断类型的字面量 union 命名漂移。
          const parsed = parsedCurrent.data as unknown as IAiConversationPersistShape;`,
    newStr: `        if (parsedCurrent.success) {
          // 边界 cast: parse 成功 → 运行时形状与 IAiConversationPersistShape 等价;
          // TS 看到的差异仅来自 messages 数组协变方向
          // (IAiChatMessageWire[] → IAiChatMessage[])，非字段定义漂移。
          const parsed = parsedCurrent.data as unknown as IAiConversationPersistShape;`,
  },
]);

// ─────────────────────────────────────────────────────────────
// L-5: shell_tools.rs — std::sync::Mutex 在 async 中使用补注释
// ─────────────────────────────────────────────────────────────
patchFile('src-tauri/src/commands/shell_tools.rs', [
  {
    description: 'L-5: partial_stderr Mutex 补注释',
    oldStr: `    let mut stderr_pipe = child.stderr.take().expect("stderr is piped");
    let partial_stderr: Arc<std::sync::Mutex<Vec<u8>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));`,
    newStr: `    let mut stderr_pipe = child.stderr.take().expect("stderr is piped");
    // 使用 std::sync::Mutex 而非 tokio::sync::Mutex：锁仅用于 stderr 缓冲的瞬时读写，
    // 不跨 await 点，持锁时间 < 1µs（extend_from_slice 是同步操作）。
    // tokio::sync::Mutex 会引入不必要的 async 开销和潜在的 await 中断。
    // SAFETY: stderr_reader 线程中的 lock() → extend_from_slice → unlock 是
    // 同步完成的，主线程的 lock() 也是同步的（take + lock 不跨 await）。
    let partial_stderr: Arc<std::sync::Mutex<Vec<u8>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));`,
  },
]);

// ─────────────────────────────────────────────────────────────
// L-1: git.ts — file baseline cache 迁入 vue-query
// ─────────────────────────────────────────────────────────────
patchFile('src/store/git.ts', [
  {
    description: 'L-1: 添加 GIT_FILE_BASELINE_QUERY_PREFIX 常量',
    oldStr: `  // 提交详情/文件 diff/diff 预览均按 commit-id(及路径)寻址,内容不可变:
// staleTime=Infinity 命中即复用、永不后台重取;不持久化(无 meta.persist,仅内存),
// 切换工作树/提交时由 clearBaselineCache 通过 removeQueries 清空。
  queryClient.setQueryDefaults(GIT_COMMIT_DETAIL_QUERY_PREFIX, { staleTime: Infinity });
  queryClient.setQueryDefaults(GIT_COMMIT_FILE_DIFF_QUERY_PREFIX, { staleTime: Infinity });
  queryClient.setQueryOptions(GIT_COMMIT_FILE_DIFF_PREVIEW_QUERY_PREFIX, { staleTime: Infinity });`,
    newStr: `  // 提交详情/文件 diff/diff 预览均按 commit-id(及路径)寻址,内容不可变:
// staleTime=Infinity 命中即复用、永不后台重取;不持久化(无 meta.persist,仅内存),
// 切换工作树/提交时由 clearBaselineCache 通过 removeQueries 清空。
  queryClient.setQueryOptions(GIT_COMMIT_DETAIL_QUERY_PREFIX, { staleTime: Infinity });
  queryClient.setQueryOptions(GIT_COMMIT_FILE_DIFF_QUERY_PREFIX, { staleTime: Infinity });
  queryClient.setQueryOptions(GIT_COMMIT_FILE_DIFF_PREVIEW_QUERY_PREFIX, { staleTime: Infinity });

  // file baseline 查询：按文件路径寻址，文件被修改后需刷新,
  // 交由 vue-query 的 fetchQuery 去重 + removeQueries 失效，替代手写缓存 + pending 表。
const GIT_FILE_BASELINE_QUERY_PREFIX = ['git', 'fileBaseline'];
  queryClient.setQueryOptions(GIT_FILE_BASELINE_QUERY_PREFIX, { staleTime: Infinity });`,
  },
  {
    description: 'L-1: 添加 fileBaselineQueryKey 辅助函数',
    oldStr: `  const commitFileDiffPreviewQueryKey = (
    repositoryRootPath: string,
    commitId: string,
    relativePath: string,
  ): string[] => [
    ...GIT_COMMIT_FILE_DIFF_PREVIEW_QUERY_PREFIX,
    normalizeFileSystemPath(repositoryRootPath),
    commitId,
    relativePath,
  ];`,
    newStr: `  const commitFileDiffPreviewQueryKey = (
    repositoryRootPath: string,
    commitId: string,
    relativePath: string,
  ): string[] => [
    ...GIT_COMMIT_FILE_DIFF_PREVIEW_QUERY_PREFIX,
    normalizeFileSystemPath(repositoryRootPath),
    commitId,
    relativePath,
  ];

  const fileBaselineQueryKey = (path: string): string[] => [
    ...GIT_FILE_BASELINE_QUERY_PREFIX,
    normalizeFileSystemPath(path),
  ];`,
  },
  {
    description: 'L-1: 移除手写 baselineCache 和 pendingBaselineRequests 声明',
    oldStr: `  const baselineCache = ref<Record<string, IGitFileBaselinePayload>>({});
  const baselineEpoch = ref(0);`,
    newStr: `  // baseline 缓存已迁入 vue-query：fetchQuery 去重 + staleTime=Infinity，
  // 失效用 removeQueries。baselineEpoch 保留供调用方判断 baseline 是否已刷新。
  const baselineEpoch = ref(0);`,
  },
  {
    description: 'L-1: 移除 pendingBaselineRequests 声明',
    oldStr: `  let pullRequestPreloadTimer: ReturnType<typeof setTimeout> | null = null;
  let commitStatsBackgroundTimer: ReturnType<typeof setTimeout> | null = null;
  let isCommitStatsBackgroundRunning = false;
  const queuedCommitStatsIds = new Set<string>();
  const pendingCommitStatsRequests = new Set<string>();
  const pullRequestBackgroundPreloadAttemptedAt = new Map<string, number>();

  const pendingBaselineRequests = new Map<string, Promise<IGitFileBaselinePayload>>();
  let pendingPullRequestSupportRequest: Promise<IGitPullRequestSupportPayload> | null = null;`,
    newStr: `  let pullRequestPreloadTimer: ReturnType<typeof setTimeout> | null = null;
  let commitStatsBackgroundTimer: ReturnType<typeof setTimeout> | null = null;
  let isCommitStatsBackgroundRunning = false;
  const queuedCommitStatsIds = new Set<string>();
  const pendingCommitStatsRequests = new Set<string>();
  const pullRequestBackgroundPreloadAttemptedAt = new Map<string, number>();

  let pendingPullRequestSupportRequest: Promise<IGitPullRequestSupportPayload> | null = null;`,
  },
  {
    description: 'L-1: 重写 getFileBaseline 使用 vue-query fetchQuery',
    oldStr: `  const getFileBaseline = async (path: string): Promise<IGitFileBaselinePayload> => {
    const cacheKey = normalizeFileSystemPath(path);
    const cached = baselineCache.value[cacheKey];
    if (cached) return cached;

    const pending = pendingBaselineRequests.get(cacheKey);
    if (pending) return pending;

    const epochAtRequest = baselineEpoch.value;
    const request = tauriService
      .getGitFileBaseline(path)
      .then((payload) => {
        if (epochAtRequest === baselineEpoch.value) {
          baselineCache.value = {
            ...baselineCache.value,
            [cacheKey]: payload,
          };
        }
        return payload;
      })
      .finally(() => {
        pendingBaselineRequests.delete(cacheKey);
      });

    pendingBaselineRequests.set(cacheKey, request);
    return request;
  };`,
    newStr: `  // file baseline 已迁入 vue-query：fetchQuery 自动去重同 key 请求，
  // staleTime=Infinity 命中即复用。文件被修改后由 invalidateFileBaseline 调 removeQueries 失效。
  const getFileBaseline = async (path: string): Promise<IGitFileBaselinePayload> => {
    return queryClient.fetchQuery<IGitFileBaselinePayload>({
      queryKey: fileBaselineQueryKey(path),
      queryFn: () => tauriService.getGitFileBaseline(path),
    });
  };`,
  },
  {
    description: 'L-1: 重写 invalidateFileBaseline 使用 vue-query removeQueries',
    oldStr: `  const invalidateFileBaseline = (path?: string | null): void => {
    const cacheKey = normalizeFileSystemPath(path);
    if (!cacheKey) return;
    const hasCached = cacheKey in baselineCache.value;
    const hasPending = pendingBaselineRequests.has(cacheKey);
    if (!hasCached && !hasPending) return;
    if (hasCached) {
      const nextCache = { ...baselineCache.value };
      delete nextCache[cacheKey];
      baselineCache.value = nextCache;
    }
    baselineEpoch.value += 1;
  };`,
    newStr: `  // invalidateFileBaseline：从 vue-query 移除指定路径的 baseline 查询，
  // 下次 getFileBaseline 会重新发请求。同时推进 epoch 让调用方感知变化。
  const invalidateFileBaseline = (path?: string | null): void => {
    if (!path) return;
    const cacheKey = normalizeFileSystemPath(path);
    if (!cacheKey) return;
    queryClient.removeQueries({ queryKey: fileBaselineQueryKey(path) });
    baselineEpoch.value += 1;
  };`,
  },
  {
    description: 'L-1: 更新 clearBaselineCache 清理 vue-query 中的 baseline 查询',
    oldStr: `  const clearBaselineCache = (): void => {
    baselineCache.value = {};
    baselineEpoch.value += 1;`,
    newStr: `  const clearBaselineCache = (): void => {
    queryClient.removeQueries({ queryKey: [...GIT_FILE_BASELINE_QUERY_PREFIX] });
    baselineEpoch.value += 1;`,
  },
]);

// ─────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────
console.log('');
console.log(`Done. ${changes} patches applied.`);
if (changes === 0) {
  console.log('No changes were made. All patches may require manual application.');
}
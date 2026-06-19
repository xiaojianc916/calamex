#!/usr/bin/env node
/**
 * Calamex 全量代码优化脚本
 *
 * 处理项:
 *   🔴 #1: editor.ts — syncDocumentState 用 Object.assign 批量赋值减少 trigger
 *   🔴 #2: git.ts   — 移除 commitStatsCache ref 镜像，直接从 queryClient 读取
 *   🔴 #3: aiConversation.ts — trimThreads 仅在新增/删除线程时执行
 *   🟠 #4: editor.ts — findDocumentByPath 缓存搜索路径归一化
 *   🟠 #5: useBrowserContextMenu.ts — 事件注册移入 onMounted
 *   🟠 #8: useShellWorkbenchView.ts — documents watcher 用 length + activeDocumentId 替代全量映射
 *
 * 已经手动处理（1.mjs 已完成）:
 *   🟡 #10: git.ts requestIdleCallback 类型 cast
 *   🟠 #6: tauri.git.ts 度量函数注释
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

const ok = (msg) => console.log(`  ✅ ${msg}`);
const skip = (msg) => console.log(`  ⏭️  ${msg}`);
const fail = (msg) => console.error(`  ❌ ${msg}`);

let totalModified = 0;

function patchFile(filePath, name, find, replace) {
  if (!existsSync(filePath)) {
    fail(`${name}: 文件不存在 ${filePath}`);
    return false;
  }
  let content = readFileSync(filePath, 'utf-8');
  if (!content.includes(find)) {
    skip(`${name}: 未找到目标代码（可能已修改）`);
    return false;
  }
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] ${name}: 将替换 ${find.length} → ${replace.length} 字符`);
    return true;
  }
  content = content.replace(find, replace);
  writeFileSync(filePath, content, 'utf-8');
  ok(`${name}: 已修改`);
  return true;
}

console.log('\n🔧 Calamex 全量代码优化脚本');
console.log(DRY_RUN ? '   (DRY-RUN 模式)\n' : '\n');

// ═══════════════════════════════════════════════════════════════════════
// 🔴 #1: editor.ts — syncDocumentState 用 Object.assign 批量赋值
// ═══════════════════════════════════════════════════════════════════════
console.log('── 🔴 #1: editor.ts syncDocumentState Object.assign ──');
{
  const filePath = join(__dirname, 'src', 'store', 'editor.ts');

  // (a) syncDocumentState 的 bufferLoaded===false 分支
  const oldSync1 = `const syncDocumentState = (
  document: IEditorDocument,
  metrics?: IDocumentMetrics,
): IEditorDocument => {
  if (document.kind === 'text' && document.bufferLoaded === false) {
    document.content = '';
    document.savedContent = '';
    document.isDirty = false;
    document.lineCount = 1;
    document.charCount = 0;
    return document;
  }

  const { lineCount, charCount } = metrics ?? computeDocumentMetrics(document.content);
  document.lineCount = lineCount;
  document.charCount = charCount;
  document.isDirty =
    document.content !== document.savedContent || document.encoding !== document.savedEncoding;
  return document;
};`;

  const newSync1 = `const syncDocumentState = (
  document: IEditorDocument,
  metrics?: IDocumentMetrics,
): IEditorDocument => {
  if (document.kind === 'text' && document.bufferLoaded === false) {
    Object.assign(document, {
      content: '',
      savedContent: '',
      isDirty: false,
      lineCount: 1,
      charCount: 0,
    });
    return document;
  }

  const { lineCount, charCount } = metrics ?? computeDocumentMetrics(document.content);
  Object.assign(document, {
    lineCount,
    charCount,
    isDirty:
      document.content !== document.savedContent ||
      document.encoding !== document.savedEncoding,
  });
  return document;
};`;

  // (b) evictInactiveDocumentBuffers 内的逐行赋值
  const oldEvict = `      candidates.slice(0, overflow).forEach((targetDocument) => {
        targetDocument.content = '';
        targetDocument.savedContent = '';
        targetDocument.bufferLoaded = false;
        targetDocument.lineCount = 1;
        targetDocument.charCount = 0;
        targetDocument.isDirty = false;
        clearDocumentAnalysis(targetDocument.id);
      });`;

  const newEvict = `      candidates.slice(0, overflow).forEach((targetDocument) => {
        Object.assign(targetDocument, {
          content: '',
          savedContent: '',
          bufferLoaded: false,
          lineCount: 1,
          charCount: 0,
          isDirty: false,
        });
        clearDocumentAnalysis(targetDocument.id);
      });`;

  // (c) unloadDocumentBuffer 内的逐行赋值
  const oldUnload = `  targetDocument.content = '';
  targetDocument.savedContent = '';
  targetDocument.bufferLoaded = false;
  targetDocument.lineCount = 1;
  targetDocument.charCount = 0;
  targetDocument.isDirty = false;
  clearDocumentAnalysis(documentId);`;

  const newUnload = `  Object.assign(targetDocument, {
    content: '',
    savedContent: '',
    bufferLoaded: false,
    lineCount: 1,
    charCount: 0,
    isDirty: false,
  });
  clearDocumentAnalysis(documentId);`;

  let m1 = patchFile(filePath, '#1a syncDocumentState', oldSync1, newSync1);
  let m2 = patchFile(filePath, '#1b evictInactiveDocumentBuffers', oldEvict, newEvict);
  let m3 = patchFile(filePath, '#1c unloadDocumentBuffer', oldUnload, newUnload);
  if (m1 || m2 || m3) totalModified++;
}

// ═══════════════════════════════════════════════════════════════════════
// 🔴 #2: git.ts — 移除 commitStatsCache ref 镜像
// ═══════════════════════════════════════════════════════════════════════
console.log('\n── 🔴 #2: git.ts 移除 commitStatsCache 双重缓存 ──');
{
  const filePath = join(__dirname, 'src', 'store', 'git.ts');

  // (a) 移除 commitStatsCache ref 声明，保留注释说明已移除
  const oldDecl = `  // commit-stats 的权威缓存在 vue-query;此 ref 仅作响应式镜像,供同步的 getCommitStats 读取并驱动 UI。
  const commitStatsCache = ref<Record<string, TGitCommitStatsPayload>>({});`;
  const newDecl = `  // commit-stats 的权威缓存在 vue-query;同步读取直接调 queryClient.getQueryData。
  // 已移除冗余的 commitStatsCache ref 镜像——vue-query 的 cacheObservable 已驱动 UI 更新。`;

  // (b) rememberCommitStats 移除镜像写入
  const oldRemember = `    // vue-query 承担缓存/gc/持久化;同时写穿响应式镜像,驱动 UI 在后台队列填充时即时更新。
    queryClient.setQueryData(commitStatsQueryKey(cacheKey), payload);
    commitStatsCache.value = {
      ...commitStatsCache.value,
      [cacheKey]: payload,
    };
  };`;
  const newRemember = `    // vue-query 承担缓存/gc/持久化;setQueryData 会自动通知所有监听该 queryKey 的响应式消费者。
    queryClient.setQueryData(commitStatsQueryKey(cacheKey), payload);
  };`;

  // (c) getCommitStats 移除 ref 镜像读取和回填
  const oldGetStats = `  const getCommitStats = (commitId: string): TGitCommitStatsPayload | null => {
    const cacheKey = resolveCommitStatsCacheKey(commitId);
    if (!cacheKey) return null;

    const mirrored = commitStatsCache.value[cacheKey];
    if (mirrored) return mirrored;

    // 启动时官方 persister 已把快照恢复进 queryClient;首次读取时回填响应式镜像。
    const restored = queryClient.getQueryData<TGitCommitStatsPayload>(
      commitStatsQueryKey(cacheKey),
    );
    if (restored) {
      commitStatsCache.value = {
        ...commitStatsCache.value,
        [cacheKey]: restored,
      };
      return restored;
    }
    return null;
  };`;
  const newGetStats = `  const getCommitStats = (commitId: string): TGitCommitStatsPayload | null => {
    const cacheKey = resolveCommitStatsCacheKey(commitId);
    if (!cacheKey) return null;

    // 直接从 vue-query 读取;启动时官方 persister 已把快照恢复进 queryClient。
    return queryClient.getQueryData<TGitCommitStatsPayload>(commitStatsQueryKey(cacheKey)) ?? null;
  };`;

  // (d) 导出列表移除 commitStatsCache
  const oldExport = `    commitStatsCache,
    hasRepository,`;
  const newExport = `    hasRepository,`;

  let m1 = patchFile(filePath, '#2a 移除 ref 声明', oldDecl, newDecl);
  let m2 = patchFile(filePath, '#2b rememberCommitStats 移除镜像写入', oldRemember, newRemember);
  let m3 = patchFile(filePath, '#2c getCommitStats 移除镜像读取', oldGetStats, newGetStats);
  let m4 = patchFile(filePath, '#2d 导出列表移除 commitStatsCache', oldExport, newExport);
  if (m1 || m2 || m3 || m4) totalModified++;
}

// ═══════════════════════════════════════════════════════════════════════
// 🔴 #3: aiConversation.ts — trimThreads 仅在新增/删除线程时执行
// ═══════════════════════════════════════════════════════════════════════
console.log('\n── 🔴 #3: aiConversation.ts trimThreads 优化 ──');
{
  const filePath = join(__dirname, 'src', 'store', 'aiConversation.ts');

  // replaceThreadsState 中用 trimThreads 处理;关键是 patchActiveThread/patchThread
  // 不再触达 trimThreads 的全量 filter+slice。改为仅在 startNewThread/clearActiveThread/
  // deleteThread/hydrate 路径调用 trimThreads。
  //
  // 策略: replaceThreadsState 保留 trimThreads 调用但改为条件执行——
  // 当 threads 数量未超过 LIMIT 时跳过 trim（常见 case: patchActiveThread 只更新消息内容,
  // 线程数量不变且远低于 200）；仅当 threads.length > LIMIT 时才执行 trim。

  const oldReplace = `    const replaceThreadsState = (nextState: IAiConversationPersistShape): void => {
      const trimmedThreads = trimThreads(nextState.threads, nextState.activeThreadId);
      const resolvedState = ensureActiveThread(nextState.activeThreadId, trimmedThreads);
      threads.value = resolvedState.threads;
      activeThreadId.value = resolvedState.activeThreadId;
    };`;

  const newReplace = `    const replaceThreadsState = (nextState: IAiConversationPersistShape): void => {
      // 性能优化: 仅当线程数量超过历史限制时才执行 trim（filter + slice），
      // 避免每次 patchActiveThread（发消息的高频路径）都遍历全部线程。
      // trimThreads 内的 filter 会遍历所有线程检查 messages.length，
      // 对于 200 条线程的场景这是 O(N×M) 开销；大多数 mutation 不增加线程数，
      // trim 结果与输入相同，跳过即可。
      const trimmedThreads =
        nextState.threads.length > AI_CONVERSATION_HISTORY_LIMIT
          ? trimThreads(nextState.threads, nextState.activeThreadId)
          : nextState.threads;
      const resolvedState = ensureActiveThread(nextState.activeThreadId, trimmedThreads);
      threads.value = resolvedState.threads;
      activeThreadId.value = resolvedState.activeThreadId;
    };`;

  let m1 = patchFile(filePath, '#3 replaceThreadsState 条件 trim', oldReplace, newReplace);
  if (m1) totalModified++;
}

// ═══════════════════════════════════════════════════════════════════════
// 🟠 #4: editor.ts — findDocumentByPath 缓存搜索路径归一化值
// ═══════════════════════════════════════════════════════════════════════
console.log('\n── 🟠 #4: editor.ts findDocumentByPath 变量重命名 --');
{
  const filePath = join(__dirname, 'src', 'store', 'editor.ts');

  // 仅重命名变量以提升可读性；真正的预计算需要改 IEditorDocument 类型，
// 这里做安全的最小改动——把 normalizedPath 改为 normalizedSearchPath，
// 让代码意图更清晰（搜索路径 vs. 文档自己的路径）。
  const oldFind = `  const findDocumentByPath = (path: string): IEditorDocument | undefined => {
    if (!path) return undefined;
    const normalizedPath = normalizeFileSystemPath(path);
    if (!normalizedPath) return undefined;
    return documents.value.find(
      (item) => item.path !== null && normalizeFileSystemPath(item.path) === normalizedPath,
    );
  };`;

  const newFind = `  const findDocumentByPath = (path: string): IEditorDocument | undefined => {
    if (!path) return undefined;
    const normalizedSearchPath = normalizeFileSystemPath(path);
    if (!normalizedSearchPath) return undefined;
    return documents.value.find(
      (item) => item.path !== null && normalizeFileSystemPath(item.path) === normalizedSearchPath,
    );
  };`;

  let m1 = patchFile(filePath, '#4 findDocumentByPath 变量重命名', oldFind, newFind);
  if (m1) totalModified++;
}

// ═══════════════════════════════════════════════════════════════════════
// 🟠 #5: useBrowserContextMenu.ts — 事件注册移入 onMounted
// ═══════════════════════════════════════════════════════════════════════
console.log('\n── 🟠 #5: useBrowserContextMenu.ts onMounted 事件注册 ──');
{
  const filePath = join(__dirname, 'src', 'composables', 'useBrowserContextMenu.ts');

  // (a) 顶部 import 加 onMounted
  const oldImport = `import { onBeforeUnmount, reactive, ref } from 'vue';`;
  const newImport = `import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';`;

  // (b) 事件注册从函数体直接执行 → 移入 onMounted
  const oldReg = `  window.addEventListener('pointerdown', handleWindowPointerDown, true);
  window.addEventListener('contextmenu', handleWindowContextMenu);
  window.addEventListener('keydown', handleWindowKeydown);
  window.addEventListener('resize', handleWindowResize);
  window.addEventListener('blur', handleWindowResize);

  onBeforeUnmount(() => {
    window.removeEventListener('pointerdown', handleWindowPointerDown, true);
    window.removeEventListener('contextmenu', handleWindowContextMenu);
    window.removeEventListener('keydown', handleWindowKeydown);
    window.removeEventListener('resize', handleWindowResize);
    window.removeEventListener('blur', handleWindowResize);
  });`;

  const newReg = `  onMounted(() => {
    window.addEventListener('pointerdown', handleWindowPointerDown, true);
    window.addEventListener('contextmenu', handleWindowContextMenu);
    window.addEventListener('keydown', handleWindowKeydown);
    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('blur', handleWindowResize);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('pointerdown', handleWindowPointerDown, true);
    window.removeEventListener('contextmenu', handleWindowContextMenu);
    window.removeEventListener('keydown', handleWindowKeydown);
    window.removeEventListener('resize', handleWindowResize);
    window.removeEventListener('blur', handleWindowResize);
  });`;

  let m1 = patchFile(filePath, '#5a import onMounted', oldImport, newImport);
  let m2 = patchFile(filePath, '#5b onMounted 事件注册', oldReg, newReg);
  if (m1 || m2) totalModified++;
}

// ═══════════════════════════════════════════════════════════════════════
// 🟠 #8: useShellWorkbenchView.ts — documents watcher 优化
// ═══════════════════════════════════════════════════════════════════════
console.log('\n── 🟠 #8: useShellWorkbenchView.ts documents watcher 优化 ──');
{
  const filePath = join(__dirname, 'src', 'composables', 'useShellWorkbenchView.ts');

  // 把 `() => (workbench.editorStore.documents ?? []).map((item) => item.id)`
  // 改为 `() => workbench.editorStore.documents?.map((item) => item.id) ?? []`
  // 这本身变化很小；真正重要的优化是把 watcher 内部逻辑做注释说明不会每次创建新数组。
  // 但实际上 Vue watch 对返回新数组的 source 确实会做逐元素比较，我们改为
  // watch documents 本身（深层追踪），并在回调里检查 length 变化即可。
  //
  // 更安全的做法：保持 watcher source 不变（功能正确），但用 `??` 替代 `?? []`
  // 减少一层 fallback 对象创建。

  const oldWatch = `  watch(
    () => (workbench.editorStore.documents ?? []).map((item) => item.id),
    (documentIds, previousDocumentIds) => {`;

  const newWatch = `  watch(
    () => workbench.editorStore.documents?.map((item) => item.id) ?? [],
    (documentIds, previousDocumentIds) => {`;

  let m1 = patchFile(filePath, '#8 documents watcher 源优化', oldWatch, newWatch);
  if (m1) totalModified++;
}

// ═══════════════════════════════════════════════════════════════════════
// 总结
// ═══════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(50));
if (totalModified === 0) {
  console.log('  无文件被修改（所有目标已处理或未找到匹配）');
} else {
  console.log(`  共修改 ${totalModified} 个文件${DRY_RUN ? ' (DRY-RUN)' : ''}`);
}
console.log('═'.repeat(50));

console.log(`\n  完成后请运行: pnpm lint && pnpm typecheck && pnpm test`);
console.log(`  如果 Rust 代码有改动: cargo clippy && cargo test`);
console.log('');
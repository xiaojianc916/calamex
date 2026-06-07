import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKBENCH_TAB_LIMITS } from '@/constants/workbench';
import { useEditorStore } from '@/store/editor';
import { TERMINAL_RUN_LOG_CODES, TERMINAL_RUN_LOG_TITLES } from '@/utils/terminal-run';

const buildScriptPayload = (index: number) => ({
  path: `/tmp/${index}.sh`,
  name: `${index}.sh`,
  content: `#!/bin/bash\necho ${index}`,
  encoding: 'utf-8' as const,
  lineCount: 2,
  charCount: 22,
});

describe('editor store session state', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('允许超过 30 个轻量标签，直到专业上限才阻止继续打开', () => {
    const store = useEditorStore();

    for (let index = 0; index < 31; index += 1) {
      store.openDocumentTab(buildScriptPayload(index));
    }

    expect(store.documents.length).toBe(31);
    expect(store.sessionSnapshot.openTabs).toHaveLength(31);
    expect(store.canOpenMoreTabs).toBe(true);

    for (let index = 31; index < WORKBENCH_TAB_LIMITS.maxOpenTabs; index += 1) {
      store.openDocumentTab(buildScriptPayload(index));
    }

    expect(store.documents.length).toBe(WORKBENCH_TAB_LIMITS.maxOpenTabs);
    expect(store.sessionSnapshot.openTabs).toHaveLength(WORKBENCH_TAB_LIMITS.maxPersistedOpenTabs);
    expect(store.canOpenMoreTabs).toBe(false);
  });

  it('只淘汰干净的非活动文本缓冲区，保留活动/未保存/无路径文档', () => {
    const store = useEditorStore();

    const untitledDocument = store.createDocumentTab({
      content: '#!/bin/bash\necho untitled',
      name: 'untitled-special.sh',
    });

    const dirtyDocument = store.openDocumentTab(buildScriptPayload(0)).document;
    store.updateDocumentContent(dirtyDocument.id, '#!/bin/bash\necho dirty');

    for (let index = 1; index <= WORKBENCH_TAB_LIMITS.maxLoadedCleanTextBuffers + 5; index += 1) {
      store.openDocumentTab(buildScriptPayload(index));
    }

    const activeDocument = store.document;
    const loadedCleanInactiveDocuments = store.documents.filter(
      (item) =>
        item.kind === 'text' &&
        item.bufferLoaded !== false &&
        item.path !== null &&
        !item.isDirty &&
        item.id !== activeDocument.id,
    );

    expect(activeDocument.bufferLoaded).not.toBe(false);
    expect(store.getDocumentById(dirtyDocument.id)?.bufferLoaded).not.toBe(false);
    expect(store.getDocumentById(dirtyDocument.id)?.isDirty).toBe(true);
    expect(store.getDocumentById(untitledDocument.id)?.bufferLoaded).not.toBe(false);
    expect(loadedCleanInactiveDocuments.length).toBeLessThanOrEqual(
      WORKBENCH_TAB_LIMITS.maxLoadedCleanTextBuffers,
    );
    expect(store.documents.some((item) => item.bufferLoaded === false)).toBe(true);
  });

  it('支持创建元数据标签，并在真正打开时复用标签加载正文', () => {
    const store = useEditorStore();

    const { document: unloadedDocument, reusedExisting: createdFromMetadata } =
      store.openUnloadedTextDocumentTab('/tmp/lazy.sh', 'lazy.sh');

    expect(createdFromMetadata).toBe(false);
    expect(unloadedDocument.bufferLoaded).toBe(false);
    expect(unloadedDocument.content).toBe('');
    expect(unloadedDocument.isDirty).toBe(false);
    expect(store.sessionSnapshot.openTabs).toEqual([
      {
        path: '/tmp/lazy.sh',
        pinned: false,
        order: 0,
        kind: 'text',
      },
    ]);

    const { document: loadedDocument, reusedExisting } = store.openDocumentTab({
      path: '/tmp/lazy.sh',
      name: 'lazy.sh',
      content: '#!/bin/bash\necho lazy',
      encoding: 'utf-8',
      lineCount: 2,
      charCount: 22,
    });

    expect(reusedExisting).toBe(true);
    expect(loadedDocument.id).toBe(unloadedDocument.id);
    expect(loadedDocument.bufferLoaded).toBe(true);
    expect(loadedDocument.content).toContain('lazy');
    expect(loadedDocument.isDirty).toBe(false);
    expect(store.activeDocumentId).toBe(loadedDocument.id);
  });

  it('打开 Git Diff 预览会复用同一个只读标签且不写入会话标签', () => {
    const store = useEditorStore();

    store.openGitDiffDocument({
      id: 'git-diff:worktree:/tmp/repo:src/app.sh',
      repositoryRootPath: '/tmp/repo',
      path: '/tmp/repo/src/app.sh',
      relativePath: 'src/app.sh',
      title: 'src/app.sh · 工作区 Diff',
      mode: 'worktree',
      originalContent: 'echo 0\n',
      modifiedContent: 'echo 1\n',
      isEmpty: false,
    });
    store.openGitDiffDocument({
      id: 'git-diff:worktree:/tmp/repo:src/app.sh',
      repositoryRootPath: '/tmp/repo',
      path: '/tmp/repo/src/app.sh',
      relativePath: 'src/app.sh',
      title: 'src/app.sh · 工作区 Diff',
      mode: 'worktree',
      originalContent: 'echo 0\n',
      modifiedContent: 'echo 2\n',
      isEmpty: false,
    });

    expect(store.documents).toHaveLength(1);
    expect(store.document.kind).toBe('git-diff');
    expect(store.document.content).toContain('echo 2');
    expect(store.sessionSnapshot.openTabs).toEqual([]);
  });

  it('存在运行日志或终端输出时 hasRunArtifacts 为 true', () => {
    const store = useEditorStore();

    expect(store.hasRunArtifacts).toBe(false);

    store.appendLog('info', TERMINAL_RUN_LOG_TITLES.start, 'run start', {
      scope: 'run',
      runId: 'run-1',
      code: TERMINAL_RUN_LOG_CODES.start,
    });

    expect(store.hasRunArtifacts).toBe(true);

    store.clearLogs();
    expect(store.hasRunArtifacts).toBe(false);

    store.setTerminalOutput('hello');
    expect(store.hasRunArtifacts).toBe(true);
  });

  it('appendLog 会清洗 Windows 扩展路径前缀，避免运行日志展示异常路径', () => {
    const store = useEditorStore();

    const entry = store.appendLog(
      'error',
      'shfmt 格式化失败',
      String.raw`\\?\D:\test\test.sh:782:39: reached EOF without closing quote '\''`,
    );

    expect(entry.detail).toBe(
      String.raw`D:\test\test.sh:782:39: reached EOF without closing quote '\''`,
    );
  });
});

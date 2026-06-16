import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentPersistence } from '@/composables/useDocumentPersistence';
import { useAppStore } from '@/store/app';
import { useEditorStore } from '@/store/editor';
import type { IScriptFilePayload } from '@/types/editor';

const { mockMessages, mockTauriService, mockFormatShellScript } = vi.hoisted(() => ({
  mockMessages: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
  mockTauriService: {
    loadScript: vi.fn(),
    saveScript: vi.fn(),
    pickSavePath: vi.fn(),
  },
  mockFormatShellScript: vi.fn(),
}));

vi.mock('@/composables/useMessage', () => ({
  useMessage: () => mockMessages,
}));

vi.mock('@/services/tauri', () => ({
  tauriService: mockTauriService,
}));

vi.mock('@/utils/terminal/shfmt', () => ({
  formatShellScript: mockFormatShellScript,
}));

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
};

const createPayload = (path: string, content: string): IScriptFilePayload => ({
  path,
  name: path.split('/').pop() ?? 'script.sh',
  content,
  encoding: 'utf-8',
  lineCount: content.split('\n').length,
  charCount: content.length,
});

describe('useDocumentPersistence lifecycle guards', () => {
  let appStore: ReturnType<typeof useAppStore>;
  let editorStore: ReturnType<typeof useEditorStore>;
  let refreshGitRepositoryStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());
    appStore = useAppStore();
    editorStore = useEditorStore();
    refreshGitRepositoryStatus = vi.fn(() => Promise.resolve());

    appStore.settings.editor.formatOnSave = false;
    appStore.settings.editor.trimTrailingWhitespace = false;
    appStore.settings.editor.insertFinalNewline = false;

    vi.clearAllMocks();
  });

  it('格式化返回前文档继续编辑时，不用旧 shfmt 结果覆盖新内容', async () => {
    editorStore.openDocumentTab({
      path: '/workspace/demo.sh',
      name: 'demo.sh',
      content: 'echo before',
      encoding: 'utf-8',
    });
    const documentId = editorStore.document.id;
    const deferred = createDeferred<string>();
    mockFormatShellScript.mockReturnValueOnce(deferred.promise);

    const persistence = useDocumentPersistence({
      appStore,
      editorStore,
      refreshGitRepositoryStatus,
    });

    const formatting = persistence.formatDocumentWithShfmt(documentId);
    editorStore.updateDocumentContent(documentId, 'echo newer');

    deferred.resolve('echo formatted');
    const result = await formatting;

    expect(result).toBe(false);
    expect(editorStore.getDocumentById(documentId)?.content).toBe('echo newer');
    expect(mockMessages.success).not.toHaveBeenCalled();
  });

  it('保存返回前文档继续编辑时，不用旧保存结果覆盖新内容或清除脏标记', async () => {
    editorStore.openDocumentTab({
      path: '/workspace/demo.sh',
      name: 'demo.sh',
      content: 'echo before',
      encoding: 'utf-8',
    });
    const documentId = editorStore.document.id;
    editorStore.updateDocumentContent(documentId, 'echo saving');

    const deferred = createDeferred<IScriptFilePayload>();
    mockTauriService.saveScript.mockReturnValueOnce(deferred.promise);

    const persistence = useDocumentPersistence({
      appStore,
      editorStore,
      refreshGitRepositoryStatus,
    });

    const saving = persistence.saveDocument(documentId);
    await Promise.resolve();

    expect(mockTauriService.saveScript).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/workspace/demo.sh',
        content: 'echo saving',
        encoding: 'utf-8',
      }),
    );

    editorStore.updateDocumentContent(documentId, 'echo newer');
    deferred.resolve(createPayload('/workspace/demo.sh', 'echo saving'));

    const result = await saving;
    const document = editorStore.getDocumentById(documentId);

    expect(result).toBe(true);
    expect(document?.content).toBe('echo newer');
    expect(document?.savedContent).toBe('echo before');
    expect(document?.isDirty).toBe(true);
    expect(mockMessages.success).not.toHaveBeenCalled();
  });

  it('懒加载文档内容返回前路径状态已变化时，不回写旧 payload', async () => {
    const { document } = editorStore.openUnloadedTextDocumentTab('/workspace/demo.sh', 'demo.sh');
    const deferred = createDeferred<IScriptFilePayload>();
    mockTauriService.loadScript.mockReturnValueOnce(deferred.promise);

    const persistence = useDocumentPersistence({
      appStore,
      editorStore,
      refreshGitRepositoryStatus,
    });

    const saving = persistence.saveDocument(document.id);

    document.path = '/workspace/renamed.sh';
    deferred.resolve(createPayload('/workspace/demo.sh', 'echo old'));

    const result = await saving;

    expect(result).toBe(false);
    expect(editorStore.getDocumentById(document.id)?.path).toBe('/workspace/renamed.sh');
    expect(editorStore.getDocumentById(document.id)?.bufferLoaded).toBe(false);
  });
});

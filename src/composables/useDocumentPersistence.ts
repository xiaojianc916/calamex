import { useMessage } from '@/composables/useMessage';
import {
  applyWhitespaceConventions,
  resolveFormatter,
  runFormatPipeline,
} from '@/services/editor/formatting';
import { tauriService } from '@/services/tauri';
import type { useAppStore } from '@/store/app';
import type { useEditorStore } from '@/store/editor';
import type { IEditorDocument, IScriptFilePayload, TDocumentEncoding } from '@/types/editor';
import {
  buildCurrentDocumentFormatFeedback,
  buildDocumentSaveFeedback,
  buildWorkspaceDocumentFormatFeedback,
  type IEditorOperationFeedback,
} from '@/utils/document-persistence';
import { resolveLanguageForPath } from '@/utils/editor-language';
import { toErrorMessage } from '@/utils/error';
import { getRelativeFileSystemPath } from '@/utils/path';

type TAppStore = ReturnType<typeof useAppStore>;
type TEditorStore = ReturnType<typeof useEditorStore>;

type TUseDocumentPersistenceOptions = {
  appStore: TAppStore;
  editorStore: TEditorStore;
  refreshGitRepositoryStatus: (workspaceRootPath?: string | null) => Promise<void>;
};

type TTextSourceDocument = Pick<IScriptFilePayload, 'path' | 'name' | 'content' | 'encoding'>;

type TLoadedTextDocumentSnapshot = {
  id: string;
  path: string | null;
  name: string;
  content: string;
  encoding: TDocumentEncoding;
};

interface IPersistTextDocumentOptions {
  path: string;
  content: string;
  encoding: TDocumentEncoding;
  onSaved?: (payload: IScriptFilePayload) => void;
  shouldApplyResult?: (payload: IScriptFilePayload) => boolean;
  resolveSuccessFeedback: (payload: IScriptFilePayload) => IEditorOperationFeedback;
  failureTitle: string;
  fallbackFailureMessage: string;
  workspaceRootPath?: string | null;
}

const isTextDocument = (document: IEditorDocument): boolean => document.kind === 'text';

const isLoadedTextDocument = (document: IEditorDocument): boolean =>
  isTextDocument(document) && document.bufferLoaded !== false;

const createLoadedTextDocumentSnapshot = (
  document: IEditorDocument,
): TLoadedTextDocumentSnapshot | null => {
  if (!isLoadedTextDocument(document)) {
    return null;
  }

  return {
    id: document.id,
    path: document.path,
    name: document.name,
    content: document.content,
    encoding: document.encoding,
  };
};

export const useDocumentPersistence = ({
  appStore,
  editorStore,
  refreshGitRepositoryStatus,
}: TUseDocumentPersistenceOptions) => {
  const notifier = useMessage();

  const buildDefaultScriptContent = (): string => {
    const normalizedShebang =
      appStore.settings.editor.defaultShebang.trim() || '#!/usr/bin/env bash';
    const strictModeBlock = appStore.settings.editor.strictModeByDefault
      ? 'set -euo pipefail\n\n'
      : '';

    return `${normalizedShebang}\n\n${strictModeBlock}main() {\n  echo "Hello SH Editor"\n}\n\nmain "$@"\n`;
  };

  const buildWhitespaceConventions = () => ({
    trimTrailingWhitespace: appStore.settings.editor.trimTrailingWhitespace,
    insertFinalNewline: appStore.settings.editor.insertFinalNewline,
  });

  const normalizeDocumentContentForSave = (content: string): string =>
    applyWhitespaceConventions(content, buildWhitespaceConventions());

  const warnAndReturnFalse = (message: string): false => {
    notifier.warning(message);
    return false;
  };

  const reportPersistenceError = (
    title: string,
    fallbackMessage: string,
    error: unknown,
  ): false => {
    const message = toErrorMessage(error, fallbackMessage);
    editorStore.appendLog('error', title, message);
    notifier.error(title, message === title ? {} : { description: message });
    return false;
  };

  const notifyOperationSuccess = (feedback: IEditorOperationFeedback): true => {
    editorStore.appendLog('success', feedback.logTitle, feedback.logDetail);
    notifier.success(feedback.toastMessage);
    return true;
  };

  const resolveWorkspaceRootForPath = (path: string): string | null => {
    const workspaceRootPath = editorStore.workspaceRootPath;
    if (!workspaceRootPath) return null;
    return getRelativeFileSystemPath(path, workspaceRootPath) === null ? null : workspaceRootPath;
  };

  const loadTextPayload = async (path: string): Promise<IScriptFilePayload> =>
    tauriService.loadScript(path, resolveWorkspaceRootForPath(path));

  const applySaveConventionsToDocument = (documentId: string): IEditorDocument | null => {
    const targetDocument = editorStore.getDocumentById(documentId);
    if (!targetDocument || !isLoadedTextDocument(targetDocument)) {
      return null;
    }

    const normalizedContent = normalizeDocumentContentForSave(targetDocument.content);
    if (normalizedContent !== targetDocument.content) {
      editorStore.updateDocumentContent(documentId, normalizedContent);
    }

    return editorStore.getDocumentById(documentId);
  };

  const isLoadedTextDocumentSnapshotCurrent = (
    documentId: string,
    snapshot: TLoadedTextDocumentSnapshot,
  ): boolean => {
    const currentDocument = editorStore.getDocumentById(documentId);
    return Boolean(
      currentDocument &&
        isLoadedTextDocument(currentDocument) &&
        currentDocument.path === snapshot.path &&
        currentDocument.name === snapshot.name &&
        currentDocument.content === snapshot.content &&
        currentDocument.encoding === snapshot.encoding,
    );
  };

  const isUnloadedTextDocumentPathCurrent = (
    documentId: string,
    expectedPath: string | null,
  ): boolean => {
    const currentDocument = editorStore.getDocumentById(documentId);
    return Boolean(
      currentDocument &&
        isTextDocument(currentDocument) &&
        currentDocument.bufferLoaded === false &&
        currentDocument.path === expectedPath,
    );
  };

  const loadTextSourceDocument = async (path: string): Promise<TTextSourceDocument> => {
    const existingDocument = editorStore.findDocumentByPath(path);
    if (existingDocument) {
      if (!isTextDocument(existingDocument)) {
        throw new Error('当前目标不是可格式化的文本文件。');
      }

      if (existingDocument.bufferLoaded === false) {
        const documentId = existingDocument.id;
        const expectedPath = existingDocument.path;
        const payload = await loadTextPayload(path);

        if (isUnloadedTextDocumentPathCurrent(documentId, expectedPath)) {
          editorStore.applyDocumentPayload(documentId, payload);
        }

        return payload;
      }

      return {
        path: existingDocument.path,
        name: existingDocument.name,
        content: existingDocument.content,
        encoding: existingDocument.encoding,
      };
    }

    return loadTextPayload(path);
  };

  const persistTextDocument = async ({
    path,
    content,
    encoding,
    onSaved,
    shouldApplyResult,
    resolveSuccessFeedback,
    failureTitle,
    fallbackFailureMessage,
    workspaceRootPath,
  }: IPersistTextDocumentOptions): Promise<boolean> => {
    try {
      const payload = await tauriService.saveScript({
        path,
        content,
        encoding,
        workspaceRootPath: workspaceRootPath ?? resolveWorkspaceRootForPath(path),
      });

      if (shouldApplyResult && !shouldApplyResult(payload)) {
        void refreshGitRepositoryStatus(workspaceRootPath ?? resolveWorkspaceRootForPath(path));
        return true;
      }

      onSaved?.(payload);
      void refreshGitRepositoryStatus(workspaceRootPath ?? resolveWorkspaceRootForPath(path));
      return notifyOperationSuccess(resolveSuccessFeedback(payload));
    } catch (error) {
      return reportPersistenceError(failureTitle, fallbackFailureMessage, error);
    }
  };

  const markCurrentDocumentSavedWithoutContentChurn = (
    documentId: string,
    snapshot: TLoadedTextDocumentSnapshot,
    payload: IScriptFilePayload,
  ): boolean => {
    const currentDocument = editorStore.getDocumentById(documentId);
    if (
      !currentDocument ||
      !isLoadedTextDocument(currentDocument) ||
      currentDocument.path !== snapshot.path ||
      payload.path !== snapshot.path ||
      currentDocument.name !== snapshot.name ||
      payload.name !== snapshot.name ||
      currentDocument.content !== payload.content ||
      currentDocument.encoding !== payload.encoding
    ) {
      return false;
    }

    // 保存成功时，当前编辑器里的 content 已经是落盘内容。这里不要再走
    // applyDocumentPayload：它会整篇重新赋值并重算 metrics，触发 Vue/CodeMirror 的外部同步链路。
    // 只需要更新保存基线和 dirty 状态即可。
    currentDocument.savedContent = payload.content;
    currentDocument.savedEncoding = payload.encoding;
    currentDocument.isDirty = false;
    editorStore.clearDocumentDraft(payload.path);
    return true;
  };

  // 手动格式化当前文档：按语言解析 formatter（shell→shfmt(WASM)，其余→External 子进程，未命中退 whitespace 兜底/无操作）。
  // 结果写回 store 后，由编辑器的 computeDocChanges 以单事务最小 diff 应用。
  const formatDocumentWithShfmt = async (
    documentId = editorStore.document.id,
    options?: {
      suppressSuccessMessage?: boolean;
      suppressErrorMessage?: boolean;
    },
  ): Promise<boolean> => {
    const targetDocument = editorStore.getDocumentById(documentId);
    if (!targetDocument) {
      return warnAndReturnFalse('当前没有可格式化的脚本文件。');
    }

    if (!isTextDocument(targetDocument)) {
      return warnAndReturnFalse('当前图片预览不支持格式化。');
    }

    if (targetDocument.bufferLoaded === false) {
      return warnAndReturnFalse('当前文件内容尚未加载，请先切换到该标签页后再格式化。');
    }

    const snapshot = createLoadedTextDocumentSnapshot(targetDocument);
    if (!snapshot) {
      return false;
    }

    const languageId = resolveLanguageForPath(snapshot.path, snapshot.name);
    const result = await runFormatPipeline({
      text: snapshot.content,
      path: snapshot.path ?? snapshot.name,
      languageId,
      trigger: 'manual',
      formatter: resolveFormatter(languageId),
      whitespace: null,
    });

    if (!isLoadedTextDocumentSnapshotCurrent(documentId, snapshot)) {
      return false;
    }

    if (result.formatterFailed) {
      // 始终记录错误日志，便于排查；但在保存路径下可抑制弹窗（由调用方给出更友好的提示）。
      const message = result.formatterError ?? '格式化失败';
      editorStore.appendLog('error', '格式化失败', message);
      if (!options?.suppressErrorMessage) {
        notifier.error('格式化失败', message === '格式化失败' ? {} : { description: message });
      }
      return false;
    }

    const hasChanges = result.kind === 'changed';
    if (hasChanges) {
      editorStore.updateDocumentContent(documentId, result.text);
    }

    if (!options?.suppressSuccessMessage) {
      notifyOperationSuccess(buildCurrentDocumentFormatFeedback(snapshot.name, hasChanges));
    }

    return true;
  };

  const prepareDocumentForSave = async (documentId: string): Promise<IEditorDocument | null> => {
    const currentDocument = editorStore.getDocumentById(documentId);
    if (currentDocument?.kind === 'text' && currentDocument.bufferLoaded === false) {
      if (!currentDocument.path) {
        return null;
      }

      const expectedPath = currentDocument.path;
      const payload = await loadTextPayload(expectedPath);

      if (!isUnloadedTextDocumentPathCurrent(documentId, expectedPath)) {
        return null;
      }

      editorStore.applyDocumentPayload(documentId, payload);
    }

    // 开启“保存时格式化”时，按语言解析 formatter 跑格式化，并在同一管线里完成 whitespace
    // 规范化——只写回一次内容。旧实现先写回格式化结果、再写回规范化结果，多触发一次
    // 编辑器重排/重着色，是保存时“一闪一闪”的主因之一。
    if (appStore.settings.editor.formatOnSave) {
      const candidate = editorStore.getDocumentById(documentId);
      if (!candidate || !isLoadedTextDocument(candidate)) {
        return applySaveConventionsToDocument(documentId);
      }

      const snapshot = createLoadedTextDocumentSnapshot(candidate);
      if (!snapshot) {
        return null;
      }

      const languageId = resolveLanguageForPath(snapshot.path, snapshot.name);
      const result = await runFormatPipeline({
        text: snapshot.content,
        path: snapshot.path ?? snapshot.name,
        languageId,
        trigger: 'save',
        formatter: resolveFormatter(languageId),
        whitespace: buildWhitespaceConventions(),
      });

      if (!isLoadedTextDocumentSnapshotCurrent(documentId, snapshot)) {
        return applySaveConventionsToDocument(documentId);
      }

      if (result.formatterFailed) {
        // 格式化失败（通常是脚本语法错误）不应阻断保存：记录日志、提示用户，
        // 仍按 whitespace 约定保存（管线在 formatter 失败时已应用 whitespace）。
        editorStore.appendLog('error', '格式化失败', result.formatterError ?? '格式化失败');
        notifier.warning('保存时格式化失败，已跳过格式化直接保存，请检查脚本语法。');
      }

      if (result.kind === 'changed') {
        editorStore.updateDocumentContent(documentId, result.text);
      }

      return editorStore.getDocumentById(documentId);
    }

    return applySaveConventionsToDocument(documentId);
  };

  const formatWorkspaceFileByPath = async (path: string): Promise<boolean> => {
    try {
      const workspaceRootPath = resolveWorkspaceRootForPath(path);
      const existingBeforeFormat = editorStore.findDocumentByPath(path);
      const existingSnapshot =
        existingBeforeFormat && isLoadedTextDocument(existingBeforeFormat)
          ? createLoadedTextDocumentSnapshot(existingBeforeFormat)
          : null;
      const sourceDocument = await loadTextSourceDocument(path);
      const languageId = resolveLanguageForPath(sourceDocument.path, sourceDocument.name);
      const result = await runFormatPipeline({
        text: sourceDocument.content,
        path: sourceDocument.path ?? sourceDocument.name,
        languageId,
        trigger: 'manual',
        formatter: resolveFormatter(languageId),
        whitespace: null,
      });

      if (result.formatterFailed) {
        return reportPersistenceError(
          '工作区文件格式化失败',
          '工作区文件格式化失败',
          new Error(result.formatterError ?? '工作区文件格式化失败'),
        );
      }

      const hasChanges = result.kind === 'changed';
      const formattedContent = hasChanges ? result.text : sourceDocument.content;

      return persistTextDocument({
        path,
        content: formattedContent,
        encoding: sourceDocument.encoding,
        workspaceRootPath,
        onSaved: (payload) => {
          const existingDocument = editorStore.findDocumentByPath(path);
          if (!existingDocument || !isTextDocument(existingDocument)) {
            return;
          }

          if (
            existingSnapshot &&
            existingDocument.id === existingSnapshot.id &&
            !isLoadedTextDocumentSnapshotCurrent(existingSnapshot.id, existingSnapshot)
          ) {
            return;
          }

          editorStore.applyDocumentPayload(existingDocument.id, payload);
        },
        resolveSuccessFeedback: (payload) =>
          buildWorkspaceDocumentFormatFeedback(payload.name, payload.path, hasChanges),
        failureTitle: '工作区文件格式化失败',
        fallbackFailureMessage: '工作区文件格式化失败',
      });
    } catch (error) {
      if (error instanceof Error && error.message === '当前目标不是可格式化的文本文件。') {
        return warnAndReturnFalse(error.message);
      }

      return reportPersistenceError('工作区文件格式化失败', '工作区文件格式化失败', error);
    }
  };

  const saveDocumentAs = async (documentId = editorStore.document.id): Promise<boolean> => {
    const targetDocument = await prepareDocumentForSave(documentId);
    if (!targetDocument) {
      return false;
    }

    if (!isLoadedTextDocument(targetDocument)) {
      return warnAndReturnFalse('当前图片预览为只读模式，暂不支持另存为。');
    }

    const snapshot = createLoadedTextDocumentSnapshot(targetDocument);
    if (!snapshot) {
      return false;
    }

    let targetPath: string | null;
    try {
      targetPath = await tauriService.pickSavePath(snapshot.path ?? snapshot.name);
    } catch (error) {
      return reportPersistenceError('另存为失败', '另存为失败', error);
    }

    if (!targetPath) {
      return false;
    }

    return persistTextDocument({
      path: targetPath,
      content: snapshot.content,
      encoding: snapshot.encoding,
      shouldApplyResult: () => isLoadedTextDocumentSnapshotCurrent(documentId, snapshot),
      onSaved: (payload) => {
        editorStore.applyDocumentPayload(documentId, payload);
      },
      resolveSuccessFeedback: (payload) => buildDocumentSaveFeedback('save-as', payload.path),
      failureTitle: '另存为失败',
      fallbackFailureMessage: '另存为失败',
    });
  };

  const saveDocument = async (documentId = editorStore.document.id): Promise<boolean> => {
    const targetDocument = await prepareDocumentForSave(documentId);
    if (!targetDocument) {
      return false;
    }

    if (!isLoadedTextDocument(targetDocument)) {
      return warnAndReturnFalse('当前图片预览为只读模式，无需保存。');
    }

    if (!targetDocument.path) {
      return saveDocumentAs(documentId);
    }

    const snapshot = createLoadedTextDocumentSnapshot(targetDocument);
    if (!snapshot || !snapshot.path) {
      return false;
    }

    return persistTextDocument({
      path: snapshot.path,
      content: snapshot.content,
      encoding: snapshot.encoding,
      shouldApplyResult: () => isLoadedTextDocumentSnapshotCurrent(documentId, snapshot),
      onSaved: (payload) => {
        if (markCurrentDocumentSavedWithoutContentChurn(documentId, snapshot, payload)) {
          return;
        }
        editorStore.applyDocumentPayload(documentId, payload);
      },
      resolveSuccessFeedback: (payload) => buildDocumentSaveFeedback('save', payload.path),
      failureTitle: '保存失败',
      fallbackFailureMessage: '保存失败',
    });
  };

  const saveDirtyDocuments = async (documentIds: string[]): Promise<boolean> => {
    for (const documentId of documentIds) {
      const targetDocument = editorStore.getDocumentById(documentId);
      if (!targetDocument?.isDirty) {
        continue;
      }

      const saved = await saveDocument(documentId);
      if (!saved) {
        return false;
      }
    }

    return true;
  };

  return {
    buildDefaultScriptContent,
    formatDocumentWithShfmt,
    formatWorkspaceFileByPath,
    saveDocument,
    saveDocumentAs,
    saveDirtyDocuments,
  };
};

import { useMessage } from '@/composables/useMessage';
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

interface IPersistTextDocumentOptions {
  path: string;
  content: string;
  encoding: TDocumentEncoding;
  onSaved?: (payload: IScriptFilePayload) => void;
  resolveSuccessFeedback: (payload: IScriptFilePayload) => IEditorOperationFeedback;
  failureTitle: string;
  fallbackFailureMessage: string;
  workspaceRootPath?: string | null;
}

const formatShellScriptWithWasm = async (source: string, path?: string | null): Promise<string> => {
  const { formatShellScript } = await import('@/utils/shfmt');
  return formatShellScript(source, path);
};

const trimTrailingWhitespace = (content: string): string =>
  content
    .split('\n')
    .map((line) => line.replace(/[\t ]+$/u, ''))
    .join('\n');

const isTextDocument = (document: IEditorDocument): boolean => document.kind === 'text';

const isLoadedTextDocument = (document: IEditorDocument): boolean =>
  isTextDocument(document) && document.bufferLoaded !== false;

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

  const normalizeDocumentContentForSave = (content: string): string => {
    let nextContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    if (appStore.settings.editor.trimTrailingWhitespace) {
      nextContent = trimTrailingWhitespace(nextContent);
    }

    if (appStore.settings.editor.insertFinalNewline) {
      nextContent = nextContent.length > 0 ? nextContent.replace(/[\r\n]*$/u, '\n') : '';
    } else {
      nextContent = nextContent.replace(/[\r\n]+$/u, '');
    }

    return nextContent;
  };

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

  const loadTextSourceDocument = async (path: string): Promise<TTextSourceDocument> => {
    const existingDocument = editorStore.findDocumentByPath(path);
    if (existingDocument) {
      if (!isTextDocument(existingDocument)) {
        throw new Error('当前目标不是可由 shfmt 处理的脚本文本。');
      }

      if (existingDocument.bufferLoaded === false) {
        const payload = await loadTextPayload(path);
        editorStore.applyDocumentPayload(existingDocument.id, payload);
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

      onSaved?.(payload);
      void refreshGitRepositoryStatus();
      return notifyOperationSuccess(resolveSuccessFeedback(payload));
    } catch (error) {
      return reportPersistenceError(failureTitle, fallbackFailureMessage, error);
    }
  };

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
      return warnAndReturnFalse('当前图片预览不支持 shfmt 格式化。');
    }

    if (targetDocument.bufferLoaded === false) {
      return warnAndReturnFalse('当前文件内容尚未加载，请先切换到该标签页后再格式化。');
    }

    try {
      const formattedContent = await formatShellScriptWithWasm(
        targetDocument.content,
        targetDocument.path ?? targetDocument.name,
      );
      const hasChanges = formattedContent !== targetDocument.content;

      editorStore.updateDocumentContent(documentId, formattedContent);

      if (!options?.suppressSuccessMessage) {
        notifyOperationSuccess(buildCurrentDocumentFormatFeedback(targetDocument.name, hasChanges));
      }

      return true;
    } catch (error) {
      // 始终记录错误日志，便于排查；但在保存路径下可抑制弹窗（由调用方给出更友好的提示）。
      const message = toErrorMessage(error, 'shfmt 格式化失败');
      editorStore.appendLog('error', 'shfmt 格式化失败', message);
      if (!options?.suppressErrorMessage) {
        notifier.error(
          'shfmt 格式化失败',
          message === 'shfmt 格式化失败' ? {} : { description: message },
        );
      }
      return false;
    }
  };

  const prepareDocumentForSave = async (documentId: string): Promise<IEditorDocument | null> => {
    const currentDocument = editorStore.getDocumentById(documentId);
    if (currentDocument?.kind === 'text' && currentDocument.bufferLoaded === false) {
      if (!currentDocument.path) {
        return null;
      }
      const payload = await loadTextPayload(currentDocument.path);
      editorStore.applyDocumentPayload(documentId, payload);
    }

    const preparedDocument = applySaveConventionsToDocument(documentId);
    if (!preparedDocument || !isLoadedTextDocument(preparedDocument)) {
      return preparedDocument;
    }

    if (appStore.settings.editor.formatOnSave) {
      const formatted = await formatDocumentWithShfmt(documentId, {
        suppressSuccessMessage: true,
        suppressErrorMessage: true,
      });
      if (!formatted) {
        // 格式化失败（通常是脚本存在语法错误）不应阻断保存：
        // 跳过格式化，提示用户后按保存约定保存原始内容。
        notifier.warning('保存时格式化失败，已跳过格式化直接保存，请检查脚本语法。');
        return applySaveConventionsToDocument(documentId);
      }

      return applySaveConventionsToDocument(documentId);
    }

    return preparedDocument;
  };

  const formatWorkspaceFileByPath = async (path: string): Promise<boolean> => {
    try {
      const workspaceRootPath = resolveWorkspaceRootForPath(path);
      const sourceDocument = await loadTextSourceDocument(path);
      const formattedContent = await formatShellScriptWithWasm(
        sourceDocument.content,
        sourceDocument.path ?? sourceDocument.name,
      );
      const hasChanges = formattedContent !== sourceDocument.content;

      return persistTextDocument({
        path,
        content: formattedContent,
        encoding: sourceDocument.encoding,
        workspaceRootPath,
        onSaved: (payload) => {
          const existingDocument = editorStore.findDocumentByPath(path);
          if (existingDocument && isTextDocument(existingDocument)) {
            editorStore.applyDocumentPayload(existingDocument.id, payload);
          }
        },
        resolveSuccessFeedback: (payload) =>
          buildWorkspaceDocumentFormatFeedback(payload.name, payload.path, hasChanges),
        failureTitle: '工作区文件 shfmt 格式化失败',
        fallbackFailureMessage: '工作区文件 shfmt 格式化失败',
      });
    } catch (error) {
      if (error instanceof Error && error.message === '当前目标不是可由 shfmt 处理的脚本文本。') {
        return warnAndReturnFalse(error.message);
      }

      return reportPersistenceError(
        '工作区文件 shfmt 格式化失败',
        '工作区文件 shfmt 格式化失败',
        error,
      );
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

    let targetPath: string | null;
    try {
      targetPath = await tauriService.pickSavePath(targetDocument.path ?? targetDocument.name);
    } catch (error) {
      return reportPersistenceError('另存为失败', '另存为失败', error);
    }

    if (!targetPath) {
      return false;
    }

    return persistTextDocument({
      path: targetPath,
      content: targetDocument.content,
      encoding: targetDocument.encoding,
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

    return persistTextDocument({
      path: targetDocument.path,
      content: targetDocument.content,
      encoding: targetDocument.encoding,
      onSaved: (payload) => {
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

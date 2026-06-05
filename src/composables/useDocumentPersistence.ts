import { useDialog } from '@/composables/useDialog';
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

/** 仅用于内容比对:归一化换行符(CRLF / CR -> LF),避免因行尾差异误判为外部变更。 */
const stripLineEndingsForCompare = (content: string): string =>
  content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const isTextDocument = (document: IEditorDocument): boolean => document.kind === 'text';

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
    notifier.error(title, {
      ...(message === title ? {} : { description: message }),
    });
    return false;
  };

  const notifyOperationSuccess = (feedback: IEditorOperationFeedback): true => {
    editorStore.appendLog('success', feedback.logTitle, feedback.logDetail);
    notifier.success(feedback.toastMessage);
    return true;
  };

  const applySaveConventionsToDocument = (documentId: string): IEditorDocument | null => {
    const targetDocument = editorStore.getDocumentById(documentId);
    if (!targetDocument || !isTextDocument(targetDocument)) {
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

      return {
        path: existingDocument.path,
        name: existingDocument.name,
        content: existingDocument.content,
        encoding: existingDocument.encoding,
      };
    }

    return tauriService.loadScript(path);
  };

  const persistTextDocument = async ({
    path,
    content,
    encoding,
    onSaved,
    resolveSuccessFeedback,
    failureTitle,
    fallbackFailureMessage,
  }: IPersistTextDocumentOptions): Promise<boolean> => {
    try {
      const payload = await tauriService.saveScript({
        path,
        content,
        encoding,
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
        notifier.error('shfmt 格式化失败', {
          ...(message === 'shfmt 格式化失败' ? {} : { description: message }),
        });
      }
      return false;
    }
  };

  const prepareDocumentForSave = async (documentId: string): Promise<IEditorDocument | null> => {
    const preparedDocument = applySaveConventionsToDocument(documentId);
    if (!preparedDocument || !isTextDocument(preparedDocument)) {
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

    if (!isTextDocument(targetDocument)) {
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

  /**
   * 保存前检测磁盘是否已被外部修改(其他程序 / 编辑器改动了同一文件)。
   * 若磁盘内容与我们加载时的基线 (savedContent) 不一致,说明存在外部变更,
   * 直接覆盖会静默丢失对方的改动。此时弹窗让用户选择如何处理。
   *
   * 返回 'proceed' 表示继续保存(覆盖);'abort' 表示应中止保存
   * (用户取消,或已选择放弃本地修改并重新加载磁盘内容)。
   */
  const reconcileExternalDiskChange = async (
    documentId: string,
    targetDocument: IEditorDocument,
  ): Promise<'proceed' | 'abort'> => {
    if (!targetDocument.path) {
      return 'proceed';
    }

    let diskPayload: IScriptFilePayload;
    try {
      diskPayload = await tauriService.loadScript(targetDocument.path);
    } catch {
      // 读取失败(通常是文件已被删除 / 移动):无从对比,按正常保存流程处理。
      return 'proceed';
    }

    if (
      stripLineEndingsForCompare(diskPayload.content) ===
      stripLineEndingsForCompare(targetDocument.savedContent)
    ) {
      return 'proceed';
    }

    const action = await useDialog().confirm({
      title: '文件已被外部修改',
      description: `文件“${targetDocument.name}”在编辑器之外被修改过。继续保存会覆盖磁盘上的最新内容。`,
      confirmText: '覆盖保存',
      cancelText: '放弃我的修改并重新加载',
      dismissText: '取消',
      variant: 'warning',
    });

    if (action === 'confirm') {
      return 'proceed';
    }

    if (action === 'cancel') {
      editorStore.applyDocumentPayload(documentId, diskPayload);
      notifier.success('已放弃本地修改并重新加载磁盘最新内容。');
      return 'abort';
    }

    return 'abort';
  };

  const saveDocument = async (documentId = editorStore.document.id): Promise<boolean> => {
    const targetDocument = await prepareDocumentForSave(documentId);
    if (!targetDocument) {
      return false;
    }

    if (!isTextDocument(targetDocument)) {
      return warnAndReturnFalse('当前图片预览为只读模式，无需保存。');
    }

    if (!targetDocument.path) {
      return saveDocumentAs(documentId);
    }

    // 覆盖已落盘文件前,先检测磁盘是否被外部修改,避免静默覆盖。
    const reconciliation = await reconcileExternalDiskChange(documentId, targetDocument);
    if (reconciliation === 'abort') {
      return false;
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
    const failedNames: string[] = [];

    for (const documentId of documentIds) {
      const targetDocument = editorStore.getDocumentById(documentId);
      if (!targetDocument?.isDirty) {
        continue;
      }

      const saved = await saveDocument(documentId);
      if (!saved) {
        failedNames.push(targetDocument.name);
      }
    }

    if (failedNames.length > 0) {
      const detail = `以下文件未能保存：${failedNames.join('、')}`;
      editorStore.appendLog('error', '部分文件保存失败', detail);
      notifier.error('部分文件保存失败', { description: detail });
      return false;
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

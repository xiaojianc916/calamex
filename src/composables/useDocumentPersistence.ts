import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import type { useAppStore } from '@/store/app';
import type { useEditorStore } from '@/store/editor';
import type { IEditorDocument } from '@/types/editor';
import { toErrorMessage } from '@/utils/error';

type TAppStore = ReturnType<typeof useAppStore>;
type TEditorStore = ReturnType<typeof useEditorStore>;

type TUseDocumentPersistenceOptions = {
  appStore: TAppStore;
  editorStore: TEditorStore;
  refreshGitRepositoryStatus: (workspaceRootPath?: string | null) => Promise<void>;
};

const formatShellScriptWithWasm = async (
  source: string,
  path?: string | null,
): Promise<string> => {
  const { formatShellScript } = await import('@/utils/shfmt');
  return formatShellScript(source, path);
};

const trimTrailingWhitespace = (content: string): string =>
  content
    .split('\n')
    .map((line) => line.replace(/[\t ]+$/u, ''))
    .join('\n');

const isTextDocument = (document: IEditorDocument): boolean => document.kind === 'text';

export const useDocumentPersistence = ({
  appStore,
  editorStore,
  refreshGitRepositoryStatus,
}: TUseDocumentPersistenceOptions) => {
  const buildDefaultScriptContent = (): string => {
    const normalizedShebang = appStore.settings.editor.defaultShebang.trim() || '#!/usr/bin/env bash';
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

  const formatDocumentWithShfmt = async (
    documentId = editorStore.document.id,
    options?: {
      suppressSuccessMessage?: boolean;
    },
  ): Promise<boolean> => {
    const targetDocument = editorStore.getDocumentById(documentId);
    if (!targetDocument) {
      useMessage().warning('当前没有可格式化的脚本文件。');
      return false;
    }

    if (!isTextDocument(targetDocument)) {
      useMessage().warning('当前图片预览不支持 shfmt 格式化。');
      return false;
    }

    try {
      const formattedContent = await formatShellScriptWithWasm(
        targetDocument.content,
        targetDocument.path ?? targetDocument.name,
      );
      const hasChanges = formattedContent !== targetDocument.content;

      editorStore.updateDocumentContent(documentId, formattedContent);

      if (!options?.suppressSuccessMessage) {
        editorStore.appendLog(
          'success',
          'shfmt 格式化',
          hasChanges
            ? `已格式化当前文件：${targetDocument.name}。`
            : `当前文件已符合 shfmt 格式：${targetDocument.name}。`,
        );
        useMessage().success(
          hasChanges ? '已通过 shfmt 格式化当前文件' : '当前文件已符合 shfmt 格式',
        );
      }

      return true;
    } catch (error) {
      const message = toErrorMessage(error, 'shfmt 格式化失败');
      editorStore.appendLog('error', 'shfmt 格式化失败', message);
      useMessage().error(message);
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
      });
      if (!formatted) {
        return null;
      }

      return applySaveConventionsToDocument(documentId);
    }

    return preparedDocument;
  };

  const formatWorkspaceFileByPath = async (path: string): Promise<boolean> => {
    try {
      const existingDocument = editorStore.findDocumentByPath(path);
      if (existingDocument && !isTextDocument(existingDocument)) {
        useMessage().warning('当前目标不是可由 shfmt 处理的脚本文件。');
        return false;
      }

      const sourceDocument =
        existingDocument && isTextDocument(existingDocument)
          ? {
            path: existingDocument.path,
            name: existingDocument.name,
            content: existingDocument.content,
            encoding: existingDocument.encoding,
          }
          : await tauriService.loadScript(path);

      const formattedContent = await formatShellScriptWithWasm(
        sourceDocument.content,
        sourceDocument.path ?? sourceDocument.name,
      );
      const savedPayload = await tauriService.saveScript({
        path,
        content: formattedContent,
        encoding: sourceDocument.encoding,
      });
      const hasChanges = formattedContent !== sourceDocument.content;

      if (existingDocument && isTextDocument(existingDocument)) {
        editorStore.applyDocumentPayload(existingDocument.id, savedPayload);
      }

      void refreshGitRepositoryStatus();

      editorStore.appendLog(
        'success',
        'shfmt 格式化',
        `${hasChanges ? '已格式化文件' : '已检查文件'}：${savedPayload.path}`,
      );
      useMessage().success(
        hasChanges
          ? `已通过 shfmt 格式化 ${savedPayload.name}`
          : `${savedPayload.name} 已符合 shfmt 格式`,
      );
      return true;
    } catch (error) {
      const message = toErrorMessage(error, '工作区文件 shfmt 格式化失败');
      editorStore.appendLog('error', '工作区文件 shfmt 格式化失败', message);
      useMessage().error(message);
      return false;
    }
  };

  const saveDocumentAs = async (documentId = editorStore.document.id): Promise<boolean> => {
    const targetDocument = await prepareDocumentForSave(documentId);
    if (!targetDocument) {
      return false;
    }

    if (!isTextDocument(targetDocument)) {
      useMessage().warning('当前图片预览为只读模式，暂不支持另存为。');
      return false;
    }

    try {
      const targetPath = await tauriService.pickSavePath(
        targetDocument.path ?? targetDocument.name,
      );
      if (!targetPath) {
        return false;
      }

      const payload = await tauriService.saveScript({
        path: targetPath,
        content: targetDocument.content,
        encoding: targetDocument.encoding,
      });

      editorStore.applyDocumentPayload(documentId, payload);
      void refreshGitRepositoryStatus();
      editorStore.appendLog('success', '另存为成功', `保存路径：${payload.path}`);
      useMessage().success('脚本已另存为');
      return true;
    } catch (error) {
      const message = toErrorMessage(error, '另存为失败');
      editorStore.appendLog('error', '另存为失败', message);
      useMessage().error(message);
      return false;
    }
  };

  const saveDocument = async (documentId = editorStore.document.id): Promise<boolean> => {
    const targetDocument = await prepareDocumentForSave(documentId);
    if (!targetDocument) {
      return false;
    }

    if (!isTextDocument(targetDocument)) {
      useMessage().warning('当前图片预览为只读模式，无需保存。');
      return false;
    }

    if (!targetDocument.path) {
      return saveDocumentAs(documentId);
    }

    try {
      const payload = await tauriService.saveScript({
        path: targetDocument.path,
        content: targetDocument.content,
        encoding: targetDocument.encoding,
      });

      editorStore.applyDocumentPayload(documentId, payload);
      void refreshGitRepositoryStatus();
      editorStore.appendLog('success', '保存成功', `保存路径：${payload.path}`);
      useMessage().success('脚本已保存');
      return true;
    } catch (error) {
      const message = toErrorMessage(error, '保存失败');
      editorStore.appendLog('error', '保存失败', message);
      useMessage().error(message);
      return false;
    }
  };

  const saveDirtyDocuments = async (documentIds: string[]): Promise<boolean> => {
    for (const documentId of documentIds) {
      const targetDocument = editorStore.getDocumentById(documentId);
      if (!targetDocument || !targetDocument.isDirty) {
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
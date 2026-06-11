export interface IEditorOperationFeedback {
  logTitle: string;
  logDetail: string;
  toastMessage: string;
}

export const buildCurrentDocumentFormatFeedback = (
  documentName: string,
  hasChanges: boolean,
): IEditorOperationFeedback => ({
  logTitle: '格式化',
  logDetail: hasChanges
    ? `已格式化当前文件：${documentName}。`
    : `当前文件已符合格式规范：${documentName}。`,
  toastMessage: hasChanges ? '已格式化当前文件' : '当前文件已符合格式规范',
});

export const buildWorkspaceDocumentFormatFeedback = (
  documentName: string,
  documentPath: string,
  hasChanges: boolean,
): IEditorOperationFeedback => ({
  logTitle: '格式化',
  logDetail: `${hasChanges ? '已格式化文件' : '已检查文件'}：${documentPath}`,
  toastMessage: hasChanges
    ? `已格式化 ${documentName}`
    : `${documentName} 已符合格式规范`,
});

export const buildDocumentSaveFeedback = (
  mode: 'save' | 'save-as',
  documentPath: string,
): IEditorOperationFeedback => ({
  logTitle: mode === 'save-as' ? '另存为成功' : '保存成功',
  logDetail: `保存路径：${documentPath}`,
  toastMessage: mode === 'save-as' ? '脚本已另存为' : '脚本已保存',
});

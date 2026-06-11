import { describe, expect, it } from 'vitest';
import {
  buildCurrentDocumentFormatFeedback,
  buildDocumentSaveFeedback,
  buildWorkspaceDocumentFormatFeedback,
} from './document-persistence';

describe('document-persistence helpers', () => {
  it('生成当前文档格式化反馈', () => {
    expect(buildCurrentDocumentFormatFeedback('demo.sh', true)).toEqual({
      logTitle: '格式化',
      logDetail: '已格式化当前文件：demo.sh。',
      toastMessage: '已格式化当前文件',
    });

    expect(buildCurrentDocumentFormatFeedback('demo.sh', false)).toEqual({
      logTitle: '格式化',
      logDetail: '当前文件已符合格式规范：demo.sh。',
      toastMessage: '当前文件已符合格式规范',
    });
  });

  it('生成工作区文件格式化反馈', () => {
    expect(buildWorkspaceDocumentFormatFeedback('demo.sh', '/workspace/demo.sh', true)).toEqual({
      logTitle: '格式化',
      logDetail: '已格式化文件：/workspace/demo.sh',
      toastMessage: '已格式化 demo.sh',
    });
  });

  it('生成保存与另存为反馈', () => {
    expect(buildDocumentSaveFeedback('save', '/workspace/demo.sh')).toEqual({
      logTitle: '保存成功',
      logDetail: '保存路径：/workspace/demo.sh',
      toastMessage: '脚本已保存',
    });

    expect(buildDocumentSaveFeedback('save-as', '/workspace/demo-copy.sh')).toEqual({
      logTitle: '另存为成功',
      logDetail: '保存路径：/workspace/demo-copy.sh',
      toastMessage: '脚本已另存为',
    });
  });
});

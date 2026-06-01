import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultAppSettings, type IEditorSettings } from '@/types/settings';

// 用 sentinel 替身验证“接线逻辑”，不依赖第三方扩展的真实实现。
const indentationSentinel = Symbol('indentation-markers');
const mockIndentationMarkers = vi.fn(() => indentationSentinel);

vi.mock('@replit/codemirror-indentation-markers', () => ({
  indentationMarkers: (options?: unknown) => mockIndentationMarkers(options),
}));

import { buildCodeMirrorSettingsExtensions } from './codemirror-config';

const createEditorSettings = (overrides: Partial<IEditorSettings> = {}): IEditorSettings => ({
  ...createDefaultAppSettings().editor,
  ...overrides,
});

describe('buildCodeMirrorSettingsExtensions 缩进参考线接线', () => {
  beforeEach(() => {
    mockIndentationMarkers.mockClear();
  });

  it('indentGuides 开启时注入缩进参考线扩展，并启用当前块高亮', () => {
    const extensions = buildCodeMirrorSettingsExtensions(
      createEditorSettings({ indentGuides: true }),
    );

    expect(mockIndentationMarkers).toHaveBeenCalledTimes(1);
    expect(mockIndentationMarkers).toHaveBeenCalledWith({ highlightActiveBlock: true });
    expect(extensions).toContain(indentationSentinel);
  });

  it('indentGuides 关闭时不注入缩进参考线扩展', () => {
    const extensions = buildCodeMirrorSettingsExtensions(
      createEditorSettings({ indentGuides: false }),
    );

    expect(mockIndentationMarkers).not.toHaveBeenCalled();
    expect(extensions).not.toContain(indentationSentinel);
  });
});

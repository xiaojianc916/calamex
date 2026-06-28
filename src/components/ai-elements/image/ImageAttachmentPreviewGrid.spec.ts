import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ImageAttachmentPreviewGrid from './ImageAttachmentPreviewGrid.vue';

const fancyboxMock = vi.hoisted(() => ({
  bind: vi.fn(),
  unbind: vi.fn(),
  close: vi.fn(),
}));

vi.mock('@fancyapps/ui/dist/fancybox/', () => ({
  Fancybox: {
    bind: fancyboxMock.bind,
    unbind: fancyboxMock.unbind,
    close: fancyboxMock.close,
  },
}));

describe('ImageAttachmentPreviewGrid', () => {
  beforeEach(() => {
    fancyboxMock.bind.mockClear();
    fancyboxMock.unbind.mockClear();
    fancyboxMock.close.mockClear();
  });

  it('在消息区按原图比例渲染图片预览，避免截图被裁切成低清小方块', async () => {
    const wrapper = mount(ImageAttachmentPreviewGrid, {
      props: {
        variant: 'message',
        items: [
          {
            id: 'image-1',
            name: 'screenshot.png',
            preview: {
              src: 'blob:screenshot-preview',
              width: 2560,
              height: 1398,
              mimeType: 'image/png',
            },
          },
        ],
      },
    });

    await nextTick();

    const card = wrapper.get('.ai-attachment-card[data-variant="message"]');
    expect(card.classes()).toContain('is-image-preview');
    expect(card.attributes('style')).toContain(
      '--ai-attachment-preview-aspect-ratio: 2560 / 1398;',
    );
    const link = wrapper.get('.ai-image-attachment-preview-link');
    expect(link.attributes('href')).toBe('blob:screenshot-preview');
    expect(link.attributes('data-width')).toBe('2560');
    expect(link.attributes('data-height')).toBe('1398');
    expect(link.attributes('data-fancybox')).toBeTruthy();
    expect(wrapper.get('.ai-image-attachment-preview-link img').attributes('src')).toBe(
      'blob:screenshot-preview',
    );
    expect(fancyboxMock.bind).toHaveBeenCalledTimes(1);
  });

  it('非图片附件仍保持紧凑占位展示', () => {
    const wrapper = mount(ImageAttachmentPreviewGrid, {
      props: {
        variant: 'message',
        items: [
          {
            id: 'file-1',
            name: 'README.md',
            mediaType: 'text/plain',
          },
        ],
      },
    });

    const card = wrapper.get('.ai-attachment-card[data-variant="message"]');
    expect(card.classes()).not.toContain('is-image-preview');
    expect(card.attributes('style')).toBeUndefined();
    expect(wrapper.find('.ai-image-attachment-preview-link').exists()).toBe(false);
    expect(fancyboxMock.bind).not.toHaveBeenCalled();
  });
});

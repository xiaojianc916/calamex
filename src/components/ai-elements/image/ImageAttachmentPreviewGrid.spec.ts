import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ImageAttachmentPreviewGrid from './ImageAttachmentPreviewGrid.vue';

const lightboxMock = vi.hoisted(() => {
  const instances: Array<{
    init: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    loadAndOpen: ReturnType<typeof vi.fn>;
  }> = [];

  const ctor = vi.fn(function MockPhotoSwipeLightbox(this: Record<string, unknown>) {
    const instance = {
      init: vi.fn(),
      destroy: vi.fn(),
      loadAndOpen: vi.fn(() => true),
    };

    instances.push(instance);
    Object.assign(this, instance);
  });

  return { ctor, instances };
});

vi.mock('photoswipe/lightbox', () => ({
  default: lightboxMock.ctor,
}));

describe('ImageAttachmentPreviewGrid', () => {
  beforeEach(() => {
    lightboxMock.instances.length = 0;
    lightboxMock.ctor.mockClear();
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
    expect(wrapper.get('.ai-image-attachment-preview-link').attributes('data-pswp-width')).toBe(
      '2560',
    );
    expect(wrapper.get('.ai-image-attachment-preview-link').attributes('data-pswp-height')).toBe(
      '1398',
    );
    expect(wrapper.get('.ai-image-attachment-preview-link img').attributes('src')).toBe(
      'blob:screenshot-preview',
    );
    expect(lightboxMock.ctor).toHaveBeenCalledTimes(1);
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
    expect(lightboxMock.ctor).not.toHaveBeenCalled();
  });
});

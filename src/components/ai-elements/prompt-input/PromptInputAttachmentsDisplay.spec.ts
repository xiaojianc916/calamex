import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import PromptInputAttachmentsDisplay from '@/components/ai-elements/prompt-input/PromptInputAttachmentsDisplay.vue';
import type { IAiAttachedFile } from '@/types/ai';

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

const createImageAttachment = (): IAiAttachedFile => ({
  id: 'image-1',
  name: 'pasted-image.png',
  sizeLabel: '4.5 KB',
  kind: 'image',
  detailLabel: '665 × 329',
  preview: {
    src: 'data:image/png;base64,ZmFrZQ==',
    width: 665,
    height: 329,
    mimeType: 'image/png',
  },
  reference: {
    id: 'attachment:pasted-image.png:1:4608',
    kind: 'image-attachment',
    label: '图片附件 · pasted-image.png',
    path: 'pasted-image.png',
    range: null,
    contentPreview: '图片附件',
    redacted: false,
  },
});

const createTextAttachment = (): IAiAttachedFile => ({
  id: 'file-1',
  name: 'README.md',
  sizeLabel: '2.4 KB',
  kind: 'text',
  reference: {
    id: 'attachment:README.md:1:2400',
    kind: 'search-result',
    label: '附件 · README.md',
    path: 'README.md',
    range: null,
    contentPreview: 'README',
    redacted: false,
  },
});

describe('PromptInputAttachmentsDisplay', () => {
  beforeEach(() => {
    fancyboxMock.bind.mockClear();
    fancyboxMock.unbind.mockClear();
    fancyboxMock.close.mockClear();
  });

  it('为图片附件渲染缩略图并接入 Fancybox', async () => {
    const wrapper = mount(PromptInputAttachmentsDisplay, {
      props: {
        attachments: [createImageAttachment()],
      },
    });

    await nextTick();

    expect(fancyboxMock.bind).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.ai-image-attachment-preview-link').exists()).toBe(true);
    const link = wrapper.get('.ai-image-attachment-preview-link');
    expect(link.attributes('href')).toBe('data:image/png;base64,ZmFrZQ==');
    expect(link.attributes('data-width')).toBe('665');
    expect(link.attributes('data-caption')).toBe('pasted-image.png');
    expect(link.attributes('data-fancybox')).toBeTruthy();
    expect(wrapper.get('.ai-image-attachment-preview-link img').attributes('src')).toBe(
      'data:image/png;base64,ZmFrZQ==',
    );
    expect(wrapper.text()).not.toContain('665 × 329');
    expect(wrapper.text()).not.toContain('4.5 KB');

    await wrapper.get('.ai-image-attachment-preview-remove').trigger('click');
    expect(wrapper.emitted('remove')).toEqual([['image-1']]);

    wrapper.unmount();
    expect(fancyboxMock.unbind).toHaveBeenCalled();
  });

  it('保留文本附件胶囊展示', () => {
    const wrapper = mount(PromptInputAttachmentsDisplay, {
      props: {
        attachments: [createTextAttachment()],
      },
    });

    expect(wrapper.find('.ai-attachment-card[data-variant="composer"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('README.md');
    expect(wrapper.find('.ai-image-attachment-preview-link').exists()).toBe(false);
    expect(fancyboxMock.bind).not.toHaveBeenCalled();
  });
});

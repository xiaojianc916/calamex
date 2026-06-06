import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ImageAssetPreview from '@/components/editor/ImageAssetPreview.vue';
import { tauriService } from '@/services/tauri';

vi.mock('@/services/tauri', () => ({
  tauriService: {
    loadImageAsset: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

const mockedLoadImageAsset = vi.mocked(tauriService.loadImageAsset);

describe('ImageAssetPreview', () => {
  beforeEach(() => {
    mockedLoadImageAsset.mockReset();
  });

  it('展示真实图片元信息而不是模板变量名', async () => {
    mockedLoadImageAsset.mockResolvedValue({
      path: 'Snipaste/logo.png',
      name: 'logo.png',
      mimeType: 'image/png',
      byteSize: 2048,
    });

    const wrapper = mount(ImageAssetPreview, {
      props: {
        path: 'Snipaste/logo.png',
        name: 'logo.png',
      },
    });

    await flushPromises();

    expect(mockedLoadImageAsset).toHaveBeenCalledWith('Snipaste/logo.png');
    expect(wrapper.text()).toContain('logo.png');
    expect(wrapper.text()).toContain('image/png');
    expect(wrapper.text()).toContain('2.0 KB');
    expect(wrapper.text()).not.toContain('props.name');
    expect(wrapper.text()).not.toContain('assetMeta.mimeType');
    expect(wrapper.text()).not.toContain('formatBytes(assetMeta.byteSize)');
    expect(wrapper.text()).not.toContain('imageSizeLabel');

    const image = wrapper.get('img');
    expect(image.attributes('src')).toContain('asset://localhost/');
    Object.defineProperty(image.element, 'naturalWidth', {
      configurable: true,
      value: 1440,
    });
    Object.defineProperty(image.element, 'naturalHeight', {
      configurable: true,
      value: 900,
    });
    await image.trigger('load');

    expect(wrapper.text()).toContain('1440 × 900');
  });

  it('展示真实错误信息', async () => {
    mockedLoadImageAsset.mockRejectedValue(new Error('图片文件已损坏'));

    const wrapper = mount(ImageAssetPreview, {
      props: {
        path: 'Snipaste/broken.png',
        name: 'broken.png',
      },
    });

    await flushPromises();

    expect(wrapper.text()).toContain('图片文件已损坏');
    expect(wrapper.text()).not.toContain('errorMessage');
  });
});

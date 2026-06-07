import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeTauriCommandMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/tauri.ipc-runtime', () => ({
  invokeTauriCommand: invokeTauriCommandMock,
}));

import { openExternalUrl } from '@/utils/browser';

describe('openExternalUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('Tauri 打开失败时以安全参数在新标签打开链接', async () => {
    invokeTauriCommandMock.mockRejectedValueOnce(new Error('desktop runtime unavailable'));
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    openExternalUrl('https://example.com');
    await Promise.resolve();

    expect(invokeTauriCommandMock).toHaveBeenCalledWith('open_external_url', {
      url: 'https://example.com',
    });
    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { openExternalUrl } from '@/utils/browser';

describe('openExternalUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('以安全参数在新标签打开链接', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    openExternalUrl('https://example.com');
    expect(openSpy).toHaveBeenCalledWith(
      'https://example.com',
      '_blank',
      'noopener,noreferrer',
    );
  });
});

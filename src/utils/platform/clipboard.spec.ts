import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSystemPathToClipboard } from './clipboard';

describe('clipboard utils', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('复制文件系统路径时会移除 Windows 扩展路径前缀', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal('navigator', {
      clipboard: {
        writeText,
      },
    });

    await writeFileSystemPathToClipboard(String.raw`\\?\D:\test\xiaojianc.sh`);

    expect(writeText).toHaveBeenCalledWith(String.raw`D:\test\xiaojianc.sh`);
  });
});

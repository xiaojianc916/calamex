import { describe, expect, it } from 'vitest';
import { formatBytes, isImageAssetPath, isShellScriptPath } from '@/utils/file/file-assets';

describe('isImageAssetPath', () => {
  it('识别常见图片扩展名（大小写不敏感）', () => {
    expect(isImageAssetPath('photo.png')).toBe(true);
    expect(isImageAssetPath('PHOTO.JPG')).toBe(true);
    expect(isImageAssetPath('icon.svg')).toBe(true);
  });

  it('对非图片或缺省路径返回 false', () => {
    expect(isImageAssetPath('script.sh')).toBe(false);
    expect(isImageAssetPath('noext')).toBe(false);
    expect(isImageAssetPath(null)).toBe(false);
    expect(isImageAssetPath(undefined)).toBe(false);
  });

  it('兼容 Windows 反斜杠路径', () => {
    expect(isImageAssetPath(String.raw`C:\images\pic.jpeg`)).toBe(true);
  });
});

describe('isShellScriptPath', () => {
  it('识别 .sh 与 .bash（大小写不敏感）', () => {
    expect(isShellScriptPath('deploy.sh')).toBe(true);
    expect(isShellScriptPath('lib.bash')).toBe(true);
    expect(isShellScriptPath('RUN.SH')).toBe(true);
  });

  it('对其它扩展名或缺省路径返回 false', () => {
    expect(isShellScriptPath('main.zsh')).toBe(false);
    expect(isShellScriptPath('readme.md')).toBe(false);
    expect(isShellScriptPath(null)).toBe(false);
  });
});

describe('formatBytes', () => {
  it('对非正数或非有限值返回 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-100)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });

  it('小于 1KB 时以字节显示', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('KB 区间：小于 10KB 保留 1 位小数，否则取整', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1023 * 1024)).toBe('1023 KB');
  });

  it('MB 区间：小于 10MB 保留 1 位小数，否则取整', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
  });
});

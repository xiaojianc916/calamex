import { describe, expect, it } from 'vitest';
import {
  areFileSystemPathsEqual,
  formatFileSystemPathForDisplay,
  formatFileSystemTextForDisplay,
  getPathBaseName,
  joinDisplayedPath,
  normalizeFileSystemPath,
} from '@/utils/file/path';

describe('path utils', () => {
  it('会移除 Windows 扩展路径前缀，避免面包屑出现问号段', () => {
    expect(normalizeFileSystemPath(String.raw`\\?\D:\test\xiaojianc.sh`)).toBe(
      'd:/test/xiaojianc.sh',
    );
    expect(normalizeFileSystemPath('//?/D:/test/xiaojianc.sh')).toBe('d:/test/xiaojianc.sh');
  });

  it('会保留 UNC 路径语义并移除扩展路径前缀', () => {
    expect(normalizeFileSystemPath(String.raw`\\?\UNC\SERVER\Share\xiaojianc.sh`)).toBe(
      '//server/share/xiaojianc.sh',
    );
    expect(normalizeFileSystemPath('//?/UNC/SERVER/Share/xiaojianc.sh')).toBe(
      '//server/share/xiaojianc.sh',
    );
    expect(normalizeFileSystemPath('//?/unc/SERVER/Share/xiaojianc.sh')).toBe(
      '//server/share/xiaojianc.sh',
    );
  });

  it('使用规范化后的扩展路径参与文件名和路径相等判断', () => {
    expect(getPathBaseName(String.raw`\\?\D:\test\xiaojianc.sh`)).toBe('xiaojianc.sh');
    expect(
      areFileSystemPathsEqual(String.raw`\\?\D:\test\xiaojianc.sh`, 'd:/test/xiaojianc.sh'),
    ).toBe(true);
  });

  it('展示路径时会去掉 Windows 扩展路径前缀并保留常见分隔符习惯', () => {
    expect(formatFileSystemPathForDisplay(String.raw`\\?\D:\test\xiaojianc.sh`)).toBe(
      String.raw`D:\test\xiaojianc.sh`,
    );
    expect(formatFileSystemPathForDisplay(String.raw`\\?\UNC\SERVER\Share\demo.sh`)).toBe(
      String.raw`\\SERVER\Share\demo.sh`,
    );
    expect(formatFileSystemPathForDisplay('/workspace/demo.sh')).toBe('/workspace/demo.sh');
  });

  it('展示文案时会只清洗嵌入文本中的扩展路径前缀', () => {
    expect(
      formatFileSystemTextForDisplay(
        String.raw`保存路径：\\?\D:\test\xiaojianc.sh，定位：\\?\D:\test\xiaojianc.sh:12:3`,
      ),
    ).toBe(String.raw`保存路径：D:\test\xiaojianc.sh，定位：D:\test\xiaojianc.sh:12:3`);
  });

  it('拼接展示路径时会为绝对路径使用系统风格分隔符', () => {
    expect(joinDisplayedPath(String.raw`D:\test`, 'xiaojianc.sh')).toBe(
      String.raw`D:\test\xiaojianc.sh`,
    );
    expect(joinDisplayedPath('/workspace', 'demo.sh')).toBe('/workspace/demo.sh');
    expect(joinDisplayedPath('工作区 / src', 'demo.sh')).toBe('工作区 / src / demo.sh');
  });
});

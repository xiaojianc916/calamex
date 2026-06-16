import { describe, expect, it } from 'vitest';
import type { IFileIconAsset } from '@/types/file-icon';
import { resolveFileIconAsset } from '@/utils/file/file-icons';

const expectValidAsset = (asset: IFileIconAsset): void => {
  expect(typeof asset.darkSrc).toBe('string');
  expect(asset.darkSrc.length).toBeGreaterThan(0);
  expect(typeof asset.lightSrc).toBe('string');
  expect(asset.lightSrc.length).toBeGreaterThan(0);
};

describe('resolveFileIconAsset', () => {
  it('为目录返回有效图标资源（展开/折叠均可）', () => {
    expectValidAsset(resolveFileIconAsset({ kind: 'directory', path: 'src' }));
    expectValidAsset(resolveFileIconAsset({ kind: 'directory', path: 'src', expanded: true }));
  });

  it('无路径的文件返回默认文件图标', () => {
    expectValidAsset(resolveFileIconAsset({ kind: 'file' }));
  });

  it('为特例文件名（.env / README / LICENSE）解析图标', () => {
    expectValidAsset(resolveFileIconAsset({ kind: 'file', path: '.env' }));
    expectValidAsset(resolveFileIconAsset({ kind: 'file', path: 'README.md' }));
    expectValidAsset(resolveFileIconAsset({ kind: 'file', path: 'LICENSE' }));
  });

  it('按扩展名解析已知与未知类型', () => {
    expectValidAsset(resolveFileIconAsset({ kind: 'file', path: 'main.rs' }));
    expectValidAsset(resolveFileIconAsset({ kind: 'file', path: 'unknown.zzzzz' }));
  });

  it('对相同入参做记忆化（返回同一引用）', () => {
    const first = resolveFileIconAsset({ kind: 'file', path: 'app.ts' });
    const second = resolveFileIconAsset({ kind: 'file', path: 'app.ts' });
    expect(first).toBe(second);
  });
});

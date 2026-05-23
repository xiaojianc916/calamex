import { describe, expect, it } from 'vitest';

import { resolveLanguageForPath } from './editor-language';

describe('resolveLanguageForPath', () => {
  it.each([
    ['D:/repo/src/app.ts', null, 'typescript'],
    ['D:\\repo\\src\\app.ts', null, 'typescript'],
    ['\\\\?\\D:\\repo\\src\\app.ts', null, 'typescript'],
    ['//?/D:/repo/src/app.ts', null, 'typescript'],
    ['D:/repo/src/App.tsx', null, 'tsx'],
    ['D:\\repo\\src\\App.tsx', null, 'tsx'],
    ['D:/repo/src/App.vue', null, 'vue'],
    ['D:/repo/src/main.py', null, 'python'],
    ['D:/repo/src/lib.rs', null, 'rust'],
    ['D:/repo/src/main.c', null, 'c'],
    ['D:/repo/src/main.cpp', null, 'cpp'],
    ['D:/repo/Dockerfile', null, 'dockerfile'],
    ['D:\\repo\\Dockerfile', null, 'dockerfile'],
    ['D:/repo/Makefile', null, 'make'],
    ['D:\\repo\\Makefile', null, 'make'],
    [null, 'untitled.ts', 'typescript'],
    [null, 'untitled.sh', 'shell'],
    ['D:/repo/unknown.custom', null, 'plaintext'],
    [null, null, 'plaintext'],
  ])('根据路径 %s 和文件名 %s 推断为 %s', (path, name, expected) => {
    expect(resolveLanguageForPath(path, name)).toBe(expected);
  });
});

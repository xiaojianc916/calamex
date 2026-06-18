import { describe, expect, it } from 'vitest';

import {
  CODEMIRROR_LANGUAGE_LABELS,
  CODEMIRROR_SUPPORTED_LANGUAGE_IDS,
  normalizeCodeMirrorLanguageTag,
  resolveCodeMirrorLanguageId,
} from '@/services/editor/codemirror-language';

import { LANGUAGE_DEFINITIONS } from './language-registry';

describe('language-registry 一致性(漂移守卫)', () => {
  it('规范 id 唯一', () => {
    const ids = LANGUAGE_DEFINITIONS.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('扩展名不会映射到多个语言', () => {
    const seen = new Map<string, string>();
    for (const def of LANGUAGE_DEFINITIONS) {
      for (const ext of def.extensions ?? []) {
        expect(seen.get(ext) ?? def.id).toBe(def.id);
        seen.set(ext, def.id);
      }
    }
  });

  it('精确文件名不会映射到多个语言', () => {
    const seen = new Map<string, string>();
    for (const def of LANGUAGE_DEFINITIONS) {
      for (const name of def.filenames ?? []) {
        expect(seen.get(name) ?? def.id).toBe(def.id);
        seen.set(name, def.id);
      }
    }
  });

  it('CodeMirror 标签(id + alias)不会映射到多个语言', () => {
    const seen = new Map<string, string>();
    for (const def of LANGUAGE_DEFINITIONS) {
      if (!def.codemirror) {
        continue;
      }
      for (const tag of [def.id, ...(def.aliases ?? [])]) {
        expect(seen.get(tag) ?? def.id).toBe(def.id);
        seen.set(tag, def.id);
      }
    }
  });

  it('CodeMirror loader 与 registry(codemirror:true)一一对应', () => {
    const registryCmIds = LANGUAGE_DEFINITIONS.filter((def) => def.codemirror)
      .map((def) => def.id)
      .sort();
    const loaderIds = [...CODEMIRROR_SUPPORTED_LANGUAGE_IDS].sort();
    expect(loaderIds).toEqual(registryCmIds);
  });

  it('每个 CodeMirror 语言都有标签,且包含 text', () => {
    expect(CODEMIRROR_LANGUAGE_LABELS.text).toBe('Plain Text');
    for (const id of CODEMIRROR_SUPPORTED_LANGUAGE_IDS) {
      expect(typeof CODEMIRROR_LANGUAGE_LABELS[id]).toBe('string');
    }
  });
});

describe('resolveCodeMirrorLanguageId 规范化(单一 canonical id)', () => {
  it.each([
    ['shell', 'shell'],
    ['bash', 'shell'],
    ['sh', 'shell'],
    ['zsh', 'shell'],
    ['shellscript', 'shell'],
    ['proto', 'proto'],
    ['protobuf', 'proto'],
    ['json', 'json'],
    ['jsonc', 'json'],
    ['json5', 'json'],
    ['xml', 'xml'],
    ['svg', 'xml'],
    ['js', 'javascript'],
    ['javascript', 'javascript'],
    ['jsx', 'jsx'],
    ['ts', 'typescript'],
    ['tsx', 'tsx'],
    ['css', 'css'],
    ['scss', 'scss'],
    ['less', 'less'],
    ['cpp', 'cpp'],
    ['c++', 'cpp'],
    ['c', 'c'],
    ['h', 'c'],
    ['cs', 'csharp'],
    ['c#', 'csharp'],
    ['htm', 'html'],
    ['md', 'markdown'],
    ['docker', 'dockerfile'],
    ['patch', 'diff'],
    ['properties', 'ini'],
    ['conf', 'ini'],
    ['yml', 'yaml'],
    ['tex', 'latex'],
    ['stex', 'latex'],
  ])('标签 %s 解析为规范 id %s', (tag, expected) => {
    expect(resolveCodeMirrorLanguageId(tag)).toBe(expected);
  });

  it.each([
    [''],
    ['text'],
    ['txt'],
    ['plaintext'],
    ['bat'],
    ['cmd'],
    ['php'],
    ['make'],
    ['clojure'],
    ['mermaid'],
    ['mdx'],
    ['ksh'],
    ['unknown-language'],
  ])('无 CodeMirror 解析器的标签 %s 回退为 text', (tag) => {
    expect(resolveCodeMirrorLanguageId(tag)).toBe('text');
  });

  it('大小写与首尾空白不敏感', () => {
    expect(resolveCodeMirrorLanguageId('  BASH  ')).toBe('shell');
    expect(normalizeCodeMirrorLanguageTag('  JS ')).toBe('javascript');
    expect(normalizeCodeMirrorLanguageTag('')).toBe('text');
  });
});

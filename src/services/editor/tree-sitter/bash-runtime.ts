import { Edit, type Node, Parser, type Point, type Tree } from 'web-tree-sitter';
import { ensureTreeSitterLanguage } from './core-runtime';
import { TREE_SITTER_LANGUAGES } from './language-registry.generated';

/**
 * tree-sitter bash 运行时与坐标换算原语。
 *
 * 终端补全(shell-completion)与编辑器语言服务(codemirror-bash-language)共用同一份
 * Parser / Language 单例与同一套 UTF-8 字节坐标换算,避免两套 wasm 初始化与重复实现。
 * tree-sitter 节点以字节为坐标,CodeMirror 位置以字符(UTF-16 码元)为坐标,故两侧映射
 * 必须经由本模块的字节<->字符换算,确保非 ASCII 文本下折叠/缩进/结构选区定位准确。
 */

let parserPromise: Promise<Parser> | null = null;

/**
 * 复用通用高亮引擎（codemirror-tree-sitter-highlight）同一份 shell Language 缓存：
 * cacheKey 与 wasm 来源都取自 language-registry（唯一真源），既避免本模块曾经独立
 * Parser.init + Language.load 造成的「同一语法加载两份、内存翻倍」，也消除了两处各自
 * 指向不同 bash wasm 文件（npm 包 vs 自编译产物）的版本漂移风险。
 */
export const ensureBashLanguage = () =>
  ensureTreeSitterLanguage('shell', TREE_SITTER_LANGUAGES.shell.wasmUrl);

/** 复用单例 Parser:避免每次解析都 new/delete 一个 tree-sitter 解析器。 */
export const ensureBashParser = async (): Promise<Parser> => {
  if (!parserPromise) {
    parserPromise = (async () => {
      try {
        const language = await ensureBashLanguage();
        const parser = new Parser();
        parser.setLanguage(language);
        return parser;
      } catch (error) {
        parserPromise = null;
        throw error;
      }
    })();
  }
  return parserPromise;
};

// 计算 source[start, end) 子串的 UTF-8 字节长度,避免生成中间子串与 Uint8Array。
// 行为与 TextEncoder().encode().byteLength 一致:完整代理对计 4 字节,孤立代理项按
// U+FFFD 计 3 字节。
export const utf8ByteLengthOfRange = (source: string, start: number, end: number): number => {
  let bytes = 0;
  let index = start;
  while (index < end) {
    const code = source.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
      index += 1;
    } else if (code < 0x800) {
      bytes += 2;
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < end) {
      const nextCode = source.charCodeAt(index + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        bytes += 4;
        index += 2;
      } else {
        bytes += 3;
        index += 1;
      }
    } else {
      bytes += 3;
      index += 1;
    }
  }
  return bytes;
};

export const getUtf8ByteLength = (value: string): number =>
  utf8ByteLengthOfRange(value, 0, value.length);

// 字节偏移 -> 字符下标(tree-sitter 节点 startIndex/endIndex 是字节坐标,映射回
// CodeMirror 文档位置时需要本函数)。若字节偏移落在多字节字符中间,返回该字符之后的
// 下标(向上取整到字符边界)。
export const byteOffsetToCharIndex = (source: string, byteOffset: number): number => {
  if (byteOffset <= 0) {
    return 0;
  }
  let bytes = 0;
  let index = 0;
  const length = source.length;
  while (index < length && bytes < byteOffset) {
    const code = source.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
      index += 1;
    } else if (code < 0x800) {
      bytes += 2;
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < length) {
      const nextCode = source.charCodeAt(index + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        bytes += 4;
        index += 2;
      } else {
        bytes += 3;
        index += 1;
      }
    } else {
      bytes += 3;
      index += 1;
    }
  }
  return index;
};

// 将字符下标转换为 tree-sitter 期望的字节坐标 Point(与 getUtf8ByteLength 的约定一致)。
export const toBytePoint = (source: string, charIndex: number): Point => {
  let row = 0;
  let lineStartChar = 0;
  for (let index = 0; index < charIndex; index += 1) {
    if (source.charCodeAt(index) === 10) {
      row += 1;
      lineStartChar = index + 1;
    }
  }
  return {
    row,
    column: utf8ByteLengthOfRange(source, lineStartChar, charIndex),
  };
};

// 通过最小公共前后缀计算单段替换编辑;该编辑精确描述 oldSource -> newSource 的差异,
// 故 tree-sitter 增量重解析结果始终正确(即便两段文本不相关,最多退化为全量解析)。
export const computeBashSourceEdit = (oldSource: string, newSource: string): Edit => {
  const oldLength = oldSource.length;
  const newLength = newSource.length;
  const prefixLimit = Math.min(oldLength, newLength);
  let startChar = 0;
  while (
    startChar < prefixLimit &&
    oldSource.charCodeAt(startChar) === newSource.charCodeAt(startChar)
  ) {
    startChar += 1;
  }
  let oldEndChar = oldLength;
  let newEndChar = newLength;
  while (
    oldEndChar > startChar &&
    newEndChar > startChar &&
    oldSource.charCodeAt(oldEndChar - 1) === newSource.charCodeAt(newEndChar - 1)
  ) {
    oldEndChar -= 1;
    newEndChar -= 1;
  }
  return new Edit({
    startIndex: utf8ByteLengthOfRange(newSource, 0, startChar),
    oldEndIndex: utf8ByteLengthOfRange(oldSource, 0, oldEndChar),
    newEndIndex: utf8ByteLengthOfRange(newSource, 0, newEndChar),
    startPosition: toBytePoint(newSource, startChar),
    oldEndPosition: toBytePoint(oldSource, oldEndChar),
    newEndPosition: toBytePoint(newSource, newEndChar),
  });
};

export type { Node, Point, Tree };

import { Language, Parser } from 'web-tree-sitter';
import treeSitterWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';

/**
 * tree-sitter 核心运行时的唯一入口：Parser.init（wasm 引擎）与按 key 缓存的 Language 加载。
 *
 * 所有消费者（通用高亮引擎 codemirror-tree-sitter-highlight、bash 语言服务
 * tree-sitter/bash-runtime、终端补全 shell-completion 等）都必须经由本模块获取 Language，
 * 禁止各自独立 Parser.init / Language.load。同一 cacheKey 只会触发一次 wasm 解码与语法编译，
 * 后续调用直接复用同一个 Promise<Language>，避免同一语法被加载多份、占用双倍内存，也避免
 * 不同调用点各自指向不同 wasm 文件造成的语法版本漂移。
 */

let corePromise: Promise<void> | null = null;

export function ensureTreeSitterCore(): Promise<void> {
  if (!corePromise) {
    corePromise = Parser.init({ locateFile: () => treeSitterWasmUrl }).catch((error) => {
      corePromise = null;
      throw error;
    });
  }
  return corePromise;
}

const languagePromises = new Map<string, Promise<Language>>();

/** 按 cacheKey 缓存加载 Language；同一 cacheKey 重复调用直接复用同一个 Promise。 */
export function ensureTreeSitterLanguage(cacheKey: string, wasmUrl: string): Promise<Language> {
  let promise = languagePromises.get(cacheKey);
  if (!promise) {
    promise = (async () => {
      await ensureTreeSitterCore();
      return Language.load(wasmUrl);
    })().catch((error) => {
      languagePromises.delete(cacheKey);
      throw error;
    });
    languagePromises.set(cacheKey, promise);
  }
  return promise;
}

const parserPromises = new Map<string, Promise<Parser>>();

/** 按 cacheKey 缓存已绑定语言的 Parser 实例；同一 cacheKey 的所有消费者共用同一个 Parser。 */
export function ensureTreeSitterParser(cacheKey: string, wasmUrl: string): Promise<Parser> {
  let promise = parserPromises.get(cacheKey);
  if (!promise) {
    promise = (async () => {
      const language = await ensureTreeSitterLanguage(cacheKey, wasmUrl);
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })().catch((error) => {
      parserPromises.delete(cacheKey);
      throw error;
    });
    parserPromises.set(cacheKey, promise);
  }
  return promise;
}

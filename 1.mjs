// 5-unify-bash-runtime.mjs — 消除 bash 语法重复加载，统一为共享 Language 缓存 + 单一 wasm 来源
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const CORE_RUNTIME_PATH = join(ROOT, "src/services/editor/tree-sitter/core-runtime.ts")
const HIGHLIGHT_TS = join(ROOT, "src/services/editor/codemirror-tree-sitter-highlight.ts")
const BASH_RUNTIME_TS = join(ROOT, "src/services/editor/tree-sitter/bash-runtime.ts")

// ── 1) 新建共享核心运行时：唯一的 Parser.init + 按 cacheKey 缓存的 Language.load ──
const CORE_RUNTIME_CONTENT = `import { Language, Parser } from 'web-tree-sitter';
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
`
mkdirSync(join(ROOT, "src/services/editor/tree-sitter"), { recursive: true })
writeFileSync(CORE_RUNTIME_PATH, CORE_RUNTIME_CONTENT, "utf8")
console.log("✅ 新建 core-runtime.ts")

// ── 2) codemirror-tree-sitter-highlight.ts：core/Language 加载改为委托给 core-runtime ──
{
	let content = readFileSync(HIGHLIGHT_TS, "utf8")

	const oldImportLine = `import { Language, Parser, Query } from 'web-tree-sitter';\nimport treeSitterWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';`
	const newImportLine = `import { Language, Parser, Query } from 'web-tree-sitter';\nimport { ensureTreeSitterLanguage } from './tree-sitter/core-runtime';`

	const oldCoreBlock = `// 每语言的 Parser / Query 单例缓存（tree-sitter 查询是为逐键解析设计的，编译一次即可复用）。
let corePromise: Promise<void> | null = null;
const languagePromises = new Map<string, Promise<Language>>();
const parserPromises = new Map<string, Promise<Parser>>();
const queryCache = new Map<string, Query>();

function ensureCore(): Promise<void> {
  if (!corePromise) {
    console.info('[tsh] Parser.init core wasm =', treeSitterWasmUrl);
    corePromise = Parser.init({ locateFile: () => treeSitterWasmUrl }).catch((e) => {
      console.error('[tsh] Parser.init FAILED', e);
      corePromise = null;
      throw e;
    });
  }
  return corePromise;
}

function ensureLanguage(langId: string): Promise<Language> {
  let promise = languagePromises.get(langId);
  if (!promise) {
    const entry = TREE_SITTER_LANGUAGES[langId];
    promise = (async () => {
      await ensureCore();
      return Language.load(entry.wasmUrl);
    })();
    languagePromises.set(langId, promise);
  }
  return promise;
}`

	const newCoreBlock = `// 每语言的 Parser / Query 单例缓存（tree-sitter 查询是为逐键解析设计的，编译一次即可复用）。
// Language 加载统一委托给 tree-sitter/core-runtime：与 bash-runtime 等其他消费者共享同一份
// 已编译 Language（按 langId 缓存），避免同一语法被独立加载多份。
const parserPromises = new Map<string, Promise<Parser>>();
const queryCache = new Map<string, Query>();

function ensureLanguage(langId: string): Promise<Language> {
  const entry = TREE_SITTER_LANGUAGES[langId];
  return ensureTreeSitterLanguage(langId, entry.wasmUrl);
}`

	if (!content.includes(oldImportLine)) {
		console.log("⚠️ 未找到 highlight 文件的原始 import 行，跳过 import 替换，请人工检查")
	} else {
		content = content.replace(oldImportLine, newImportLine)
	}

	if (!content.includes(oldCoreBlock)) {
		console.log("⚠️ 未找到 highlight 文件的原始 core 加载块，跳过该项替换，请人工检查")
	} else {
		content = content.replace(oldCoreBlock, newCoreBlock)
		console.log("✅ codemirror-tree-sitter-highlight.ts 已改为委托 core-runtime")
	}

	writeFileSync(HIGHLIGHT_TS, content, "utf8")
}

// ── 3) bash-runtime.ts：Language 加载改为复用共享缓存（cacheKey='shell'，wasm 来源统一为 registry） ──
{
	let content = readFileSync(BASH_RUNTIME_TS, "utf8")

	const oldHeader = `import bashLanguageWasmUrl from 'tree-sitter-bash/tree-sitter-bash.wasm?url';
import { Edit, Language, type Node, Parser, type Point, type Tree } from 'web-tree-sitter';
import treeSitterWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';`

	const newHeader = `import { Edit, type Node, Parser, type Point, type Tree } from 'web-tree-sitter';
import { ensureTreeSitterLanguage } from './core-runtime';
import { TREE_SITTER_LANGUAGES } from './language-registry.generated';`

	const oldLoaders = `let runtimePromise: Promise<Language> | null = null;
let parserPromise: Promise<Parser> | null = null;

/** 加载并缓存 bash 文法;失败时清空 promise 以便下次重试。 */
export const ensureBashLanguage = async (): Promise<Language> => {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      try {
        await Parser.init({ locateFile: () => treeSitterWasmUrl });
        return await Language.load(bashLanguageWasmUrl);
      } catch (error) {
        runtimePromise = null;
        throw error;
      }
    })();
  }
  return runtimePromise;
};`

	const newLoaders = `let parserPromise: Promise<Parser> | null = null;

/**
 * 复用通用高亮引擎（codemirror-tree-sitter-highlight）同一份 shell Language 缓存：
 * cacheKey 与 wasm 来源都取自 language-registry（唯一真源），既避免本模块曾经独立
 * Parser.init + Language.load 造成的「同一语法加载两份、内存翻倍」，也消除了两处各自
 * 指向不同 bash wasm 文件（npm 包 vs 自编译产物）的版本漂移风险。
 */
export const ensureBashLanguage = () =>
  ensureTreeSitterLanguage('shell', TREE_SITTER_LANGUAGES.shell.wasmUrl);`

	if (!content.includes(oldHeader)) {
		console.log("⚠️ 未找到 bash-runtime 原始 import 头，跳过替换，请人工检查")
	} else {
		content = content.replace(oldHeader, newHeader)
	}

	if (!content.includes(oldLoaders)) {
		console.log("⚠️ 未找到 bash-runtime 原始 ensureBashLanguage 实现，跳过替换，请人工检查")
	} else {
		content = content.replace(oldLoaders, newLoaders)
		console.log("✅ bash-runtime.ts 已改为复用共享 Language 缓存")
	}

	writeFileSync(BASH_RUNTIME_TS, content, "utf8")
}

console.log("\n完成。重启 dev，打开 .sh 文件确认：高亮 / 折叠 / 缩进 / 结构选区（Mod-i）均正常。")
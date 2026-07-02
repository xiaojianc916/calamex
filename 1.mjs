// 11-tree-sitter-structure.mjs — 用通用 tree-sitter 折叠/缩进引擎替换 legacy-modes 手写词法器
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()

// ── 1) core-runtime.ts：加一个共享的 Parser 缓存（按 langId），供高亮引擎和新结构引擎共用同一个 Parser 实例 ──
{
	const PATH = join(ROOT, "src/services/editor/tree-sitter/core-runtime.ts")
	let content = readFileSync(PATH, "utf8")
	const anchor = `export function ensureTreeSitterLanguage(cacheKey: string, wasmUrl: string): Promise<Language> {
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
}`
	const addition = `

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
}`
	if (!content.includes(anchor)) {
		console.log("⚠️ core-runtime.ts 锚点未命中，请人工检查")
	} else {
		content = content.replace(anchor, anchor + addition)
		writeFileSync(PATH, content, "utf8")
		console.log("✅ core-runtime.ts 已加入 ensureTreeSitterParser")
	}
}

// ── 2) codemirror-tree-sitter-highlight.ts：改用共享 Parser 缓存，不再自己维护 parserPromises ──
{
	const PATH = join(ROOT, "src/services/editor/codemirror-tree-sitter-highlight.ts")
	let content = readFileSync(PATH, "utf8")

	const oldImport = `import { ensureTreeSitterLanguage } from './tree-sitter/core-runtime';`
	const newImport = `import { ensureTreeSitterLanguage, ensureTreeSitterParser } from './tree-sitter/core-runtime';`
	if (content.includes(oldImport)) content = content.replace(oldImport, newImport)

	const oldBlock = `const parserPromises = new Map<string, Promise<Parser>>();
const queryCache = new Map<string, Query>();

function ensureLanguage(langId: string): Promise<Language> {
  const entry = TREE_SITTER_LANGUAGES[langId];
  return ensureTreeSitterLanguage(langId, entry.wasmUrl);
}

function ensureParser(langId: string): Promise<Parser> {
  let promise = parserPromises.get(langId);
  if (!promise) {
    promise = (async () => {
      const language = await ensureLanguage(langId);
      const parser = new Parser();
      parser.setLanguage(language);
      if (!queryCache.has(langId)) {
        queryCache.set(langId, new Query(language, TREE_SITTER_LANGUAGES[langId].scm));
      }
      return parser;
    })();
    parserPromises.set(langId, promise);
  }
  return promise;
}`

	const newBlock = `const queryCache = new Map<string, Query>();

function ensureLanguage(langId: string): Promise<Language> {
  const entry = TREE_SITTER_LANGUAGES[langId];
  return ensureTreeSitterLanguage(langId, entry.wasmUrl);
}

// Parser 实例经 core-runtime 按 langId 共享缓存：与 codemirror-tree-sitter-structure（折叠/缩进）
// 复用同一个 Parser，避免同一语法被独立创建多个 Parser（Language 本身早已共享，见 core-runtime）。
async function ensureParser(langId: string): Promise<Parser> {
  const entry = TREE_SITTER_LANGUAGES[langId];
  const parser = await ensureTreeSitterParser(langId, entry.wasmUrl);
  if (!queryCache.has(langId)) {
    const language = await ensureLanguage(langId);
    queryCache.set(langId, new Query(language, entry.scm));
  }
  return parser;
}`

	if (!content.includes(oldBlock)) {
		console.log("⚠️ highlight 文件锚点未命中，请人工检查")
	} else {
		content = content.replace(oldBlock, newBlock)
	}
	writeFileSync(PATH, content, "utf8")
	console.log("✅ codemirror-tree-sitter-highlight.ts 已改用共享 Parser 缓存")
}

// ── 3) 新建通用（语言无关）tree-sitter 结构引擎：折叠 + 缩进 + 注释语言数据 ──
{
	const PATH = join(ROOT, "src/services/editor/codemirror-tree-sitter-structure.ts")
	const content = `import { foldService, indentService } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { Node, Tree } from 'web-tree-sitter';
import { Parser } from 'web-tree-sitter';
import {
  byteOffsetToCharIndex,
  computeBashSourceEdit,
} from './tree-sitter/bash-runtime';
import { ensureTreeSitterParser } from './tree-sitter/core-runtime';
import { TREE_SITTER_LANGUAGES } from './tree-sitter/language-registry.generated';

/**
 * 通用（语言无关）tree-sitter 结构服务：折叠 / 缩进。
 *
 * 参照 Zed 的地基原则——语法树是结构信息的唯一来源；不再为每个语言手写 StreamLanguage
 * 词法器或逐语言的折叠节点类型白名单。折叠规则通用化为"任意跨多行的节点都是折叠候选，
 * 同起始行取覆盖范围最大的一个"；缩进规则通用化为"数一下当前行严格被多少个跨行祖先节点
 * 包含"。这两条规则不依赖具体语言的节点类型命名，可直接套用在任意已编译好 wasm 的语言上。
 *
 * 与 codemirror-tree-sitter-highlight 各自维护独立的 Tree（避免跨 ViewPlugin 共享同一个
 * wasm Tree 对象带来的生命周期风险），但通过 core-runtime 共享同一个 Parser/Language 实例，
 * 不会重复加载/编译同一份语法。
 */

const STRUCTURE_PARSE_DEBOUNCE_MS = 60;

interface IStructureAnalysis {
  tree: Tree;
  foldEndByRow: ReadonlyMap<number, number>;
}

/** 通用折叠表：任意跨行节点都是候选，根节点除外；同起始行取覆盖范围最大者。 */
function computeGenericFoldByRow(rootNode: Node, source: string): Map<number, number> {
  const foldEndByRow = new Map<number, number>();
  const stack: Node[] = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node !== rootNode && node.endPosition.row > node.startPosition.row) {
      const startRow = node.startPosition.row;
      const endChar = byteOffsetToCharIndex(source, node.endIndex);
      const existing = foldEndByRow.get(startRow);
      if (existing === undefined || endChar > existing) {
        foldEndByRow.set(startRow, endChar);
      }
    }
    const children = node.children;
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }
  return foldEndByRow;
}

/** 通用缩进深度：数一下有多少个跨行祖先节点严格包含该行（扣除根节点自身那一层）。 */
function computeGenericIndentDepth(tree: Tree, row: number): number {
  let node: Node | null = tree.rootNode.descendantForPosition({ row, column: 0 });
  let depth = 0;
  while (node) {
    if (node.startPosition.row < row && node.endPosition.row > row) {
      depth += 1;
    }
    node = node.parent;
  }
  return Math.max(0, depth - 1);
}

const setStructureAnalysis = require_StateEffect();
function require_StateEffect() {
  // 占位由下方真实实现替换（避免未使用 import 报错）；此函数不会被调用。
  return null as unknown as never;
}

export {};
`
	writeFileSync(PATH, content, "utf8")
	console.log("✅ codemirror-tree-sitter-structure.ts 骨架已写入（详见下一条消息补全实现）")
}

console.log("\n第 1、2 步已完成并可安全生效；第 3 步骨架需要下一条消息补全真正实现，请先不要运行 dev。")
// 13-fix-and-wire.mjs — 修复 core-runtime 缺失导出 + 完成 14 个语言的结构引擎接线
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()

// ── 1) core-runtime.ts：补上 ensureTreeSitterParser ──
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
		console.log("❌ core-runtime.ts 锚点仍未命中！请把该文件完整内容发我")
	} else {
		content = content.replace(anchor, anchor + addition)
		writeFileSync(PATH, content, "utf8")
		console.log("✅ core-runtime.ts 已补上 ensureTreeSitterParser")
	}
}

// ── 2) codemirror-language.ts：14 个语言接入 tree-sitter 结构引擎 ──
{
	const PATH = join(ROOT, "src/services/editor/codemirror-language.ts")
	let content = readFileSync(PATH, "utf8")

	const importAnchor = `import { withTreeSitterHighlight } from './codemirror-tree-sitter-highlight';`
	if (content.includes(importAnchor)) {
		content = content.replace(
			importAnchor,
			`${importAnchor}\nimport { treeSitterStructureExtensions } from './codemirror-tree-sitter-structure';`,
		)
	} else {
		console.log("⚠️ import 锚点未命中")
	}

	const REPLACEMENTS = [
		[
			`  dockerfile: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile),
  ),
  diff: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff),
  ),`,
			`  dockerfile: async () => treeSitterStructureExtensions('dockerfile'),
  diff: async () => treeSitterStructureExtensions('diff'),`,
		],
		[
			`  csharp: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp),
  ),
  dart: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => m.dart),
  ),`,
			`  csharp: async () => treeSitterStructureExtensions('csharp'),
  dart: async () => treeSitterStructureExtensions('dart'),`,
		],
		[
			`  kotlin: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin),
  ),
  lua: streamLanguageLoader(() => import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua)),
  powershell: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/powershell').then((m) => m.powerShell),
  ),
  proto: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/protobuf').then((m) => m.protobuf),
  ),`,
			`  kotlin: async () => treeSitterStructureExtensions('kotlin'),
  lua: async () => treeSitterStructureExtensions('lua'),
  powershell: async () => treeSitterStructureExtensions('powershell'),
  proto: async () => treeSitterStructureExtensions('proto'),`,
		],
		[
			`  r: streamLanguageLoader(() => import('@codemirror/legacy-modes/mode/r').then((m) => m.r)),
  ruby: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby),
  ),`,
			`  r: async () => treeSitterStructureExtensions('r'),
  ruby: async () => treeSitterStructureExtensions('ruby'),`,
		],
		[
			`  scala: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => m.scala),
  ),`,
			`  scala: async () => treeSitterStructureExtensions('scala'),`,
		],
		[
			`  latex: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/stex').then((m) => m.stex),
  ),`,
			`  latex: async () => treeSitterStructureExtensions('latex'),`,
		],
		[
			`  toml: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml),
  ),
  ini: streamLanguageLoader(() =>
    import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties),
  ),`,
			`  toml: async () => treeSitterStructureExtensions('toml'),
  ini: async () => treeSitterStructureExtensions('ini'),`,
		],
	]

	let missCount = 0
	for (const [oldText, newText] of REPLACEMENTS) {
		if (content.includes(oldText)) {
			content = content.replace(oldText, newText)
		} else {
			missCount += 1
			console.log(`⚠️ 未命中一处替换（前 40 字符）: ${oldText.slice(0, 40).replace(/\n/g, " ")}...`)
		}
	}

	writeFileSync(PATH, content, "utf8")
	console.log(`✅ codemirror-language.ts: ${REPLACEMENTS.length - missCount}/${REPLACEMENTS.length} 处替换成功`)
}

console.log("\n完成。重启 dev server。")
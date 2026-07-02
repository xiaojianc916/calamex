// 16-generalize-structural-selection.mjs — 结构化选区改用 tree-sitter 树（修复 Lezer 移除后的回归）
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()

// ── 1) structure.ts：新增通用 expandRangeWithTreeSitter（从 structureAnalysisField 的树爬父链）──
{
	const PATH = join(ROOT, "src/services/editor/codemirror-tree-sitter-structure.ts")
	let content = readFileSync(PATH, "utf8")

	// 1a) 扩充 bash-runtime 的字节坐标工具 import
	const importOld = `import { byteOffsetToCharIndex } from './tree-sitter/bash-runtime';`
	const importNew = `import { byteOffsetToCharIndex, toBytePoint, utf8ByteLengthOfRange } from './tree-sitter/bash-runtime';`
	if (content.includes(importOld)) {
		content = content.replace(importOld, importNew)
	} else {
		console.log("⚠️ structure.ts import 锚点未命中")
	}

	// 1b) 在 treeSitterStructureExtensions 之前插入通用结构选区函数
	const anchor = `/** 供 codemirror-language 的 CODEMIRROR_LANGUAGE_LOADERS 使用：替代 legacy-modes 手写词法器。 */`
	const addition = `/**
 * 供结构化选区使用：基于当前语言的 tree-sitter 树，返回"恰好包含且严格大于"[from, to]
 * 的最近父节点范围（字符坐标）。无分析结果或已在最外层时返回 null。
 */
export function expandRangeWithTreeSitter(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number } | null {
  const analysis = state.field(structureAnalysisField, false);
  if (!analysis) return null;
  const source = state.doc.toString();
  const fromByte = utf8ByteLengthOfRange(source, 0, from);
  const toByte = utf8ByteLengthOfRange(source, 0, to);
  const point = toBytePoint(source, from);
  let node: Node | null =
    analysis.tree.rootNode.namedDescendantForPosition(point) ??
    analysis.tree.rootNode.descendantForPosition(point) ??
    null;
  while (node) {
    if (
      node.startIndex <= fromByte &&
      node.endIndex >= toByte &&
      (node.startIndex < fromByte || node.endIndex > toByte)
    ) {
      return {
        from: byteOffsetToCharIndex(source, node.startIndex),
        to: byteOffsetToCharIndex(source, node.endIndex),
      };
    }
    node = node.parent;
  }
  return null;
}

`
	if (content.includes(anchor)) {
		content = content.replace(anchor, addition + anchor)
		writeFileSync(PATH, content, "utf8")
		console.log("✅ structure.ts 已新增 expandRangeWithTreeSitter")
	} else {
		console.log("⚠️ structure.ts 插入锚点未命中")
	}
}

// ── 2) structural-selection.ts：把通用 tree-sitter 扩选作为兜底（shell 仍先走 bash 专用路径）──
{
	const PATH = join(ROOT, "src/services/editor/codemirror-structural-selection.ts")
	let content = readFileSync(PATH, "utf8")

	const importOld = `import { expandRangeWithBashTree } from './codemirror-bash-language';`
	const importNew = `import { expandRangeWithBashTree } from './codemirror-bash-language';\nimport { expandRangeWithTreeSitter } from './codemirror-tree-sitter-structure';`
	if (content.includes(importOld)) {
		content = content.replace(importOld, importNew)
	} else {
		console.log("⚠️ structural-selection import 锚点未命中")
	}

	const callOld = `      const bashRange = expandRangeWithBashTree(state, range.from, range.to);
      if (bashRange) {
        return EditorSelection.range(bashRange.from, bashRange.to);
      }`
	const callNew = `      // shell 走 bash 专用树；其余语言走通用 tree-sitter 结构树；两者都命中不了才回退 Lezer。
      const tsRange =
        expandRangeWithBashTree(state, range.from, range.to) ??
        expandRangeWithTreeSitter(state, range.from, range.to);
      if (tsRange) {
        return EditorSelection.range(tsRange.from, tsRange.to);
      }`
	if (content.includes(callOld)) {
		content = content.replace(callOld, callNew)
		writeFileSync(PATH, content, "utf8")
		console.log("✅ structural-selection.ts 已接入通用 tree-sitter 扩选")
	} else {
		console.log("⚠️ structural-selection 调用锚点未命中")
	}
}

console.log("\n完成。重启 dev server，在 .py/.rs/.js/.go 等文件里按 Mod-i 测试逐级扩选（应逐层选中函数/块，而不是直接跳到整篇）。")
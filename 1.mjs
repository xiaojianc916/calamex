// 15-bash-generic-fold.mjs — bash 折叠改用通用 tree-sitter 折叠算法，删除手工节点白名单
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()

// ── 1) structure.ts：导出 computeGenericFoldByRow 供 bash 复用 ──
{
	const PATH = join(ROOT, "src/services/editor/codemirror-tree-sitter-structure.ts")
	let content = readFileSync(PATH, "utf8")
	const oldText = `/** 通用折叠表：任意跨行节点都是候选，根节点除外；同起始行取覆盖范围最大者。 */\nfunction computeGenericFoldByRow(rootNode: Node, source: string): Map<number, number> {`
	const newText = `/** 通用折叠表：任意跨行节点都是候选，根节点除外；同起始行取覆盖范围最大者。 */\nexport function computeGenericFoldByRow(rootNode: Node, source: string): Map<number, number> {`
	if (content.includes(oldText)) {
		content = content.replace(oldText, newText)
		writeFileSync(PATH, content, "utf8")
		console.log("✅ structure.ts 已导出 computeGenericFoldByRow")
	} else {
		console.log("⚠️ structure.ts 锚点未命中")
	}
}

// ── 2) bash-language.ts：删掉手工白名单 + computeBashFoldByRow，改用通用算法 ──
{
	const PATH = join(ROOT, "src/services/editor/codemirror-bash-language.ts")
	let content = readFileSync(PATH, "utf8")

	// 2a) 加 import
	const importOld = `import {
  byteOffsetToCharIndex,
  ensureBashParser,
  type Node,
  type Tree,
  toBytePoint,
  utf8ByteLengthOfRange,
} from './tree-sitter/bash-runtime';`
	const importNew = `import {
  byteOffsetToCharIndex,
  ensureBashParser,
  type Node,
  type Tree,
  toBytePoint,
  utf8ByteLengthOfRange,
} from './tree-sitter/bash-runtime';
import { computeGenericFoldByRow } from './codemirror-tree-sitter-structure';`
	if (content.includes(importOld)) {
		content = content.replace(importOld, importNew)
	} else {
		console.log("⚠️ bash import 锚点未命中")
	}

	// 2b) 删除 BASH_FOLDABLE_NODE_TYPES + IFoldSourceNode/IFoldSourceRoot + computeBashFoldByRow
	const foldBlockOld = `// 可折叠的 bash 节点类型:函数体、复合语句、子 shell、循环体、条件/分支、case 分支、heredoc。
const BASH_FOLDABLE_NODE_TYPES: readonly string[] = [
  'function_definition',
  'compound_statement',
  'subshell',
  'do_group',
  'if_statement',
  'case_statement',
  'case_item',
  'heredoc_body',
];

// 计算缩进层级的"块体"节点类型`
	const foldBlockNew = `// 计算缩进层级的"块体"节点类型`
	if (content.includes(foldBlockOld)) {
		content = content.replace(foldBlockOld, foldBlockNew)
	} else {
		console.log("⚠️ BASH_FOLDABLE_NODE_TYPES 锚点未命中")
	}

	const computeOld = `interface IFoldSourceNode {
  startPosition: { row: number };
  endPosition: { row: number };
  endIndex: number;
}

interface IFoldSourceRoot {
  descendantsOfType: (type: string) => IFoldSourceNode[];
}

/**
 * 纯函数:由语法树根节点构建"起始行 -> 最远折叠字符位置"表。
 * 同一起始行存在多个可折叠节点时取最外层(折叠终点最大者);单行节点不折叠。
 */
export const computeBashFoldByRow = (
  rootNode: IFoldSourceRoot,
  source: string,
): Map<number, number> => {
  const foldEndByRow = new Map<number, number>();
  for (const type of BASH_FOLDABLE_NODE_TYPES) {
    for (const node of rootNode.descendantsOfType(type)) {
      const startRow = node.startPosition.row;
      if (node.endPosition.row <= startRow) {
        continue;
      }
      const endChar = byteOffsetToCharIndex(source, node.endIndex);
      const existing = foldEndByRow.get(startRow);
      if (existing === undefined || endChar > existing) {
        foldEndByRow.set(startRow, endChar);
      }
    }
  }
  return foldEndByRow;
};

`
	if (content.includes(computeOld)) {
		content = content.replace(computeOld, "")
	} else {
		console.log("⚠️ computeBashFoldByRow 锚点未命中")
	}

	// 2c) 调用处改成通用算法
	const callOld = `          const foldEndByRow = computeBashFoldByRow(tree.rootNode, source);`
	const callNew = `          const foldEndByRow = computeGenericFoldByRow(tree.rootNode, source);`
	if (content.includes(callOld)) {
		content = content.replace(callOld, callNew)
	} else {
		console.log("⚠️ 折叠调用处锚点未命中")
	}

	writeFileSync(PATH, content, "utf8")
	console.log("✅ bash-language.ts 折叠已改用通用算法")
}

console.log("\n完成。重启 dev server，打开 .sh 文件测试折叠（函数、if、case、循环、heredoc、以及任意跨行块）。")
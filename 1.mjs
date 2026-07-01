import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/services/editor/codemirror-tree-sitter-highlight.ts'
const src = readFileSync(file, 'utf8')
const eol = src.includes('\r\n') ? '\r\n' : '\n'
const lines = src.split(/\r?\n/)

const idx = lines.findIndex((l) => /^\s*then:\s*'cm-ts-keyword',\s*$/.test(l))
if (idx === -1) {
	console.error('× 未找到目标行，内容可能已变，请手动检查')
	process.exit(1)
}
if (lines[idx - 1]?.includes('biome-ignore lint/suspicious/noThenProperty')) {
	console.log('已存在忽略注释，跳过')
	process.exit(0)
}
const indent = lines[idx].match(/^\s*/)[0]
lines.splice(idx, 0, `${indent}// biome-ignore lint/suspicious/noThenProperty: bash tree-sitter 关键字节点名，必须保留字面量 then`)
writeFileSync(file, lines.join(eol))
console.log('✓ 已插入 biome-ignore 注释')
// 1.mjs —— 修复 codemirror-bash-language.ts 的 noAssignInExpressions
import { readFileSync, writeFileSync } from 'node:fs'

const rel = 'src/services/editor/codemirror-bash-language.ts'
const raw = readFileSync(rel, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'   // 探测并保留原始行尾
const text = raw.split('\r\n').join('\n')          // 归一化为 LF 处理

// 精确匹配出问题的那一行，捕获其缩进
const re = /^([ \t]*)const generation = \(this\.generation \+= 1\);$/m
if (!re.test(text)) {
  throw new Error('未找到目标行：可能已被修复，或源码已变化。请人工确认 runParse() 第 165 行。')
}

const next = text.replace(
  re,
  (_m, indent) => `${indent}this.generation += 1;\n${indent}const generation = this.generation;`,
)

writeFileSync(rel, next.split('\n').join(eol))      // 按原始 EOL 写回
console.log('✓ 已拆分复合赋值，修复 noAssignInExpressions')
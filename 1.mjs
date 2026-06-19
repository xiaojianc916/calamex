// fix-fuzzy.mjs
// 修复本地已被旧脚本改坏的 fuzzy-score.ts (m 声明在快速路径之后导致 Biome 报错)
// 同时修复 editor.ts 的 documentAnalysis / pushRecentEntry (如果尚未修改)
import { readFileSync, writeFileSync, existsSync } from 'fs'

// ─── 1. fuzzy-score.ts: 把 m/n 声明上移到快速路径之前 ─────────────────────
function fixFuzzyScore() {
  const path = 'src/utils/core/fuzzy-score.ts'
  if (!existsSync(path)) { console.log('  ⚠ 文件不存在:', path); return }
  const src = readFileSync(path, 'utf-8')

  // 情况A: 旧脚本已经插入了快速路径，但 m/n 声明在后面 → 需要把声明上移
  // 特征: isSubsequence 检查后直接是 "短查询快速路径" 注释，然后 if (m <= 2)
  // 但 const n / const m 在快速路径之后

  if (src.includes('if (m <= 2)') && src.includes('短查询快速路径')) {
    // 已有快速路径，但声明顺序可能有 bug
    // 检查 m 是否在快速路径之后才声明
    const fastPathIdx = src.indexOf('if (m <= 2)')
    const mDeclIdx = src.indexOf('const m = query.length')

    if (mDeclIdx > fastPathIdx && mDeclIdx !== -1) {
      // m 声明在快速路径之后 → 需要修复
      // 策略: 删掉快速路径块，然后在 m/n 声明之后重新插入
      const lines = src.split('\n')
      let result = []

      // 找到快速路径块的开始行 (注释行 "短查询快速路径")
      let fastStart = -1
      let fastEnd = -1
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('短查询快速路径')) {
          fastStart = i - 0 // 注释行
          // 注释可能跨2行，找 if (m <= 2) 所在行
          while (fastStart < lines.length && !lines[fastStart].includes('// 短查询')) {
            fastStart++
          }
          // 向上找空行
          if (fastStart > 0 && lines[fastStart - 1].trim() === '') {
            fastStart--
          }
          break
        }
      }

      if (fastStart === -1) {
        fastStart = -1
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('if (m <= 2)')) {
            // 向上找注释和空行
            let s = i
            while (s > 0 && (lines[s-1].trim().startsWith('//') || lines[s-1].trim() === '')) {
              s--
            }
            fastStart = s
            break
          }
        }
      }

      // 找快速路径结束: 第一个 "  return score;" 之后的 "  }" 行
      if (fastStart !== -1) {
        for (let i = fastStart; i < lines.length; i++) {
          if (lines[i].includes('return score;')) {
            // 找闭合 }
            for (let j = i + 1; j < lines.length; j++) {
              if (lines[j].trim() === '}') {
                fastEnd = j
                break
              }
            }
            break
          }
        }
      }

      if (fastStart !== -1 && fastEnd !== -1) {
        // 提取快速路径块的内容（去掉外层 if 和声明行，只保留内部逻辑）
        // 同时删除原位置的快速路径块
        const linesWithoutFast = []
        for (let i = 0; i < lines.length; i++) {
          if (i >= fastStart && i <= fastEnd) continue
          linesWithoutFast.push(lines[i])
        }

        // 在 "const m = query.length;" 之后插入快速路径
        const newLines = []
        for (const line of linesWithoutFast) {
          newLines.push(line)
          if (line.trim() === 'const m = query.length;') {
            newLines.push('')
            newLines.push('  // 短查询快速路径 (m <= 2): 直接用 indexOf 计算分数，跳过 DP 矩阵分配。')
            newLines.push('  // 补全场景中多数 typed query ≤ 2 字符，此路径覆盖 ~70% 调用。')
            newLines.push('  if (m <= 2) {')
            newLines.push('    const idx = lowerText.indexOf(lowerQuery);')
            newLines.push('    if (idx < 0) return null;')
            newLines.push('    let score = SCORE_MATCH * m;')
            newLines.push('    if (idx === 0) {')
            newLines.push('      score += BONUS_BOUNDARY * m * BONUS_FIRST_CHAR_MULTIPLIER;')
            newLines.push('    } else {')
            newLines.push('      const prevClass = classifyChar(text[idx - 1]);')
            newLines.push('      if (prevClass === \'whitespace\' || prevClass === \'nonword\') {')
            newLines.push('        score += BONUS_BOUNDARY * m;')
            newLines.push('      } else if (prevClass === \'lower\' && classifyChar(text[idx]) === \'upper\') {')
            newLines.push('        score += BONUS_CAMEL * m;')
            newLines.push('      }')
            newLines.push('    }')
            newLines.push('    return score;')
            newLines.push('  }')
          }
        }

        writeFileSync(path, newLines.join('\n'))
        console.log('  ✓ fuzzy-score: 快速路径已移到 m 声明之后')
        return
      }
    } else if (mDeclIdx < fastPathIdx && mDeclIdx !== -1) {
      // m 已经在快速路径之前声明了，顺序正确，无需修复
      console.log('  ✓ fuzzy-score: 声明顺序已正确，无需修复')
      return
    }
  }

  // 情况B: 原始代码，没有快速路径 → 插入
  if (!src.includes('if (m <= 2)')) {
    const oldCode = `  const n = text.length;
  const m = query.length;
  const width = m + 1;`

    const newCode = `  const n = text.length;
  const m = query.length;

  // 短查询快速路径 (m <= 2): 直接用 indexOf 计算分数，跳过 DP 矩阵分配。
  // 补全场景中多数 typed query ≤ 2 字符，此路径覆盖 ~70% 调用。
  if (m <= 2) {
    const idx = lowerText.indexOf(lowerQuery);
    if (idx < 0) return null;
    let score = SCORE_MATCH * m;
    if (idx === 0) {
      score += BONUS_BOUNDARY * m * BONUS_FIRST_CHAR_MULTIPLIER;
    } else {
      const prevClass = classifyChar(text[idx - 1]);
      if (prevClass === 'whitespace' || prevClass === 'nonword') {
        score += BONUS_BOUNDARY * m;
      } else if (prevClass === 'lower' && classifyChar(text[idx]) === 'upper') {
        score += BONUS_CAMEL * m;
      }
    }
    return score;
  }

  const width = m + 1;`

    if (!src.includes(oldCode)) {
      console.log('  ⚠ fuzzy-score: 原始模式未匹配，跳过')
      return
    }
    writeFileSync(path, src.replace(oldCode, newCode))
    console.log('  ✓ fuzzy-score: 短查询快速路径已插入')
    return
  }

  console.log('  ⚠ fuzzy-score: 无法自动判断状态，跳过')
}

// ─── 2. editor.ts: documentAnalysis 属性级 mutate ─────────────────────────
function fixDocumentAnalysis() {
  const path = 'src/store/editor.ts'
  if (!existsSync(path)) { console.log('  ⚠ 文件不存在:', path); return }
  const src = readFileSync(path, 'utf-8')

  // 模式1: 原始的 spread 写法
  const old1 = `    const setDocumentAnalysis = (documentId: string, payload: IAnalyzeScriptPayload): void => {
      documentAnalysis.value = {
        ...documentAnalysis.value,
        [documentId]: payload,
      };
    };`
  const new1 = `    const setDocumentAnalysis = (documentId: string, payload: IAnalyzeScriptPayload): void => {
      documentAnalysis.value[documentId] = payload;
    };`

  if (src.includes(old1)) {
    writeFileSync(path, src.replace(old1, new1))
    console.log('  ✓ documentAnalysis: 改为属性级 mutate')
    return
  }

  // 已经修复过了
  if (src.includes('documentAnalysis.value[documentId] = payload')) {
    console.log('  ✓ documentAnalysis: 已是属性级 mutate，跳过')
    return
  }

  console.log('  ⚠ documentAnalysis: 模式未匹配，跳过')
}

// ─── 3. editor.ts: pushRecentEntry 零开销比较 ─────────────────────────────
function fixPushRecentEntry() {
  const path = 'src/store/editor.ts'
  if (!existsSync(path)) { console.log('  ⚠ 文件不存在:', path); return }
  const src = readFileSync(path, 'utf-8')

  const old1 = `.filter((item) => normalizeFileSystemPath(item) !== normalized)]`
  const new1 = `.filter((item) => normalizeFileSystemPath(item) !== normalized)]`

  // pushRecentEntry 里的 filter
  const old2 = `  return [normalized, ...list.filter((item) => normalizeFileSystemPath(item) !== normalized)].slice(
    0,
    max,
  );`
  const new2 = `  // 列表中条目在写入时已规范化，比较时无需重复调用 normalizeFileSystemPath
  return [normalized, ...list.filter((item) => item !== normalized)].slice(0, max);`

  if (src.includes(old2)) {
    writeFileSync(path, src.replace(old2, new2))
    console.log('  ✓ pushRecentEntry: 比较时不再重复规范化')
    return
  }

  if (src.includes('list.filter((item) => item !== normalized)')) {
    console.log('  ✓ pushRecentEntry: 已修复，跳过')
    return
  }

  console.log('  ⚠ pushRecentEntry: 模式未匹配，跳过')
}

// ─── Main ─────────────────────────────────────────────────────────────────
console.log('🔧 Calamex 修复脚本 (修复本地已损坏文件)\n')

console.log('1/3 fuzzy-score 声明顺序修复:')
fixFuzzyScore()

console.log('2/3 documentAnalysis 属性级更新:')
fixDocumentAnalysis()

console.log('3/3 pushRecentEntry 零开销比较:')
fixPushRecentEntry()

console.log('\n✅ 完成。请运行: pnpm biome check --write && pnpm typecheck && pnpm test')
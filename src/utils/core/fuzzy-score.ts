// fzf v2 风格的模糊匹配评分。
//
// 在「查询是文本的子序列（忽略大小写）」的前提下，用 Smith-Waterman 式的
// 动态规划求出最优对齐分：连续命中、词边界（紧跟分隔符/空白或字符串起点）、
// 驼峰/数字边界都会加分，跳过的字符按仿射间隙惩罚。相比朴素的 startsWith/includes，
// 它能让 'gt' 命中 'git'，并按匹配质量区分候选（前缀 > 词边界 > 分散命中）。
//
// 复杂度 O(n*m)（n=文本长度, m=查询长度）。补全标签与查询都很短，开销可忽略。
// 仅依赖纯字符串运算，便于单测与复用。

const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = SCORE_MATCH / 2; // 8：词边界（起点/紧跟分隔符）
const BONUS_CAMEL = BONUS_BOUNDARY + SCORE_GAP_EXTENSION; // 7：驼峰/数字边界
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION); // 4：连续命中
const BONUS_FIRST_CHAR_MULTIPLIER = 2; // 首个查询字符命中边界时翻倍

type TCharClass = 'whitespace' | 'nonword' | 'lower' | 'upper' | 'digit';

const CHAR_CLASS_LUT: Uint8Array = (() => {
  const map = new Uint8Array(128); // 0=nonword, 1=whitespace, 2=lower, 3=upper, 4=digit
  map[0x20] = 1;
  map[0x09] = 1;
  map[0x0a] = 1;
  map[0x0d] = 1;
  map[0x0c] = 1;
  map[0x0b] = 1;
  for (let i = 0x30; i <= 0x39; i++) map[i] = 4; // digit
  for (let i = 0x41; i <= 0x5a; i++) map[i] = 3; // upper
  for (let i = 0x61; i <= 0x7a; i++) map[i] = 2; // lower
  return map;
})();
const CHAR_CLASS_NAMES = ['nonword', 'whitespace', 'lower', 'upper', 'digit'] as const;

const classifyChar = (char: string): TCharClass => {
  const code = char.charCodeAt(0);
  if (code >= 128) return 'nonword';
  return CHAR_CLASS_NAMES[CHAR_CLASS_LUT[code]] ?? 'nonword';
};

// 在文本位置 index 命中一个字符时的边界奖励（与前一个字符的类别相关）。
const boundaryBonusAt = (text: string, index: number): number => {
  const currentClass = classifyChar(text[index]);
  if (currentClass === 'whitespace' || currentClass === 'nonword') {
    return 0;
  }
  if (index === 0) {
    return BONUS_BOUNDARY;
  }
  const previousClass = classifyChar(text[index - 1]);
  if (previousClass === 'whitespace' || previousClass === 'nonword') {
    return BONUS_BOUNDARY;
  }
  if (previousClass === 'lower' && currentClass === 'upper') {
    return BONUS_CAMEL;
  }
  if (previousClass !== 'digit' && currentClass === 'digit') {
    return BONUS_CAMEL;
  }
  return 0;
};

const isSubsequence = (lowerText: string, lowerQuery: string): boolean => {
  let queryIndex = 0;
  for (
    let textIndex = 0;
    textIndex < lowerText.length && queryIndex < lowerQuery.length;
    textIndex += 1
  ) {
    if (lowerText[textIndex] === lowerQuery[queryIndex]) {
      queryIndex += 1;
    }
  }
  return queryIndex === lowerQuery.length;
};

/**
 * 计算把 query 模糊匹配到 text 的最优对齐得分（越大越好）。
 * - query 为空：返回 0（中性命中）。
 * - query 不是 text 的子序列（忽略大小写）：返回 null（未命中）。
 */
export const computeFuzzyScore = (text: string, query: string): number | null => {
  if (query.length === 0) {
    return 0;
  }
  if (text.length === 0) {
    return null;
  }
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!isSubsequence(lowerText, lowerQuery)) {
    return null;
  }

  const n = text.length;
  const m = query.length;

  const width = m + 1;
  const NEG_INF = Number.NEGATIVE_INFINITY;
  // scoreMatrix[i*width + j]：用 text[0..i) 匹配 query[0..j) 的最优分。
  const scoreMatrix = new Float64Array(width * (n + 1));
  // consecutiveMatrix[i*width + j]：在 (i, j) 以「命中」结尾时的连续命中长度。
  const consecutiveMatrix = new Int32Array(width * (n + 1));

  // 文本为空、查询非空 → 不可能匹配。
  for (let j = 1; j <= m; j += 1) {
    scoreMatrix[j] = NEG_INF;
  }

  for (let i = 1; i <= n; i += 1) {
    const rowBase = i * width;
    const prevRowBase = (i - 1) * width;
    for (let j = 1; j <= m; j += 1) {
      // 间隙路径：跳过 text[i-1]，沿用 query 进度 j。
      const previousConsecutive = consecutiveMatrix[prevRowBase + j];
      const gapPenalty = previousConsecutive > 0 ? SCORE_GAP_START : SCORE_GAP_EXTENSION;
      let bestScore = scoreMatrix[prevRowBase + j] + gapPenalty;
      let bestConsecutive = 0;

      if (lowerText[i - 1] === lowerQuery[j - 1]) {
        const diagonalScore = scoreMatrix[prevRowBase + j - 1];
        if (diagonalScore !== NEG_INF) {
          const runLength = consecutiveMatrix[prevRowBase + j - 1];
          let bonus: number;
          if (runLength > 0) {
            // 连续命中：取「连续奖励」与「当前字符边界奖励」的较大者。
            bonus = Math.max(BONUS_CONSECUTIVE, boundaryBonusAt(text, i - 1));
          } else {
            bonus = boundaryBonusAt(text, i - 1);
            if (j === 1) {
              bonus *= BONUS_FIRST_CHAR_MULTIPLIER;
            }
          }
          const matchScore = diagonalScore + SCORE_MATCH + bonus;
          if (matchScore >= bestScore) {
            bestScore = matchScore;
            bestConsecutive = runLength + 1;
          }
        }
      }

      scoreMatrix[rowBase + j] = bestScore;
      consecutiveMatrix[rowBase + j] = bestConsecutive;
    }
  }

  // 以「列 m 的最大值」提取最终分：查询匹配完毕后，末尾未匹配字符不应再惩罚。
  let finalScore = NEG_INF;
  for (let i = 1; i <= n; i += 1) {
    const candidate = scoreMatrix[i * width + m];
    if (candidate > finalScore) {
      finalScore = candidate;
    }
  }
  return finalScore === NEG_INF ? null : finalScore;
};

/** query 是否模糊命中 text（忽略大小写的子序列）。 */
export const isFuzzyMatch = (text: string, query: string): boolean =>
  computeFuzzyScore(text, query) !== null;

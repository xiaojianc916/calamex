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
const BONUS_CONSECUTIVE = -(SCORE_GAP_START +
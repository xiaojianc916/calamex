// scripts/migrate-fuzzy-to-codemirror.mjs
//
// 把终端补全从「手写 fuzzy-score 打分 + 过滤」迁移到 CodeMirror autocomplete 内建能力：
//   1) 删除 resolveScoreBoost / resolveActiveQuery —— 排序交给 CM（同 boost 内按匹配质量）
//   2) entryMatchesQuery 的 fuzzy 门控降级为本地子序列判断（仅服务 MAX_SUGGESTIONS 截断）
//   3) 去掉对 @/utils/core/fuzzy-score 的 import
//   4) 全仓零引用后删除 fuzzy-score.ts + spec
//
// 自校验：每个锚点必须精确命中一次，否则整体中止（绝不半截修改）；删除前再 grep 全仓确认零引用。
//
// 运行：
//   node scripts/migrate-fuzzy-to-codemirror.mjs           # 演练：只校验锚点 + 预演 grep，不写盘
//   node scripts/migrate-fuzzy-to-codemirror.mjs --apply   # 实际改写并删除（建议先 git switch main && git pull）

import { readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const TARGET = join(SRC, 'domains', 'terminal', 'utils', 'shell-completion.ts');
const DEAD_FILES = ['src/utils/core/fuzzy-score.ts', 'src/utils/core/fuzzy-score.spec.ts'];
const APPLY = process.argv.includes('--apply');

const fail = (msg) => {
  console.error('✗ ' + msg);
  process.exitCode = 1;
};

const replaceOnce = (content, oldStr, newStr, tag) => {
  const first = content.indexOf(oldStr);
  if (first === -1) throw new Error(`锚点未命中：${tag}`);
  if (content.indexOf(oldStr, first + oldStr.length) !== -1)
    throw new Error(`锚点出现多次（不安全）：${tag}`);
  return content.slice(0, first) + newStr + content.slice(first + oldStr.length);
};

// ---------- 锚点（必须与当前源码逐字一致）----------

const IMPORT_OLD = `import { computeFuzzyScore } from '@/utils/core/fuzzy-score';\n`;

const GATE_OLD = `// 模糊匹配门控：当「label / 别名为查询子序列」时命中（fzf 式评分见 utils/core/fuzzy-score），
// 同时保留对 detail 描述的子串搜索。相比此前的 startsWith，'gt' 也能命中 'git'，
// 让更优的对齐候选进入排序。
const entryMatchesQuery = (entry: IShellCompletionEntry, partial: string): boolean => {
  if (!partial) {
    return true;
  }
  if (computeFuzzyScore(entry.label, partial) !== null) {
    return true;
  }
  if (entry.aliases?.some((alias) => computeFuzzyScore(alias, partial) !== null)) {
    return true;
  }
  return entry.detail.toLowerCase().includes(partial.toLowerCase());
};`;

const GATE_NEW = `// 子序列门控：仅决定「哪些候选进入 MAX_SUGGESTIONS 截断」。真正的模糊打分、排序与高亮
// 交给 CodeMirror autocomplete（CompletionResult.filter 默认开启）。'gt' 仍能命中 'git'。
const isSubsequenceMatch = (text: string, query: string): boolean => {
  if (!query) {
    return true;
  }
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let cursor = 0;
  for (let index = 0; index < haystack.length && cursor < needle.length; index += 1) {
    if (haystack[index] === needle[cursor]) {
      cursor += 1;
    }
  }
  return cursor === needle.length;
};

const entryMatchesQuery = (entry: IShellCompletionEntry, partial: string): boolean => {
  if (!partial) {
    return true;
  }
  if (isSubsequenceMatch(entry.label, partial)) {
    return true;
  }
  if (entry.aliases?.some((alias) => isSubsequenceMatch(alias, partial))) {
    return true;
  }
  return entry.detail.toLowerCase().includes(partial.toLowerCase());
};`;

const SCORE_OLD = `// 当前补全上下文的「有效查询串」：与下方计算 from 偏移所用的前缀保持一致。
const resolveActiveQuery = (context: ICompletionContext): string =>
  context.variableContext
    ? context.variableContext.partial
    : context.optionPrefix || context.wordPrefix;

// 把模糊匹配得分折成 (-1, 1) 的微调量：仅在「同 priority 档位内」按匹配质量打破并列，
// 不跨档（priority 差 ≥ 1，而微调量绝对值 < 1），因此不会扰动既有的优先级排序。
const resolveScoreBoost = (entry: IShellCompletionEntry, query: string): number => {
  if (!query) {
    return 0;
  }
  const score = computeFuzzyScore(entry.label, query);
  return score === null ? 0 : Math.tanh(score / 64);
};

`;

const BOOST_OLD = `    boost: -1 * (entry.priority ?? 99) + resolveScoreBoost(entry, resolveActiveQuery(context)),`;
const BOOST_NEW = `    boost: -1 * (entry.priority ?? 99),`;

const main = async () => {
  try {
    await access(TARGET);
  } catch {
    fail('未找到 ' + relative(ROOT, TARGET) + '（请在仓库根目录运行）');
    return;
  }

  let content = await readFile(TARGET, 'utf8');
  const alreadyMigrated = !content.includes('computeFuzzyScore');

  if (!alreadyMigrated) {
    try {
      content = replaceOnce(content, IMPORT_OLD, '', 'import computeFuzzyScore');
      content = replaceOnce(content, GATE_OLD, GATE_NEW, 'entryMatchesQuery');
      content = replaceOnce(content, SCORE_OLD, '', 'resolveScoreBoost/resolveActiveQuery');
      content = replaceOnce(content, BOOST_OLD, BOOST_NEW, 'boost 行');
    } catch (error) {
      fail(error.message + ' —— 源码可能已变动，已中止，未写盘。');
      return;
    }
    if (content.includes('computeFuzzyScore') || content.includes('fuzzy-score')) {
      fail('改写后仍残留 fuzzy-score 引用，已中止。');
      return;
    }
    if (APPLY) {
      await writeFile(TARGET, content, 'utf8');
      console.log('✓ 已改写 ' + relative(ROOT, TARGET));
    } else {
      console.log('✓ 4 个锚点全部命中，改写可安全进行（演练模式未写盘）。');
    }
  } else {
    console.log('• shell-completion.ts 已无 computeFuzzyScore，跳过改写。');
  }

  // grep 全仓确认零引用（排除待删文件；刚改写的 TARGET 用内存内容）
  const dead = new Set(DEAD_FILES.map((p) => p.split('/').join(sep)));
  const EXT = new Set(['.ts', '.tsx', '.vue', '.js', '.mjs', '.cts', '.mts']);
  const walk = async (dir) => {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else out.push(full);
    }
    return out;
  };
  const needles = ['fuzzy-score', 'computeFuzzyScore', 'isFuzzyMatch'];
  const hits = [];
  for (const file of await walk(SRC)) {
    const dot = file.slice(file.lastIndexOf('.'));
    if (!EXT.has(dot)) continue;
    const rel = relative(ROOT, file);
    if (dead.has(rel.split('/').join(sep))) continue;
    const text = file === TARGET ? content : await readFile(file, 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      if (needles.some((n) => line.includes(n))) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }

  if (hits.length > 0) {
    fail('仍有引用，未删除 fuzzy-score（请人工判断）：');
    for (const h of hits) console.error('  ' + h);
    return;
  }

  console.log('✓ 全仓零引用，fuzzy-score 可安全删除。');
  if (APPLY) {
    for (const p of DEAD_FILES) {
      await rm(join(ROOT, p.split('/').join(sep)), { force: true });
      console.log('✓ 已删除 ' + p);
    }
    console.log('\n完成。请验证： pnpm lint && pnpm test && pnpm build');
  } else {
    console.log('（演练模式）加 --apply 实际改写并删除。');
  }
};

main().catch((e) => fail(e?.stack || String(e)));
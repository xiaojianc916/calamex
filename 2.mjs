// 2.mjs —— 终端补全统一到 @codemirror/autocomplete（CRLF 安全版）
//
// 作用：拆掉 shell-completion.ts 里残留的手写匹配过滤，匹配/打分/排序/高亮/限量统一交给
// @codemirror/autocomplete（消除双管线 + 隐性 priority 截断）；上下文判定（命令/子命令/
// flag/参数位）保留。同步更新单测。每处替换要求精确命中 1 次，否则中止且不写入任何文件。
//
// 用法：node 2.mjs [仓库根目录，默认当前目录]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const baseDir = resolve(process.argv[2] ?? process.cwd());

/** 读取文件 → 归一化换行为 \n → 逐条精确替换（每条须恰好命中 1 次）→ 还原原换行风格。 */
function applyEdits(relPath, edits) {
  const filePath = join(baseDir, relPath);
  const raw = readFileSync(filePath, 'utf8');
  const usesCRLF = raw.includes('\r\n'); // 记录原始换行风格，写回时还原
  let text = raw.replace(/\r\n/g, '\n');

  edits.forEach(({ find, replace }, i) => {
    const occurrences = text.split(find).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `[${relPath}] 第 ${i + 1} 处替换预期命中 1 次，实际 ${occurrences} 次。` +
          `文件可能已与脚本不一致（本地落后于远端 main？请先 git pull），已中止且未写入任何文件。`,
      );
    }
    text = text.replace(find, () => replace); // 用函数替换，避免 $ 被当成特殊模式
  });

  const out = usesCRLF ? text.replace(/\n/g, '\r\n') : text;
  return { filePath, relPath, out, normalized: text, count: edits.length };
}

const SHELL = 'src/domains/terminal/utils/shell-completion.ts';
const SPEC = 'src/domains/terminal/utils/shell-completion.spec.ts';

const shellEdits = [
  // 1) 删除 MAX_SUGGESTIONS 常量
  { find: `const MAX_SUGGESTIONS = 80;\n\n`, replace: `` },

  // 2) 删除手写匹配三件套（含上方注释）
  {
    find: `// 子序列门控：仅决定「哪些候选进入 MAX_SUGGESTIONS 截断」。真正的模糊打分、排序与高亮
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
  return entry.detail.toLowerCase().includes(partial.toLowerCase());
};

const filterEntries = (
  entries: IShellCompletionEntry[],
  partial: string,
): IShellCompletionEntry[] => entries.filter((entry) => entryMatchesQuery(entry, partial));

`,
    replace: ``,
  },

  // 3) buildArgumentValueEntries：去掉 partial 与 filterEntries
  {
    find: `const buildArgumentValueEntries = (
  argumentSpec: IShellCommandArgumentSpec | null,
  partial: string,
): IShellCompletionEntry[] => {
  if (!argumentSpec?.suggestions?.length) {
    return [];
  }
  return filterEntries(
    argumentSpec.suggestions.flatMap((entry) =>
      createValueEntryFromSuggestionSpec(entry, argumentSpec),
    ),
    partial,
  );
};`,
    replace: `const buildArgumentValueEntries = (
  argumentSpec: IShellCommandArgumentSpec | null,
): IShellCompletionEntry[] => {
  if (!argumentSpec?.suggestions?.length) {
    return [];
  }
  return argumentSpec.suggestions.flatMap((entry) =>
    createValueEntryFromSuggestionSpec(entry, argumentSpec),
  );
};`,
  },

  // 4) buildOptionValueEntries：去掉 partial
  {
    find: `const buildOptionValueEntries = (
  flagSpec: IShellCommandOptionSpec,
  argumentIndex: number,
  partial: string,
): IShellCompletionEntry[] =>
  buildArgumentValueEntries(
    getArgumentSpecAtIndex(getOptionArgumentSpecs(flagSpec), argumentIndex),
    partial,
  );`,
    replace: `const buildOptionValueEntries = (
  flagSpec: IShellCommandOptionSpec,
  argumentIndex: number,
): IShellCompletionEntry[] =>
  buildArgumentValueEntries(getArgumentSpecAtIndex(getOptionArgumentSpecs(flagSpec), argumentIndex));`,
  },

  // 5) buildPositionalArgumentValueEntries：去掉 partial
  {
    find: `const buildPositionalArgumentValueEntries = (
  commandNode: IShellCommandNodeSpec,
  argumentIndex: number,
  partial: string,
): IShellCompletionEntry[] =>
  buildArgumentValueEntries(getArgumentSpecAtIndex(commandNode.args ?? [], argumentIndex), partial);`,
    replace: `const buildPositionalArgumentValueEntries = (
  commandNode: IShellCommandNodeSpec,
  argumentIndex: number,
): IShellCompletionEntry[] =>
  buildArgumentValueEntries(getArgumentSpecAtIndex(commandNode.args ?? [], argumentIndex));`,
  },

  // 6) resolveInlineFlagValueContext：返回值去掉不再使用的 partial
  {
    find: `): (IFlagValueContext & { partial: string }) | null => {
  if (!currentToken.startsWith('-')) {
    return null;
  }
  const separatorIndex = currentToken.indexOf('=');
  if (separatorIndex === -1) {
    return null;
  }
  const flagToken = currentToken.slice(0, separatorIndex);
  const matchedFlag = findFlagSpec(collectAvailableFlags(catalogContext.visitedNodes), flagToken);
  if (!matchedFlag || getOptionArgumentCount(matchedFlag) === 0) {
    return null;
  }
  return {
    flag: matchedFlag,
    argumentIndex: 0,
    partial: currentToken.slice(separatorIndex + 1),
  };
};`,
    replace: `): IFlagValueContext | null => {
  if (!currentToken.startsWith('-')) {
    return null;
  }
  const separatorIndex = currentToken.indexOf('=');
  if (separatorIndex === -1) {
    return null;
  }
  const flagToken = currentToken.slice(0, separatorIndex);
  const matchedFlag = findFlagSpec(collectAvailableFlags(catalogContext.visitedNodes), flagToken);
  if (!matchedFlag || getOptionArgumentCount(matchedFlag) === 0) {
    return null;
  }
  return {
    flag: matchedFlag,
    argumentIndex: 0,
  };
};`,
  },

  // 7) buildVariableEntries：去掉 context 与 filterEntries
  {
    find: `const buildVariableEntries = (
  context: ICompletionContext,
  symbols: ISymbolSnapshot,
): IShellCompletionEntry[] => {
  const partial = context.variableContext?.partial ?? context.wordPrefix;
  const entries = [...createVariableEntries(symbols.variableNames, 2), ...COMMON_VARIABLE_ENTRIES];
  return filterEntries(entries, partial);
};`,
    replace: `const buildVariableEntries = (symbols: ISymbolSnapshot): IShellCompletionEntry[] => [
  ...createVariableEntries(symbols.variableNames, 2),
  ...COMMON_VARIABLE_ENTRIES,
];`,
  },

  // 8) buildCommandEntries：去掉 context 与 filterEntries
  {
    find: `const buildCommandEntries = async (
  context: ICompletionContext,
  symbols: ISymbolSnapshot,
): Promise<IShellCompletionEntry[]> => {
  const localCommandEntries = createCommandEntries(symbols.functionNames, 1);
  const recentCommandEntries = createCommandEntries(symbols.recentCommandNames, 8);
  const commandCatalogRootEntries = await loadCommandCatalogRootEntries();
  return filterEntries(
    [
      ...localCommandEntries,
      ...recentCommandEntries,
      ...commandCatalogRootEntries,
      ...SHELL_COMMAND_ENTRIES,
    ],
    context.wordPrefix,
  );
};`,
    replace: `const buildCommandEntries = async (
  symbols: ISymbolSnapshot,
): Promise<IShellCompletionEntry[]> => {
  const localCommandEntries = createCommandEntries(symbols.functionNames, 1);
  const recentCommandEntries = createCommandEntries(symbols.recentCommandNames, 8);
  const commandCatalogRootEntries = await loadCommandCatalogRootEntries();
  return [
    ...localCommandEntries,
    ...recentCommandEntries,
    ...commandCatalogRootEntries,
    ...SHELL_COMMAND_ENTRIES,
  ];
};`,
  },

  // 9) buildKeywordEntries：去掉 context 与 filterEntries
  {
    find: `const buildKeywordEntries = (context: ICompletionContext): IShellCompletionEntry[] =>
  filterEntries([...SHELL_KEYWORD_ENTRIES, ...SHELL_SNIPPET_ENTRIES], context.wordPrefix);`,
    replace: `const buildKeywordEntries = (): IShellCompletionEntry[] => [
  ...SHELL_KEYWORD_ENTRIES,
  ...SHELL_SNIPPET_ENTRIES,
];`,
  },

  // 10a) test 运算符不再过滤
  {
    find: `  if (isTestCommand(normalizedCommandName)) {
    return filterEntries(TEST_OPERATOR_ENTRIES, partial);
  }`,
    replace: `  if (isTestCommand(normalizedCommandName)) {
    return TEST_OPERATOR_ENTRIES;
  }`,
  },

  // 10b) wrapper 命令：根候选不再过滤
  {
    find: `    if (wrapperCommandSet.has(normalizedCommandName)) {
      return filterEntries(await loadCommandCatalogRootEntries(), partial);
    }`,
    replace: `    if (wrapperCommandSet.has(normalizedCommandName)) {
      return loadCommandCatalogRootEntries();
    }`,
  },

  // 10c) wrapperAwaitingCommand：根候选不再过滤
  {
    find: `  if (catalogContext.wrapperAwaitingCommand) {
    return filterEntries(await loadCommandCatalogRootEntries(), partial);
  }`,
    replace: `  if (catalogContext.wrapperAwaitingCommand) {
    return loadCommandCatalogRootEntries();
  }`,
  },

  // 10d) 内联 flag 值：去掉 partial 实参
  {
    find: `    return buildOptionValueEntries(
      inlineFlagValueContext.flag,
      inlineFlagValueContext.argumentIndex,
      inlineFlagValueContext.partial,
    );`,
    replace: `    return buildOptionValueEntries(
      inlineFlagValueContext.flag,
      inlineFlagValueContext.argumentIndex,
    );`,
  },

  // 10e) 等待 flag 值：去掉 partial 实参
  {
    find: `    return buildOptionValueEntries(
      catalogContext.awaitingFlagValue.flag,
      catalogContext.awaitingFlagValue.argumentIndex,
      partial,
    );`,
    replace: `    return buildOptionValueEntries(
      catalogContext.awaitingFlagValue.flag,
      catalogContext.awaitingFlagValue.argumentIndex,
    );`,
  },

  // 10f) 位置参数：去掉 partial 实参
  {
    find: `  const positionalArgumentEntries = partial.startsWith('-')
    ? []
    : buildPositionalArgumentValueEntries(
        catalogContext.activeNode,
        catalogContext.positionalArgumentIndex,
        partial,
      );`,
    replace: `  const positionalArgumentEntries = partial.startsWith('-')
    ? []
    : buildPositionalArgumentValueEntries(
        catalogContext.activeNode,
        catalogContext.positionalArgumentIndex,
      );`,
  },

  // 10g) 最终候选：不再过滤，直接返回
  {
    find: `  const candidates = partial.startsWith('-')
    ? flagEntries
    : [...positionalArgumentEntries, ...subcommandEntries, ...flagEntries];
  return filterEntries(candidates, partial);
};`,
    replace: `  const candidates = partial.startsWith('-')
    ? flagEntries
    : [...positionalArgumentEntries, ...subcommandEntries, ...flagEntries];
  return candidates;
};`,
  },

  // 11) buildCompletionEntries：更新调用、移除 priority 截断、加说明注释
  {
    find: `const buildCompletionEntries = async (
  language: Language,
  context: ICompletionContext,
  symbols: ISymbolSnapshot,
): Promise<IShellCompletionEntry[]> => {
  if (context.isInComment) {
    return [];
  }
  const lookaheadEntries = collectLookaheadEntries(language, context, symbols);
  if (context.variableContext || context.isDeclarationContext) {
    return dedupeEntries([...lookaheadEntries, ...buildVariableEntries(context, symbols)]).slice(
      0,
      MAX_SUGGESTIONS,
    );
  }
  const entries: IShellCompletionEntry[] = [...lookaheadEntries];
  if (context.isCommandNameContext) {
    entries.push(...(await buildCommandEntries(context, symbols)));
    entries.push(...buildKeywordEntries(context));
  } else {
    entries.push(...(await buildArgumentEntries(context)));
    if (context.isInString) {
      entries.push(...buildVariableEntries(context, symbols));
    }
  }
  if (entries.length === 0 || context.wordPrefix.length > 0) {
    entries.push(...buildKeywordEntries(context));
  }
  return dedupeEntries(entries).slice(0, MAX_SUGGESTIONS);
};`,
    replace: `// 匹配 / 打分 / 排序 / 高亮 / 限量统一交给 @codemirror/autocomplete：此处只负责
// 「按光标上下文产出候选集合」与去重，不做任何查询过滤，也不按 priority 截断
//（截断会在 CM 匹配之前丢弃可命中的低优先级候选）。priority 通过 boost 传达给 CM。
const buildCompletionEntries = async (
  language: Language,
  context: ICompletionContext,
  symbols: ISymbolSnapshot,
): Promise<IShellCompletionEntry[]> => {
  if (context.isInComment) {
    return [];
  }
  const lookaheadEntries = collectLookaheadEntries(language, context, symbols);
  if (context.variableContext || context.isDeclarationContext) {
    return dedupeEntries([...lookaheadEntries, ...buildVariableEntries(symbols)]);
  }
  const entries: IShellCompletionEntry[] = [...lookaheadEntries];
  if (context.isCommandNameContext) {
    entries.push(...(await buildCommandEntries(symbols)));
    entries.push(...buildKeywordEntries());
  } else {
    entries.push(...(await buildArgumentEntries(context)));
    if (context.isInString) {
      entries.push(...buildVariableEntries(symbols));
    }
  }
  if (entries.length === 0 || context.wordPrefix.length > 0) {
    entries.push(...buildKeywordEntries());
  }
  return dedupeEntries(entries);
};`,
  },
];

const specEdits = [
  {
    find: `  it('模糊匹配可命中非前缀候选（如 "gt" → "git"）', async () => {
    mocks.parserInit.mockResolvedValue(undefined);
    const runCompletion = createSource();

    const result = await runCompletion('gt', 2);

    expect(result?.options.some((entry) => entry.label === 'git')).toBe(true);
  });`,
    replace: `  it('补全统一交给 CodeMirror 过滤：provider 返回完整候选且不设 filter:false', async () => {
    mocks.parserInit.mockResolvedValue(undefined);
    const runCompletion = createSource();

    const result = await runCompletion('gt', 2);

    // 不再手写过滤：'git' 作为候选交给 CodeMirror，由其内建模糊匹配命中 gt→git
    expect(result?.options.some((entry) => entry.label === 'git')).toBe(true);
    // 未设 filter:false，表示匹配/打分/排序/高亮统一由 @codemirror/autocomplete 负责
    expect(result?.filter).not.toBe(false);
  });`,
  },
];

try {
  // 先全部在内存里改好并校验，任何一处失败都不落盘（原子性）。
  const results = [applyEdits(SHELL, shellEdits), applyEdits(SPEC, specEdits)];

  // 额外护栏：确认 shell-completion.ts 里手写匹配残留已清零（基于归一化文本判断）。
  for (const leftover of ['filterEntries', 'entryMatchesQuery', 'isSubsequenceMatch', 'MAX_SUGGESTIONS']) {
    if (results[0].normalized.includes(leftover)) {
      throw new Error(`迁移后仍残留 ${leftover}，已中止且未写入。请检查脚本与文件版本是否匹配。`);
    }
  }

  for (const r of results) {
    writeFileSync(r.filePath, r.out, 'utf8');
    console.log(`✔ 已更新 ${r.relPath}（${r.count} 处替换）`);
  }
  console.log('\n完成。建议接着跑：pnpm lint && pnpm test && pnpm build');
} catch (error) {
  console.error(`✘ 失败：${error.message}`);
  process.exitCode = 1;
}
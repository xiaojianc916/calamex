#!/usr/bin/env node
// 搜索性能优化 codemod（不提交，本地运行）：
//   item 1 流式刷新间隔自适应放大（消除 O(N²) 全量重算）
//   item 2 同一次搜索内按 resultKey 复用 item 对象（减分配 / GC，保留惰性 segments 缓存）
//   item 5 精确内容命中：match_end 由 match_start + 命中片段码点数推出，省去第二次从行首的 O(位置) 计数
// 每个文件「全部命中才写入」，逐条断言唯一命中；按文件探测 CRLF/LF 自适应。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const edits = [
  // ───────────────────────── item 5：后端 find.rs ─────────────────────────
  {
    file: 'src-tauri/src/commands/search/find.rs',
    replacements: [
      {
        find: `                        let match_start = match count_to_u32(
                            byte_to_char_offset(line, found.start()),
                            "匹配起始列",
                        ) {
                            Ok(value) => value,
                            Err(error) => {
                                conversion_error = Some(error);
                                return false;
                            }
                        };
                        let match_end = match count_to_u32(
                            byte_to_char_offset(line, found.end()),
                            "匹配结束列",
                        ) {
                            Ok(value) => value,
                            Err(error) => {
                                conversion_error = Some(error);
                                return false;
                            }
                        };`,
        replace: `                        let match_start_chars = byte_to_char_offset(line, found.start());
                        let match_start = match count_to_u32(match_start_chars, "匹配起始列") {
                            Ok(value) => value,
                            Err(error) => {
                                conversion_error = Some(error);
                                return false;
                            }
                        };
                        // match_end 由 match_start 加命中片段自身码点数推出，
                        // 省去第二次从行首到命中结尾的 O(位置) 码点计数。
                        let match_end = match count_to_u32(
                            match_start_chars + line[found.start()..found.end()].chars().count(),
                            "匹配结束列",
                        ) {
                            Ok(value) => value,
                            Err(error) => {
                                conversion_error = Some(error);
                                return false;
                            }
                        };`,
      },
    ],
  },

  // ──────────────── item 1 + item 2：前端 useWorkspaceSearch.ts ────────────────
  {
    file: 'src/components/workbench/sidebar/search/useWorkspaceSearch.ts',
    replacements: [
      // item 2-a：在 toResultItem 前插入复用缓存与 key 构造器
      {
        find: `  const toResultItem = (result: IWorkspaceSearchResult): ISearchResultItem => {`,
        replace: `  // 同一次搜索内按 resultKey 复用 item 对象（含其惰性 snippetSegments 缓存）：流式预览阶段
  // 已建好的内容命中 item，在命令最终权威结果覆盖时直接复用，避免整集重建与随之而来的 GC。
  let resultItemCache = new Map<string, ISearchResultItem>();

  const buildResultKey = (result: IWorkspaceSearchResult): string =>
    \`\${result.kind}:\${result.path}:\${result.lineNumber ?? 0}:\${result.matchStart ?? -1}:\${result.matchEnd ?? -1}\`;

  const toResultItem = (result: IWorkspaceSearchResult): ISearchResultItem => {`,
      },
      // item 2-b：toResultItem 内的 resultKey 改用统一构造器（与缓存键一致）
      {
        find: `      resultKey: \`\${result.kind}:\${result.path}:\${result.lineNumber ?? 0}:\${result.matchStart ?? -1}:\${result.matchEnd ?? -1}\`,`,
        replace: `      resultKey: buildResultKey(result),`,
      },
      // item 2-c：追加结果时优先复用缓存中的 item
      {
        find: `    resultChunks.value = [...resultChunks.value, results];
    for (const result of results) {
      const item = toResultItem(result);
      appendResultToScope('all', item);
      appendResultToScope(item.reason, item);
    }`,
        replace: `    resultChunks.value = [...resultChunks.value, results];
    for (const result of results) {
      const key = buildResultKey(result);
      let item = resultItemCache.get(key);
      if (!item) {
        item = toResultItem(result);
        resultItemCache.set(key, item);
      }
      appendResultToScope('all', item);
      appendResultToScope(item.reason, item);
    }`,
      },
      // item 2-d：仅在「重置为空」时丢弃复用缓存；最终结果覆盖流式预览时保留以复用
      {
        find: `  const replaceBackendResults = (results: readonly IWorkspaceSearchResult[]): void => {
    resultChunks.value = [];
    searchResultsByScopeState = createEmptyResultsByScope();
    searchGroupsByScopeState = createEmptyGroupsByScope();
    appendBackendResults(results);`,
        replace: `  const replaceBackendResults = (results: readonly IWorkspaceSearchResult[]): void => {
    resultChunks.value = [];
    searchResultsByScopeState = createEmptyResultsByScope();
    searchGroupsByScopeState = createEmptyGroupsByScope();
    // 仅在「重置为空」（新搜索开始 / 清空 / 出错）时丢弃复用缓存；命令最终权威结果覆盖流式
    // 预览时（results 非空）保留缓存，使同 resultKey 的内容命中 item 直接复用、避免整集重建。
    if (results.length === 0) {
      resultItemCache.clear();
    }
    appendBackendResults(results);`,
      },
      // item 1：流式刷新间隔随累积结果数自适应放大
      {
        find: `  const scheduleStreamResultsFlush = (): void => {
    if (streamResultsFlushTimer) {
      return;
    }
    streamResultsFlushTimer = setTimeout(() => {
      streamResultsFlushTimer = null;
      flushPendingStreamResults();
    }, SEARCH_STREAM_FLUSH_INTERVAL_MS);
  };`,
        replace: `  // 流式刷新间隔随已累积结果数自适应放大：结果越多，每次刷新触发的全量重算
  // （searchResultGroups / flatSearchRows / 虚拟化器 measure）越贵，故降低刷新频率，
  // 把整段流式的重算总量从 ~O(N²) 拉回近 O(N)。仍是渐进出结果，只是到几千条后刷新
  // 粒度变粗——人眼本就追不动高频刷新的几千条，体感无损。
  const nextStreamFlushDelayMs = (): number => {
    const accumulated = searchResultsByScopeState.all.length;
    if (accumulated >= 8000) return 480;
    if (accumulated >= 2000) return 240;
    if (accumulated >= 500) return 96;
    return SEARCH_STREAM_FLUSH_INTERVAL_MS;
  };

  const scheduleStreamResultsFlush = (): void => {
    if (streamResultsFlushTimer) {
      return;
    }
    streamResultsFlushTimer = setTimeout(() => {
      streamResultsFlushTimer = null;
      flushPendingStreamResults();
    }, nextStreamFlushDelayMs());
  };`,
      },
    ],
  },
];

let anyFail = false;
for (const { file, replacements } of edits) {
  if (!existsSync(file)) {
    console.error(`✗ 缺少文件: ${file}`);
    anyFail = true;
    continue;
  }
  const original = readFileSync(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const toEol = (s) => s.split('\n').join(eol);

  let next = original;
  const problems = [];
  for (const { find, replace } of replacements) {
    const f = toEol(find);
    const count = next.split(f).length - 1;
    if (count !== 1) {
      problems.push(`期望唯一命中，实际 ${count} 处 ← ${find.split('\n')[0].trim()}`);
      continue;
    }
    next = next.replace(f, toEol(replace));
  }

  if (problems.length > 0) {
    anyFail = true;
    console.error(`✗ ${file}:\n  - ${problems.join('\n  - ')}`);
    continue;
  }
  if (next === original) {
    console.log(`• ${file}: 无变化`);
    continue;
  }
  writeFileSync(file, next);
  console.log(`✓ ${file}: 应用 ${replacements.length} 处`);
}

if (anyFail) {
  console.error('\n未写入存在问题的文件（该文件全部回滚）：请确认仓库为最新（与已分析版本一致）后重试。');
  process.exit(1);
}
console.log('\n完成。');
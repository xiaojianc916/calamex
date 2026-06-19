#!/usr/bin/env node
/**
 * fix-batch-3-patch2.mjs — 补修 L-1 最后一个未匹配的 patch
 * 添加 GIT_FILE_BASELINE_QUERY_PREFIX 常量 + setQueryDefaults
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ENCODING = 'utf-8';

function patchFile(relPath, patches) {
  const absPath = join(ROOT, relPath);
  if (!existsSync(absPath)) {
    console.warn(`  ⚠️ 文件不存在: ${relPath}`);
    return 0;
  }
  let content = readFileSync(absPath, ENCODING);
  let changes = 0;
  for (const { oldStr, newStr, description } of patches) {
    if (!content.includes(oldStr)) {
      console.warn(`  ⚠️ 未找到匹配 (跳过): ${description}`);
      continue;
    }
    content = content.replace(oldStr, newStr);
    console.log(`  ✅ ${description}`);
    changes++;
  }
  if (changes > 0) {
    writeFileSync(absPath, content, ENCODING);
  }
  return changes;
}

const changes = patchFile('src/store/git.ts', [
  {
    description: 'L-1 补: 添加 GIT_FILE_BASELINE_QUERY_PREFIX 常量 + setQueryDefaults',
    // 用文件中实际存在的精确文本（setQueryDefaults，不是 setQueryOptions）
    oldStr:
`  queryClient.setQueryDefaults(GIT_COMMIT_FILE_DIFF_PREVIEW_QUERY_PREFIX, { staleTime: Infinity });

  const commitStatsQueryKey = (cacheKey: string): string[] => [`,
    newStr:
`  queryClient.setQueryDefaults(GIT_COMMIT_FILE_DIFF_PREVIEW_QUERY_PREFIX, { staleTime: Infinity });

  // file baseline 查询：按文件路径寻址，文件被修改后需刷新，
  // 交由 vue-query 的 fetchQuery 去重 + removeQueries 失效，替代手写缓存 + pending 表。
  const GIT_FILE_BASELINE_QUERY_PREFIX = ['git', 'fileBaseline'];
  queryClient.setQueryDefaults(GIT_FILE_BASELINE_QUERY_PREFIX, { staleTime: Infinity });

  const commitStatsQueryKey = (cacheKey: string): string[] => [`,
  },
]);

console.log(`\nDone. ${changes} patches applied.`);
if (changes === 0) {
  console.log('\n仍未匹配。请手动在 src/store/git.ts 中操作：');
  console.log('找到 queryClient.setQueryDefaults(GIT_COMMIT_FILE_DIFF_PREVIEW_QUERY_PREFIX, { staleTime: Infinity });');
  console.log('在其下方、commitStatsQueryKey 定义之前，插入以下 3 行：');
  console.log('');
  console.log("  const GIT_FILE_BASELINE_QUERY_PREFIX = ['git', 'fileBaseline'];");
  console.log('  queryClient.setQueryDefaults(GIT_FILE_BASELINE_QUERY_PREFIX, { staleTime: Infinity });');
  console.log('（上方加一行注释：// file baseline 查询：按路径寻址，vue-query fetchQuery 去重 + removeQueries 失效）');
}
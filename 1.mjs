#!/usr/bin/env node
// fix-query-client.mjs —— 修复 src/lib/query-client.ts 的 ts2339 / ts2345
// 在项目根目录运行：node fix-query-client.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REL = 'src/lib/query-client.ts';
const file = resolve(process.cwd(), REL);

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

let src;
try {
  src = await readFile(file, 'utf8');
} catch (e) {
  console.error(`✗ 读取失败 ${REL}: ${e.message}`);
  process.exit(1);
}

if (src.includes('TPageParam = never,') && src.includes('type FetchQueryOptions')) {
  console.log(`• 跳过（已修复） ${REL}`);
  process.exit(0);
}

let next = src;

// ── ① 扩展 import：补 DefaultError / FetchQueryOptions / QueryKey ──────────────
if (!/type FetchQueryOptions/.test(next)) {
  const oldImport = "import { QueryClient } from '@tanstack/vue-query';";
  must(next.includes(oldImport), '未找到 QueryClient import 锚点，文件可能已偏离 HEAD');
  next = next.replace(
    oldImport,
    `import {
  QueryClient,
  type DefaultError,
  type FetchQueryOptions,
  type QueryKey,
} from '@tanstack/vue-query';`,
  );
}

// ── ② 重写 fetchQuery：对齐基类 5 泛型重载 ───────────────────────────────────
const NEW_METHOD = `  // 与 QueryClient.fetchQuery 原生重载完全对齐的泛型签名
  // (TQueryFnData / TError / TData / TQueryKey / TPageParam)。
  // 旧的单泛型 <T> + Parameters<...>[0] 会带来两个问题：
  //   1. options 被推断为 MaybeRefDeep<FetchQueryOptions<...>>，无法直接取 .queryKey（ts2339）；
  //   2. 签名与基类不兼容，导致 CalamexQueryClient 不能赋给 persist-client 期望的 QueryClient（ts2345）。
  // 透传完整泛型并接收具体 FetchQueryOptions 后，调用方仍可写
  // fetchQuery<IGitCommitDetailPayload>(...)（TData 默认取 TQueryFnData），且 .queryKey 可直接访问。
  override fetchQuery<
    TQueryFnData = unknown,
    TError = DefaultError,
    TData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
    TPageParam = never,
  >(
    options: FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey, TPageParam>,
  ): Promise<TData> {
    const previousData = this.getQueryData<TData>(options.queryKey);

    return super
      .fetchQuery<TQueryFnData, TError, TData, TQueryKey, TPageParam>(options)
      .then((data) => {
        const cachedData = this.getQueryData<TData>(options.queryKey) ?? data;
        const sharedData = structurallyShareSerializableData(previousData, cachedData) as TData;

        if (sharedData !== cachedData) {
          this.setQueryData<TData>(options.queryKey, sharedData);
        }

        return sharedData;
      });
  }`;

const methodRe =
  / {2}\/\/ QueryClient\.fetchQuery[\s\S]*?return sharedData as T;\n {4}\}\);\n {2}\}/;
must(methodRe.test(next), '未找到 fetchQuery 重写块锚点，文件可能已偏离 HEAD');
next = next.replace(methodRe, NEW_METHOD);

if (next === src) {
  console.log(`• 无变化 ${REL}`);
  process.exit(0);
}

await writeFile(file, next, 'utf8');
console.log(`✓ 已修复 ${REL}`);
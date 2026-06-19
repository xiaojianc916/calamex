// fix-warmpool.mjs — 放仓库根目录；在 agent-sidecar 内执行： node ..\fix-warmpool.mjs
import { readFileSync, writeFileSync } from 'node:fs';

function patch(rel, edits) {
  const raw = readFileSync(rel, 'utf8');
  const hadCRLF = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');
  let applied = 0, skipped = 0;
  for (const { tag, oldStr, newStr } of edits) {
    const n = text.split(oldStr).length - 1;
    if (n === 0) { console.log(`- skip: ${tag}（0 匹配，可能已应用）`); skipped++; continue; }
    if (n > 1)  { console.log(`- skip: ${tag}（${n} 处匹配，拒绝歧义替换）`); skipped++; continue; }
    text = text.replace(oldStr, newStr);
    console.log(`+ 应用: ${tag}`); applied++;
  }
  if (applied > 0) writeFileSync(rel, hadCRLF ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  console.log(`${rel}: ${applied} applied, ${skipped} skipped\n`);
}

patch('src/tools/mcp/gateway/warm-pool.ts', [
  {
    tag: 'listTools: withServer 抛错回退已缓存 catalog（兑现设计契约）',
    oldStr:
`    const catalog = await this.withServer(input, (bundle) => {
      this.cacheCatalogVariants(input.serverName, bundle);
      return this.catalog.get(catalogKey) ?? createCatalogFromBundle(input.serverName, input.profile, bundle);
    });
    this.emitCatalogMetric(input, false, startedAt, catalog);
    return catalog;`,
    newStr:
`    let catalog: IMcpGatewayCatalog;
    try {
      catalog = await this.withServer(input, (bundle) => {
        this.cacheCatalogVariants(input.serverName, bundle);
        return this.catalog.get(catalogKey) ?? createCatalogFromBundle(input.serverName, input.profile, bundle);
      });
    } catch (error) {
      // bundle 可能在创建成功后、被本次 withServer 取用前，因并发 evictOverflow
      // 抖动而断开（warm 上限 < server 总数时，刚建好但尚未标记 active 的 entry
      // 会先成为「最旧」项被淘汰）。catalog 已在 bundle 创建时缓存，回退命中缓存，
      // 与 listAllToolsUncached 注释承诺的「被 evict 的服务走缓存」契约一致。
      const cachedAfterEvict = this.catalog.get(catalogKey);
      if (!cachedAfterEvict) {
        throw error;
      }
      catalog = cachedAfterEvict;
    }
    this.emitCatalogMetric(input, false, startedAt, catalog);
    return catalog;`,
  },
]);
console.log('done');
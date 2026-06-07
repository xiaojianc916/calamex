## A+B 性能优化跟进记录

本页记录本轮已落到 `main` 的 A/B 优化点。原则是：优先使用业界常用、可验证、低风险的算法与数据结构；对 Worker 化、跨线程缓存等影响面更大的改动继续拆小批次推进，避免一次性上“屠龙术”。

## A1：工作区搜索文件缓存的事件驱动增量刷新

- 文件：`src-tauri/src/commands/search/scan.rs`
- 问题：搜索文件列表虽已有缓存，但 watcher 标脏后下一次搜索会全量重扫工作区。单个源文件新增/删除/修改时，全量重扫对大仓库不划算。
- 算法：watcher 记录最多 512 个有效变更路径。下一次搜索时若变更路径可安全解释为文件级新增/删除/更新，则在现有 `HashMap<relative_path, ScannedFile>` 上增量更新，再排序输出；目录级变化、事件风暴或路径形态不确定时回退到全量扫描。
- 复杂度：
  - 之前：任意有效变更后的下一次搜索可能 O(N) 重建文件列表。
  - 之后：普通单文件变化为 O(C + N log N 的最终稳定排序)，其中 C 为变更路径数；目录/事件风暴保持 O(N) fallback，优先保证正确性。
- 正确性：仍复用原有跳过目录/扩展名规则；删除目录且缓存中存在子文件时回退全量扫描，避免 stale entries。新增单测覆盖增量新增/删除与删除目录 fallback。

## B2：内容模糊搜索的轻量必要条件预过滤

- 文件：`src-tauri/src/commands/search/find.rs`
- 问题：内容模糊搜索会对每一行进入 nucleo matcher；对大文件、多文件查询，明显不可能命中的行也会消耗 matcher 成本。
- 算法：在 nucleo 前加 `FuzzyLinePrefilter`，仅检查不会误杀的必要条件：
  - 候选行字符数至少覆盖 query 的非空白字符数。
  - query 中出现过的 ASCII 字母/数字必须也出现在候选行中。
  - 非 ASCII 字符不作为强约束，避免 Unicode 归一化差异导致误杀。
- 取舍：这是 Bloom-filter 风格的“允许假阳性、不允许假阴性”预过滤；真正匹配、排序、高亮仍由 nucleo 负责，保持行为稳定。
- 验证：新增大小写、缺失 ASCII、非 ASCII 安全性的单测。

## B3：替换预览 diff 的预算上限

- 文件：`src-tauri/src/commands/search/replace.rs`
- 问题：替换预览对超大输入或海量编辑生成完整 diff，可能造成卡顿。
- 算法：为 diff 输入字节数与编辑数量加预算阈值；小输入仍走精确 diff，大输入返回明确省略信息。
- 取舍：不影响实际替换，只限制预览成本；可避免 UI 为少数极端文件付出不可控代价。
- 验证：新增小输入正常 diff、超大输入省略、编辑过多省略的单测。

## 当前仍需拆小批次推进的项

- A2：终端隐藏输出有界 backlog。影响 `TerminalSession` 离屏写入/可见恢复路径，需要配套前端测试或手动回归。
- A3：Shiki Worker 化。会影响编辑器高亮初始化、worker 打包、fallback 路径，建议单独提交。
- B1：Bash 符号级 mtime/hash 增量 AST 缓存。需要设计 per-file AST/symbol 缓存失效与 watcher 事件合并策略，建议在 A1 稳定后继续。

## 建议验证命令

```bash
cd src-tauri
cargo test -p calamex commands::search::find
cargo test -p calamex commands::search::replace
cargo test -p calamex commands::search::scan
cargo clippy
cargo test
```

```bash
pnpm typecheck
pnpm lint
pnpm test
```
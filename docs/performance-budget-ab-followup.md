## 工作区搜索文件缓存的事件驱动增量刷新

- 文件：`src-tauri/src/commands/search/scan.rs`
- 问题：搜索文件列表虽已有缓存，但 watcher 标脏后下一次搜索会全量重扫工作区。单个源文件新增/删除/修改时，全量重扫对大仓库不划算。
- 算法：watcher 记录最多 512 个有效变更路径。下一次搜索时若变更路径可安全解释为文件级新增/删除/更新，则在现有 `HashMap<relative_path, ScannedFile>` 上增量更新，再排序输出；目录级变化、事件风暴或路径形态不确定时回退到全量扫描。
- 复杂度：
  - 之前：任意有效变更后的下一次搜索可能 O(N) 重建文件列表。
  - 之后：普通单文件变化为 O(C + N log N 的最终稳定排序)，其中 C 为变更路径数；目录/事件风暴保持 O(N) fallback，优先保证正确性。
- 正确性：仍复用原有跳过目录/扩展名规则；删除目录且缓存中存在子文件时回退全量扫描，避免 stale entries。新增单测覆盖增量新增/删除与删除目录 fallback。
- 验证：`cargo test -p calamex commands::search::scan`、`cargo clippy`、`cargo test`。
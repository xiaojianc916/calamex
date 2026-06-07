## A+B 性能优化跟进记录

本页记录本轮已落到 `main` 的 A/B 优化点。原则是：优先使用业界常用、可验证、低风险的算法与数据结构；对跨线程等影响面较大的改动也保持可回退路径，避免一次性上“屠龙术”。

## A1：工作区搜索文件缓存的事件驱动增量刷新

- 文件：`src-tauri/src/commands/search/scan.rs`
- 问题：搜索文件列表虽已有缓存，但 watcher 标脏后下一次搜索会全量重扫工作区。单个源文件新增/删除/修改时，全量重扫对大仓库不划算。
- 算法：watcher 记录最多 512 个有效变更路径。下一次搜索时若变更路径可安全解释为文件级新增/删除/更新，则在现有 `HashMap<relative_path, ScannedFile>` 上增量更新，再排序输出；目录级变化、事件风暴或路径形态不确定时回退到全量扫描。
- 复杂度：
  - 之前：任意有效变更后的下一次搜索可能 O(N) 重建文件列表。
  - 之后：普通单文件变化为 O(C + N log N 的最终稳定排序)，其中 C 为变更路径数；目录/事件风暴保持 O(N) fallback，优先保证正确性。
- 正确性：仍复用原有跳过目录/扩展名规则；删除目录且缓存中存在子文件时回退全量扫描，避免 stale entries。新增单测覆盖增量新增/删除与删除目录 fallback。

## A2：终端隐藏输出有界 backlog

- 文件：`src/terminal/session.ts`
- 问题：终端面板隐藏时，输出会先累计到隐藏 backlog，长时间运行高输出命令可能导致字符串无界增长，恢复可见时还会一次性回放过多内容。
- 算法：将隐藏 backlog 改为“保留最新内容”的有界缓冲，容量为 512 KiB；超过预算时丢弃最旧输出，并在回放内容前加入灰色省略提示。
- 取舍：离屏状态下极端长输出不再保证完整保留，但可显著降低内存和恢复可见时的卡顿风险；可见状态下的正常终端输出路径不受影响。
- 验证：需重点回归“隐藏终端 → 运行大量输出 → 再显示终端”的恢复、滚动到底部、run completed 回调时序。

## A3a：Shiki 可见区 token LRU 缓存

- 文件：`src/services/editor/shiki-highlighter.ts`
- 问题：编辑器已有可见区切片与防抖，但滚动、布局刷新、语言 ready effect 等路径可能对相同代码窗口重复调用 Shiki/Oniguruma tokenize。
- 算法：在 Shiki highlighter 层增加固定 32 项的 LRU token 缓存，key 为 `shikiId + code slice`；命中时直接复用 token 行，未命中才进入 `codeToTokensBase`。
- 复杂度：
  - 之前：重复窗口高亮每次都付出 O(slice) tokenize 成本。
  - 之后：重复窗口命中为 O(1) Map 访问；最多缓存 32 个不超过 200 KiB 的切片结果，避免无界增长。
- 取舍：这是 Worker 化前的低风险热路径优化，不改变渲染模型、不改打包配置、不引入跨线程通信；真正 Worker 化仍建议单独提交。

## A3b：Shiki Worker 化

- 文件：
  - `src/services/editor/shiki-tokenizer.worker.ts`
  - `src/services/editor/shiki-highlighter.ts`
  - `src/services/editor/codemirror-shiki-highlight.ts`
  - `src/services/editor/shiki-shared.ts`
- 问题：即使做了可见区切片和 LRU，Shiki/Oniguruma tokenize 仍可能在主线程形成长任务，影响输入和滚动流畅度。
- 算法：将 tokenize 请求通过 Vite module worker 发送到独立线程：
  - Worker 内部独立初始化 `shiki/core`、Oniguruma WASM、主题和按需语言。
  - CodeMirror 插件提交异步高亮请求，结果通过 `StateEffect` 回填 decorations。
  - 每次请求带递增 `requestId` 与 `docVersion`；过期结果直接丢弃，避免滚动/编辑竞态错刷。
  - `shiki-shared.ts` 仅保留 Shiki-only 依赖，避免 Worker bundle 间接拉入 CodeMirror registry / HighlightStyle。
  - 主线程保留 LRU token cache；Worker 不可用或运行失败时回退主线程异步 tokenize，单次 Worker 超时则放弃本轮高亮，避免重任务回流 UI 线程。
- 复杂度：
  - 主线程从 O(slice tokenize) 降为 O(slice 截取 + decorations 回填)，重 tokenize 的 CPU 成本移出主线程。
  - 仍保留 200 KiB 单次切片预算，避免给 Worker 发送超大任务。
- 取舍：首次语言加载仍会产生 Worker 初始化成本；但后续滚动/重算不会阻塞主线程。fallback 路径保证兼容性。

## B1：Bash 符号级 mtime/hash 增量 AST 缓存

- 文件：`src-tauri/src/commands/search/scan.rs`
- 问题：此前 Bash 符号已有工作区级聚合缓存，但任何有效文件变更都会清空聚合符号缓存；下一次符号搜索需要重新解析所有 shell-like 文件。
- 算法：保留 per-file 符号缓存 `HashMap<relative_path, CachedSymbolFile>`：
  - 文件 `len + mtime` 未变时直接复用符号结果，不读取文件、不跑 tree-sitter。
  - `mtime` 变化时读取文件并计算内容 hash；hash 未变则复用旧符号，仅刷新 fingerprint。
  - 只有 hash 也变化时才重新 decode + tree-sitter 解析该文件。
  - 聚合符号索引仍按文件顺序扁平化，保证结果稳定。
- 复杂度：
  - 之前：任一有效文件变更后符号搜索可能 O(S * parse) 重建全部 shell-like 文件符号，其中 S 为 shell-like 文件数。
  - 之后：未变文件为 O(1) metadata 检查；mtime 变但内容未变为 O(file bytes) hash；真正变更文件才付出 parse 成本。
- 取舍：使用标准库哈希作为缓存相等性短路，不作为安全散列；若读取失败或无法 decode，按空符号结果缓存/返回，优先保证搜索不中断。
- 验证：新增单测覆盖 metadata 命中复用与 mtime 变化但 hash 相同复用。

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

## C1：路径补全建议的有界 LRU 缓存

- 文件：`src/composables/useWorkspacePathSuggestions.ts`
- 问题：搜索包含/排除路径输入框会缓存目录列表，并在无斜杠 query 下调用后端文件名模糊搜索；用户在大仓库里浏览很多目录或反复输入相同 query 时，容易出现重复 IPC 或缓存无界增长。
- 算法：
  - 目录列表缓存改为 64 项 LRU，key 为相对目录路径。
  - 文件名模糊搜索结果增加 64 项 LRU，key 为 `matchCase + limit + query`。
  - 命中时通过 Map delete + reinsert 更新最近访问顺序；超过容量时淘汰最久未使用项。
  - 工作区根变化时同时清空两个缓存，避免跨工作区污染。
- 复杂度：
  - 重复目录补全 / 重复文件名 query 从一次 IPC 降为 O(1) Map 命中。
  - 缓存空间从潜在无界收敛到 O(64 + 64)。
- 取舍：仍保留后端 nucleo 作为真实模糊排序来源；只缓存短期交互结果，不改变排序与匹配语义。
- 验证：新增单测覆盖 LRU 淘汰、命中刷新与已有 key 更新。

## C2：Git pathspec 零分配目录匹配

- 文件：`src-tauri/src/commands/git/status.rs`
- 问题：stage / unstage / 部分提交构建树时会在循环中反复调用 pathspec 匹配；旧实现通过 `format!("{pathspec}/")` 构造目录前缀，容易在大量文件或目录级操作时产生重复短字符串分配。
- 算法：改为边界检查式匹配：先判断候选路径与 pathspec 精确相等；否则用 `strip_prefix(pathspec)` 取得后缀，并检查后缀首字节是否为 `/`。同时复用同一 helper 覆盖部分提交的目录覆盖判断。
- 复杂度：
  - 匹配语义保持“精确文件或目录前缀”。
  - 每次匹配仍为 O(path length)，但从带分配的前缀构造降为零分配边界判断。
- 取舍：不引入复杂 glob/pathspec 引擎，只优化当前已有语义；避免把简单文件/目录选择过度升级成完整 Git pathspec 解析。
- 验证：新增单测覆盖精确文件、目录前缀、`src` 不误匹配 `src-old`、嵌套目录边界等情况。

## C3：Git 历史分页原地追加

- 文件：`src/store/git.ts`
- 问题：提交历史分页加载更多时，旧实现使用 `[...commitHistory, ...entries]` 创建新数组；历史越长，每次 append 都需要复制既有全部提交。
- 算法：非 append 请求仍整体替换数组；append 请求改为 `commitHistory.value.push(...entries)`，复用现有响应式数组，仅追加新页。
- 复杂度：
  - 之前：每页追加为 O(existing + page) 且分配新数组。
  - 之后：每页追加为 O(page)，避免复制旧历史。
- 取舍：Vue/Pinia 对数组 push 保持响应式；为了降低风险，新增单测验证分页追加结果、offset 传参，以及 append 时复用现有数组引用。

## C4：Git 历史图布局 LRU 记忆化

- 文件：`src/utils/git-graph.ts`
- 问题：Git 历史图布局虽已用 Map + 最小堆优化单次计算，但父组件刷新、悬浮卡片状态变化或相同提交数组重建时，仍可能对同一提交拓扑重复构建 lanes 与 edge graph。
- 算法：为 `buildGitGraph` 增加 16 项 LRU 布局缓存：
  - key 基于提交数量、提交 id、parentIds，并使用长度前缀编码，避免普通分隔符拼接导致碰撞。
  - 命中时直接返回已有 layout，并刷新 LRU 顺序。
  - 超过 16 项后淘汰最久未使用的布局。
- 复杂度：
  - 之前：相同拓扑重复构图仍为 O(commits + edges)。
  - 之后：相同拓扑命中为 O(key construction) + O(1) Map 访问；避免重复 lane / edge 分配。
- 取舍：不做复杂 append-aware 增量 Git graph（容易影响 merge/fork 语义），先用低风险 memoization 覆盖常见重复渲染场景。
- 验证：新增单测覆盖相同拓扑复用、长度前缀 key 防碰撞，以及超过上限淘汰最久未使用布局。

## 建议验证命令

```bash
cd src-tauri
cargo test -p calamex commands::git::status
cargo test -p calamex commands::git
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
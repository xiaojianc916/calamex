# 性能预算（Performance Budget）

记录 AI 相关热点路径的算法优化，每条包含「问题 / 算法 / 复杂度（前后）/ 正确性 / 验证」。
所有复杂度均为分析值；真实耗时请在本机用对应测试 / profiler 复测后补录到对应条目。

## buildReversePatchSet：回滚补丁的文件匹配

- 文件：`src/composables/ai/useAiAssistant.patch.ts`
- 问题：回滚时需从所有补丁文件里挑出 summary 记录过的文件。原实现对每个补丁文件都用
  `summary.files.some(areFileSystemPathsEqual)` 线性扫描，且每次比较都重复归一化两条路径。
- 算法：预归一化 + 哈希集合成员判断。先把 summary 路径用与 `areFileSystemPathsEqual`
  完全一致的口径归一化进 `Set`，再对补丁文件做 O(1) 命中判断。
- 复杂度：
  - 之前：O(P × S)（P=补丁文件数，S=summary 文件数），并伴随约 2×P×S 次路径归一化。
  - 之后：O(P + S)，每条路径仅归一化一次。
- 正确性：归一化口径与 `areFileSystemPathsEqual` 保持完全一致（含 Windows 盘符大小写折叠），
  匹配结果不变；新增单测覆盖等价路径、Windows 大小写折叠、hunk 反转、无交集与空补丁。
- 验证：`pnpm test src/composables/ai/useAiAssistant.patch.spec.ts`、`pnpm typecheck`、`pnpm lint`。

## trim_terminal_snapshot：终端快照裁剪的摊还化

- 文件：`src-tauri/src/terminal/snapshot.rs`（裁剪策略）、`src-tauri/src/commands/terminal/state.rs`（`append_terminal_snapshot` 调用点）
- 问题：交互/运行输出通过 `append_terminal_snapshot` 不断 `push_str` 进会话快照，原
  `trim_terminal_snapshot` 每次都把快照裁到正好 160 KiB 上限。一旦到顶，之后每追加一段
  输出都会触发约 160 KiB 的 `String::drain(..)` 头部搬移（memmove）；在持续高吞吐输出
  （构建日志、`cat` 大文件）下整体退化为 O(n²)。
- 算法：低水位摊还裁剪（high-/low-water mark）。仅当超过上限（160 KiB）时才裁剪，且一次性
  裁到低水位（上限的 75%，约 120 KiB），保留原有的 UTF-8 字符边界与 ESC/换行对齐。裁剪后
  留出约 25% 增长空间，使裁剪只在快照再增长约 40 KiB 后发生一次。
- 复杂度（设单次追加 k 字节、上限 M）：
  - 之前：到顶后每次追加均触发 O(M) 头部搬移 → 输出 n 字节累计 O(n·M)（即 O(n²) 量级）。
  - 之后：每次搬移推进约 M/4 的“预算”，均摊到每字节 O(1)（常数因子约 3，对应低水位比例）
    → 输出 n 字节累计 O(n)。
- 正确性：上限不变（裁剪后 `len ≤ M` 恒成立，实际回落到约 0.75M）；字符边界与 ESC/换行
  对齐逻辑保持不变，不会把 CSI 序列切在中段。新增单测覆盖：未超限不裁剪、超限回落到低水位、
  多字节边界安全、对齐到换行之后、重复追加始终不超过上限。
- 验证：`cargo test -p calamex terminal::snapshot`、`cargo clippy`、`cargo test`。

## Utf8ChunkDecoder：PTY 增量 UTF-8 解码的零拷贝快路径与去重

- 文件：`src-tauri/src/terminal/utf8_decoder.rs`（唯一实现，新增快路径）、
  `src-tauri/src/terminal/local_wsl_protocol.rs`（删除重复实现，改为零成本别名）；
  调用方：`src-tauri/src/terminal/wsl_pty.rs` 的两个 PTY 读线程。
- 问题：① 两个 PTY 读线程每次 read 8 KiB 都把整块字节 `extend_from_slice` 进内部
  `pending` 再 `from_utf8`，即便本块整体合法（绝大多数情况）也要多一次整块拷贝；
  ② 存在两份近乎相同的解码器（`Utf8ChunkDecoder` 与 `LocalWslUtf8ChunkDecoder`），
  违反“不造第二个轮子”。
- 算法：空 `pending` 零拷贝快路径 + 去重。无残留字节时直接对本次输入 `from_utf8`：
  整块合法则零拷贝直接 `push_str`；仅结尾切断一个多字节字符时，只把不完整残尾（<4 字节）
  暂存，其余直接输出。含真正非法字节的少数情况回退到原有逐段循环（U+FFFD 替代）。
  并把两份解码器合并为单一 `Utf8ChunkDecoder`，旧名保留为零成本类型别名。
- 复杂度（设单次输入 k 字节）：
  - 之前：每次 read 必有一次 O(k) 整块拷贝进 `pending`（无论是否合法）。
  - 之后：合法 / 仅尾部切断的主路径无额外拷贝（仅暂存 <4 字节残尾），O(k) 仅为
    `from_utf8` 校验本身；非法字节回退路径与原实现一致。
- 正确性：解码结果与原实现逐字节等价；新增单测覆盖整块合法、跨 read 切断、中段非法字节、
  结尾不完整 + last 收尾、空输入收尾等情况。去重后行为由 `Utf8ChunkDecoder` 单一实现保证。
- 验证：`cargo test -p calamex terminal::utf8_decoder`、`cargo clippy`、`cargo test`。

## 终端 PTY 输出事件的源头合批

- 文件：`src-tauri/src/terminal/wsl_pty.rs`（两个 PTY 读线程）
- 问题：交互与运行读线程每次 `reader.read`（8 KiB）都直接 `on_event` 发一个 Tauri
  事件（InteractiveData / RunChunk）。高吞吐输出（构建日志、`cat` 大文件、`yes`）下
  会以每 8 KiB 一次的频率洪水般创建 IPC 事件，序列化与 JS 事件处理开销随之上升。
  （前端 session.ts 已有 16ms 写入合批，但源头未合批。）
- 算法：“饱和则攒批、排空即 flush”启发式合批。把多次 read 的解码结果累加到 `pending_out`：
  当本次 read 读满整个缓冲（`read == buffer.len()`，表明管道仍饱和）时继续攒批；一旦
  未读满（突发已排空，常见于交互单字符回显）立即 flush 以保低延迟；攒批超 32 KiB 强制
  flush 避免无界增长；读线程结束时补全解码残尾并一次性 flush 剩余。判决逻辑抽为纯函数
  `should_flush_terminal_output` 以便单测。
- 复杂度（设突发输出共 N 字节，缓冲 B=8 KiB，阈值 T=32 KiB）：
  - 之前：事件数 ≈ N/B（每读一次发一个）。
  - 之后：突发期间事件数 ≈ N/T（约降为原来的 1/4）；交互小输出仍立即发出，延迟不变。
- 正确性：所有字节最终按原顺序送达前端（只是合并成更少的事件）；交互回显不被扣留（未读满
  立即 flush）；空解码结果不会发出空事件（`pending_len == 0` 守卫）。新增单测覆盖启发式
  的四种边界（空攒批、饱和未达阈、饱和超阈、未读满）。
- 验证：`cargo test -p calamex terminal::wsl_pty`、`cargo clippy`、`cargo test`；本机手动复测：
  `cat` 一个数 MB 文件观察滚动流畅度与 CPU 占用。

## 终端快照跳过判定的单次 ANSI 扫描

- 文件：`src-tauri/src/commands/terminal/state.rs`（`should_skip_snapshot_for_interactive_resize_repaint`）
- 问题：每段交互输出都调用该判定；原实现对同一 chunk 先后调用 `contains_alt_screen_switch`
  与 `resolve_alt_screen_state_after_data`，二者各自跑一遍完整 vte 解析（`scan_ansi_csi_events`），
  即同一段数据被 vte 解析两遍。
- 算法：单次扫描复用结果。改为只调用一次 `scan_ansi_csi_events`，从返回的
  `AnsiCsiEvents { alt_screen_switched, alt_screen_active }` 同时得出「是否含切换」与
  「应用后状态」。两个薄封装 helper 保留在 snapshot.rs（可能的其它调用方）。
- 复杂度（设 chunk 长 k）：之前 2×O(k) vte 解析/段；之后 1×O(k)/段（解析次数减半）。
- 正确性：语义逐字段等价——has_alt_screen_control == alt_screen_switched；新 alt_screen_active
  在 switched 时取事件值、否则保持原值，与 resolve_alt_screen_state_after_data 一致；其余抑制
  窗口逻辑不变。
- 验证：`cargo test -p calamex`、`cargo clippy`、`cargo test`。

## 工作区搜索结果的 top-k 堆选择

- 文件：`src-tauri/src/commands/search/find.rs`
- 问题：文件名 / 符号搜索原先把全部命中收集进 `Vec`，整体 `sort` 后再 `truncate` 到
  limit。命中数远大于 limit（大仓库模糊匹配常见）时，对 n 条结果做 O(n log n) 全量排序
  纯属浪费——最终只展示前 limit（默认 200）条。
- 算法：定长最小堆 top-k 选择。用容量为 k 的 `BinaryHeap<RankedResult>`（按 score 反序，
  使堆顶为“当前最差”）边扫描边维护：未满则入堆，已满且更优则替换堆顶，否则丢弃；最后
  `into_sorted_results` 一次性出堆并按 (score, relative_path) 稳定排序返回。
- 复杂度（设命中 n 条、取前 k 条）：
  - 之前：O(n log n)（全量排序）+ O(n) 额外内存。
  - 之后：O(n log k) 时间 + O(k) 内存；k ≪ n 时显著下降（n=50k、k=200 约省一个数量级）。
- 正确性：最终顺序与“全量排序后取前 k”完全一致（同样的 (score, relative_path) 次序）；
  并列项排序键稳定。新增单测覆盖：少于 k 条全保留、超过 k 条只保留最优 k、并列项按
  relative_path 决胜。
- 验证：`cargo test -p calamex commands::search`、`cargo clippy`、`cargo test`。

## 内容搜索的并行化（rayon）

- 文件：`src-tauri/src/commands/search/find.rs`、`src-tauri/Cargo.toml`（`rayon` 可选依赖，
  随 `desktop` 特性启用）。
- 问题：内容搜索 `search_file_contents` 原先串行遍历候选文件，逐个读盘 + 正则扫描。文件数
  多时（全仓库内容检索）单线程吞吐受限，无法利用多核。
- 算法：按文件粒度并行。用 `par_iter` 对候选文件并发执行“读盘 + 单文件扫描”，每个文件
  产出局部命中向量，再按文件原始顺序归并并截断到 limit。文件之间无共享可变状态，正则
  matcher 以 `Sync` 引用跨线程共享（只读）。
- 复杂度（设文件数 F、单文件扫描成本 c、核数 P）：
  - 之前：O(F·c) 串行。
  - 之后：O(F·c / P) 并行墙钟（受 IO 带宽与调度开销约束）；总工作量不变。
- 正确性：结果集合与串行版一致；按文件顺序归并后再截断，保证 limit 截断点稳定、可复现。
  匹配 matcher 只读共享不引入数据竞争。
- 验证：`cargo clippy`、`cargo test`；本机用大仓库内容检索对比墙钟耗时后补录实测。

## 内容模糊匹配（nucleo 子序列）+ 高亮区间回填

- 文件：`src-tauri/src/commands/search/{find.rs,types.rs}`、前端 `SearchSidebarPanel.vue`。
- 问题：内容搜索此前只有“精确 / 正则”两种模式。用户记不全确切串、只记得几个零散字符时，
  精确匹配召回为 0，正则又要求手写表达式，门槛高。
- 算法：可选的子序列模糊匹配（请求新增 `content_fuzzy`，默认 false=精确，开启=内容走模糊）。
  解析一次 `nucleo` 模式后用 `par_iter` 按文件并行，对每个非空行做子序列匹配；命中则记录
  匹配字符下标区间（首末下标）回填到结果 `match_start/match_end`，前端复用既有紧凑高亮路径
  直接渲染。模糊与正则在前端互斥（同时开启语义不清），文件名/符号一律保持原模糊匹配不受开关影响。
- 复杂度（设候选行 L、行均长 m、核数 P）：
  - 子序列匹配单行 O(m)，整体 O(L·m / P) 并行；模式仅解析一次，避免每行重建。
- 正确性：`content_fuzzy=false` 时行为与原精确内容搜索逐字节一致（新增单测断言模糊子序列
  在精确模式下不命中）；`true` 时命中子序列并返回非空高亮区间（新增单测断言 query "dapnow"
  命中 "deploy_app_now" 且 match_start < match_end）。前端新增单测断言开关下发 `contentFuzzy`
  且与正则互斥。
- 验证：`cargo clippy`、`cargo test`、`pnpm test`、`pnpm typecheck`、`pnpm lint`；
  其中 `cargo build` 需重新生成 `src/bindings/tauri.ts`（新增 `contentFuzzy` 字段）。

## LSP didChange 增量同步

- 文件：`src-tauri/src/commands/lsp/{types.rs,commands.rs}`、`src/services/editor/lsp-bridge.ts`
- 问题：编辑器每次 debounce 后都把整份文档作为 `textDocument/didChange` 发送给
  bash-language-server。大脚本中只改一两个字符时仍需序列化、IPC、JSON 解析完整内容，
  热路径成本与文件大小线性相关。
- 算法：采用 LSP 标准的 range-based incremental sync。前端把单次 CodeMirror 事务的
  ChangeSet 转为 UTF-16 LSP range；后端新增 `LspContentChange`/`LspRange`/`LspPosition` 并在
  `lsp_did_change` 中优先透传 `contentChanges`。如果 debounce 窗口内合并了多次事务，
  为避免跨事务 range 重映射复杂度，安全退回 full sync。
- 复杂度（设文件大小 n、改动片段总长 d）：
  - 之前：每次变更 O(n) 传输与解析。
  - 之后：单事务主路径 O(d) 传输与解析；多事务合并/异常场景保持 O(n) fallback。
- 正确性：LSP 初始化已声明 `positionEncodings: ["utf-16"]`，CodeMirror 位置同为 UTF-16 offset；
  只在 range 基准明确的单事务内启用增量，多事务合并退回 full sync，避免错位。
- 验证：建议本机执行 `pnpm test src/services/editor/lsp-bridge.spec.ts`（若存在）、`pnpm typecheck`、
  `cd src-tauri && cargo test lsp`、`cargo clippy`。

## 结构化搜索的文件级并行 AST 匹配

- 文件：`src-tauri/src/commands/search/find.rs`
- 问题：`search_structural_contents` 逐文件串行执行“读盘 → 解码 → ast-grep Bash AST 构建 → pattern 匹配”。
  结构化搜索是 CPU 型路径，大仓库内候选 shell 文件多时无法利用多核。
- 算法：按文件粒度并行。用 `par_iter().enumerate()` 过滤 shell-like 文件后并行执行单文件 AST
  匹配；每个文件局部最多收集 `limit` 条结果；最后按原文件 index 排序归并并截断到全局 limit。
- 复杂度（设 shell 文件数 F、单文件 AST 成本 c、核数 P）：
  - 之前：O(F·c) 串行墙钟。
  - 之后：O(F·c / P) 并行墙钟（总工作量不变，受 IO 与调度开销约束）。
- 正确性：最终仍按原扫描文件顺序归并并截断，结果顺序和 limit 截断点稳定；每个 worker 只写本地
  Vec，无共享可变状态。
- 验证：`cargo test -p calamex commands::search`、`cargo clippy`、`cargo test`；本机用结构化搜索大仓库对比墙钟耗时。

## 工作区 watcher 事件 HashMap 合并

- 文件：`src-tauri/src/commands/workspace_watcher.rs`
- 问题：去抖窗口内的原始 notify 事件会先展开成 `Vec<FsChange>`，再对所有变更做全量
  `sort_by + dedup_by`。构建、依赖安装、git 操作等事件风暴中，重复路径很多，对原始事件数 n
  做 O(n log n) 排序浪费明显。
- 算法：哈希表在线合并。展开事件时直接用 `HashMap<path, kind>` 聚合同一路径，只保留 severity
  最高的 kind（Removed > Renamed > Created > Modified），最后仅对唯一路径数 u 排序输出，保证前端事件稳定。
- 复杂度：
  - 之前：O(n log n) 时间 + O(n) 临时结果。
  - 之后：O(n + u log u) 时间 + O(u) 聚合结果；当重复路径多时 u ≪ n。
- 正确性：severity 规则保持不变；最终仍按 path 排序。新增单测覆盖同一路径多事件时保留最高 severity、
  多路径输出按 path 稳定排序。
- 验证：`cargo test -p calamex workspace_watcher`、`cargo clippy`、`cargo test`。

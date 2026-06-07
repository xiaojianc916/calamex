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

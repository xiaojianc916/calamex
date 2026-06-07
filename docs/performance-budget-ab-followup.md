# A/B 算法优化跟进

本文件记录 2026-06-07 针对 A/B 批次中低风险高收益路径的落地项。主性能预算仍见 `docs/performance-budget.md`。

## 内容模糊搜索预过滤

- 文件：`src-tauri/src/commands/search/find.rs`
- 问题：内容模糊搜索会对每个非空行都进入 `nucleo` 子序列匹配。该 matcher 本身是合理选择，但大量明显不可能命中的行仍会消耗 CPU。
- 算法：在 nucleo 前增加必要条件预过滤：
  - 候选行字符数必须至少覆盖 query 的非空白字符数；
  - query 中出现过的 ASCII 字母/数字必须也出现在候选行中；
  - 非 ASCII 字符不参与预过滤，避免因 Unicode 规范化差异造成误杀。
- 复杂度：
  - 之前：每个非空行都进入 nucleo，单行主成本约 O(m)。
  - 之后：明显不可能命中的行只做一次轻量字节扫描；真正可能命中的行仍由 nucleo 判定，正确性不变。
- 正确性：预过滤只使用“必要条件”，不会替代 nucleo 排序/匹配。新增单测覆盖缺失必要字符、大小写敏感、非 ASCII 安全退让。
- 验证：`cargo test -p calamex commands::search::find`、`cargo clippy`、`cargo test`。

## 替换预览 diff 预算

- 文件：`src-tauri/src/commands/search/replace.rs`
- 问题：替换预览已按文件并行生成，但单个超大文件或超多替换仍可能在完整 diff 构造上消耗过多时间/内存。预览 UI 已有 line previews，完整 diff 不应成为热路径瓶颈。
- 算法：为 diff 构造增加预算：
  - `before + after` 超过 512 KiB 时省略完整 diff；
  - 单文件替换次数超过 2000 时省略完整 diff；
  - 仍保留行级预览、替换数量、before/after hash 与实际 edits，应用替换逻辑不依赖完整 diff。
- 复杂度：
  - 之前：极端情况下仍尝试构造完整 diff，成本随输入规模增长。
  - 之后：超预算文件在 O(1) 判定后返回说明性 diff，占用固定小内存；正常小文件仍走原 diff。
- 正确性：只影响预览展示中的完整 diff，不改变替换编辑收集、hash、line previews 与最终应用逻辑。新增单测覆盖小输入保留 diff、大输入/超多编辑省略 diff。
- 验证：`cargo test -p calamex commands::search::replace`、`cargo clippy`、`cargo test`。

## 暂缓项说明

- 搜索文件索引的事件驱动增量更新、符号级 mtime/hash 增量 AST 缓存、Shiki Worker 化、终端隐藏输出有界 backlog 均属于影响面更大的改动，应在本批低风险补丁验证后继续拆小提交推进。
- 当前提交先落地 B2/B3 类低风险优化，避免一次性改动搜索缓存、终端会话和 Worker 生命周期导致回归面过大。
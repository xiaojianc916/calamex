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

## pickFromPool：空态建议的随机抽取

- 文件：`src/composables/ai/useCopilotSuggestions.ts`
- 问题：每次展示空态建议都要从 90 条静态池里随机挑 9 条。原实现每次都重新 trim/去重整池，
  再做一次覆盖全量的 Fisher–Yates 洗牌（即便只取前 9 条）。
- 算法：静态池去重结果模块级预计算一次复用；抽取改用「部分 Fisher–Yates」，
  只洗前 k 个位置（k = 展示数），统计上等价于完整洗牌后取前 k 个。
- 复杂度：
  - 之前：每次 O(n) 去重 + O(n) 洗牌（n=池大小，静态池 n=90）。
  - 之后：静态池去重一次性 O(n)；单次抽取 O(k)（k=9），动态池仍需一次 O(n) 去重。
- 正确性：仍是无放回均匀抽样；新增单测覆盖数量上界、互不相同、去重去空白、空池与小池。
- 验证：`pnpm test src/composables/ai/useCopilotSuggestions.spec.ts`、`pnpm typecheck`、`pnpm lint`。

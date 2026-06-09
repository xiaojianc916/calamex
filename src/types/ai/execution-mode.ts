/**
 * AI 执行模式(执行自主性)的单一事实源。
 *
 * 与 chat/agent/plan 的「面板模式」(assistant-mode.ts)正交:面板模式决定交互形态,
 * 执行模式只决定计划被批准后「怎么跑」。
 *
 * - interactive(默认):每一步执行前都回到用户手里(门控审批 + 顺序单步执行),
 *   不自动校验、不自动重规划。对标 Cline 的 Plan/Act 默认手动、Cursor 关闭
 *   Auto-run 时的逐步确认。
 * - autonomous:开启「自主 plan 模式」,计划批准后进入「执行 → 校验 → 按需重规划」
 *   的无人值守闭环。对标 Cline Auto-approve、Cursor Auto-run、Claude Code 的
 *   auto-accept。
 *
 * 其余各层(UI / store / sidecar 编排)一律从此导入,避免同一词表被手抄多份产生漂移。
 */
export const AI_EXECUTION_MODES = ['interactive', 'autonomous'] as const;

export type TAiExecutionMode = (typeof AI_EXECUTION_MODES)[number];

/** 默认执行模式:逐步门控、需用户确认(轻量、安全优先)。 */
export const AI_EXECUTION_MODE_DEFAULT: TAiExecutionMode = 'interactive';

export const isAiExecutionMode = (value: unknown): value is TAiExecutionMode =>
  typeof value === 'string' && (AI_EXECUTION_MODES as readonly string[]).includes(value);

/**
 * 高精度时间戳辅助（performance.now 优先，回退 Date.now）。
 * 统一 runtime-diagnostics.ts、startup-profiler.ts 等处的 performance 检测逻辑。
 */

export const performanceMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

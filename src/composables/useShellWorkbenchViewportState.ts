import { useResizeObserver } from '@vueuse/core';
import { computed, type Ref, ref } from 'vue';

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

interface IDiagnosticsPanelBreakpoint {
  minViewportWidth: number;
  ratio: number;
  minWidth: number;
  softMaxWidth: number;
}

/**
 * 兜底断点（minViewportWidth 为 0，任何非负 viewport 宽度都能命中）。
 * 单独抽出以便 resolveDiagnosticsPanelSizeStrategy 在 find 落空时安全回退，
 * 无需对数组末项做非空断言。
 */
const DIAGNOSTICS_PANEL_FALLBACK_BREAKPOINT: IDiagnosticsPanelBreakpoint = {
  minViewportWidth: 0,
  ratio: 0.46,
  minWidth: 180,
  softMaxWidth: 320,
};

/**
 * 诊断面板宽度断点表（从大到小排列）。
 *
 * - `minViewportWidth`：触发该策略所需的最小 viewport 宽度（含等号）。
 * - `ratio`：以 viewport 宽度为基准的首选比例。
 * - `minWidth` / `softMaxWidth`：clamp 区间下/上限（与 hardMaxWidth 共同决定）。
 *
 * 修改断点：直接编辑此数组即可，无需改动下方的解析逻辑。
 * 末项为 DIAGNOSTICS_PANEL_FALLBACK_BREAKPOINT，保证任何非负宽度都有命中项。
 */
const DIAGNOSTICS_PANEL_BREAKPOINTS: ReadonlyArray<IDiagnosticsPanelBreakpoint> = [
  { minViewportWidth: 1680, ratio: 0.28, minWidth: 320, softMaxWidth: 460 },
  { minViewportWidth: 1440, ratio: 0.3, minWidth: 300, softMaxWidth: 440 },
  { minViewportWidth: 1200, ratio: 0.32, minWidth: 280, softMaxWidth: 420 },
  { minViewportWidth: 960, ratio: 0.34, minWidth: 260, softMaxWidth: 400 },
  { minViewportWidth: 760, ratio: 0.38, minWidth: 220, softMaxWidth: 360 },
  DIAGNOSTICS_PANEL_FALLBACK_BREAKPOINT,
];

const resolveDiagnosticsPanelSizeStrategy = (
  normalizedWidth: number,
): IDiagnosticsPanelBreakpoint =>
  // 断点表已按 minViewportWidth 从大到小排序，find 命中即用；
  // 任何非负宽度至少命中兜底断点（minViewportWidth: 0）。
  DIAGNOSTICS_PANEL_BREAKPOINTS.find((bp) => normalizedWidth >= bp.minViewportWidth) ??
  DIAGNOSTICS_PANEL_FALLBACK_BREAKPOINT;

const resolveDiagnosticsPanelWidth = (availableWidth: number): number => {
  const normalizedWidth = Math.max(0, Math.round(availableWidth));
  if (normalizedWidth <= 0) return 0;

  const inset = normalizedWidth >= 960 ? 24 : 16;
  const hardMaxWidth = Math.max(0, normalizedWidth - inset);
  if (hardMaxWidth <= 0) return normalizedWidth;

  const strategy = resolveDiagnosticsPanelSizeStrategy(normalizedWidth);
  const resolvedMaxWidth = Math.min(hardMaxWidth, strategy.softMaxWidth);
  const resolvedMinWidth = Math.min(strategy.minWidth, resolvedMaxWidth);
  const preferredWidth = Math.round(normalizedWidth * strategy.ratio);
  return clampNumber(preferredWidth, resolvedMinWidth, resolvedMaxWidth);
};

interface IUseShellWorkbenchViewportStateOptions {
  editorViewportRef: Ref<HTMLElement | null>;
}

export const useShellWorkbenchViewportState = (options: IUseShellWorkbenchViewportStateOptions) => {
  const editorViewportWidth = ref(0);
  const diagnosticsTransitionsEnabled = ref(true);

  let diagnosticsResizeSettleTimerId: number | null = null;
  let editorViewportResizeFrameId: number | null = null;
  let previousEditorViewportSize = { width: 0, height: 0 };
  let pendingEditorViewportSize: { width: number; height: number } | null = null;
  let isShellWindowResizing = false;

  // useResizeObserver 的 stop 句柄；mount() 后写入，cleanup() 时显式调用。
  let stopEditorViewportResizeObserver: (() => void) | null = null;
  // mount 重入守卫，避免重复注册 ResizeObserver 造成泄漏。
  let mounted = false;

  const diagnosticsPanelMotionClass = computed(() =>
    diagnosticsTransitionsEnabled.value
      ? 'transition-[opacity,transform,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
      : 'transition-none',
  );

  const diagnosticsPanelStyle = computed(() => {
    const availableWidth = editorViewportWidth.value;
    if (availableWidth <= 0) return undefined;
    const resolvedWidth = resolveDiagnosticsPanelWidth(availableWidth);
    return {
      width: `${resolvedWidth}px`,
      maxWidth: '100%',
    };
  });

  const scheduleDiagnosticsTransitionRestore = (): void => {
    if (diagnosticsResizeSettleTimerId !== null) {
      window.clearTimeout(diagnosticsResizeSettleTimerId);
    }
    diagnosticsResizeSettleTimerId = window.setTimeout(() => {
      diagnosticsTransitionsEnabled.value = true;
      diagnosticsResizeSettleTimerId = null;
    }, 140);
  };

  const handleEditorViewportResize = (width: number, height: number): void => {
    const normalizedWidth = Math.round(width);
    const normalizedHeight = Math.round(height);
    if (normalizedWidth <= 0 || normalizedHeight <= 0) return;

    if (editorViewportWidth.value !== normalizedWidth) {
      editorViewportWidth.value = normalizedWidth;
    }

    if (
      previousEditorViewportSize.width === normalizedWidth &&
      previousEditorViewportSize.height === normalizedHeight
    ) {
      return;
    }
    previousEditorViewportSize = { width: normalizedWidth, height: normalizedHeight };
    diagnosticsTransitionsEnabled.value = false;
    scheduleDiagnosticsTransitionRestore();
  };

  const flushEditorViewportResize = (): void => {
    editorViewportResizeFrameId = null;
    if (!pendingEditorViewportSize) return;
    const { width, height } = pendingEditorViewportSize;
    pendingEditorViewportSize = null;
    handleEditorViewportResize(width, height);
  };

  const queueEditorViewportResize = (width: number, height: number): void => {
    pendingEditorViewportSize = {
      width: Math.round(width),
      height: Math.round(height),
    };
    if (isShellWindowResizing) return;
    if (editorViewportResizeFrameId !== null) return;
    editorViewportResizeFrameId = window.requestAnimationFrame(flushEditorViewportResize);
  };

  const captureCurrentViewportSize = (): { width: number; height: number } | null => {
    const el = options.editorViewportRef.value;
    if (!el) return null;
    return {
      width: Math.round(el.clientWidth),
      height: Math.round(el.clientHeight),
    };
  };

  const handleShellWindowResizeStart = (): void => {
    isShellWindowResizing = true;
    diagnosticsTransitionsEnabled.value = false;
    if (diagnosticsResizeSettleTimerId !== null) {
      window.clearTimeout(diagnosticsResizeSettleTimerId);
      diagnosticsResizeSettleTimerId = null;
    }
  };

  const handleShellWindowResizeEnd = (): void => {
    const snapshot = captureCurrentViewportSize();
    if (snapshot) {
      pendingEditorViewportSize = snapshot;
    }
  };

  const handleShellWindowResizeSettled = (): void => {
    isShellWindowResizing = false;
    if (editorViewportResizeFrameId !== null) {
      window.cancelAnimationFrame(editorViewportResizeFrameId);
      editorViewportResizeFrameId = null;
    }
    const snapshot = captureCurrentViewportSize();
    if (snapshot) {
      pendingEditorViewportSize = snapshot;
    }
    flushEditorViewportResize();
    scheduleDiagnosticsTransitionRestore();
  };

  const mount = (): void => {
    if (mounted) return;
    mounted = true;

    const snapshot = captureCurrentViewportSize();
    if (snapshot) {
      // 与 handleEditorViewportResize 的判定保持同口径（均为 round 后值），
      // 避免首次 ResizeObserver 触发因小数差异被误判为"尺寸变化"。
      previousEditorViewportSize = snapshot;
      editorViewportWidth.value = snapshot.width;
    }

    const { stop } = useResizeObserver(options.editorViewportRef, (entries) => {
      const targetEntry = entries[0];
      if (!targetEntry) return;
      queueEditorViewportResize(targetEntry.contentRect.width, targetEntry.contentRect.height);
    });
    stopEditorViewportResizeObserver = stop;
  };

  const cleanup = (): void => {
    if (stopEditorViewportResizeObserver) {
      stopEditorViewportResizeObserver();
      stopEditorViewportResizeObserver = null;
    }
    if (editorViewportResizeFrameId !== null) {
      window.cancelAnimationFrame(editorViewportResizeFrameId);
      editorViewportResizeFrameId = null;
    }
    if (diagnosticsResizeSettleTimerId !== null) {
      window.clearTimeout(diagnosticsResizeSettleTimerId);
      diagnosticsResizeSettleTimerId = null;
    }
    mounted = false;
  };

  return {
    editorViewportWidth,
    diagnosticsTransitionsEnabled,
    diagnosticsPanelMotionClass,
    diagnosticsPanelStyle,
    handleShellWindowResizeStart,
    handleShellWindowResizeEnd,
    handleShellWindowResizeSettled,
    mount,
    cleanup,
  };
};

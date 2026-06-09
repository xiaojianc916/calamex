type TTooltipPlacement = 'top' | 'bottom' | 'left' | 'right';
type TTooltipActivationSource = 'pointer' | 'focus';

const TOOLTIP_SELECTOR = '.app-tooltip-target[data-tooltip]';
const VIEWPORT_PADDING = 12;
const TOOLTIP_GAP = 10;
const MULTILINE_THRESHOLD_WIDTH = 420;
const POINTER_TOOLTIP_DELAY_MS = 3000;
const POINTER_WATCHDOG_INTERVAL_MS = 80;

// 原生 CSS 锚点定位（CSS Anchor Positioning）用到的名称与方位映射。
// 仅在环境支持时启用；不支持时回退到下方的手动定位逻辑。
const TOOLTIP_ANCHOR_NAME = '--app-tooltip-anchor';

const POSITION_AREA_BY_PLACEMENT: Record<TTooltipPlacement, string> = {
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right',
};

// position-try-fallbacks：越界时让浏览器自动翻转到对侧 / 垂直方向，等价于原本的候选方位打分。
const POSITION_TRY_FALLBACKS_BY_PLACEMENT: Record<TTooltipPlacement, string> = {
  top: 'flip-block, flip-inline',
  bottom: 'flip-block, flip-inline',
  left: 'flip-inline, flip-block',
  right: 'flip-inline, flip-block',
};

declare global {
  interface Window {
    __SH_APP_TOOLTIP_CLEANUP__?: (() => void) | undefined;
  }
}

// 检测是否支持原生 CSS 锚点定位。WKWebView / 较旧 webview 不支持时返回 false，
// 由调用方回退到原有的手动坐标计算 + 滚动 / 缩放跟踪逻辑。
const supportsCssAnchorPositioning = (): boolean => {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
    return false;
  }

  return (
    CSS.supports('anchor-name', TOOLTIP_ANCHOR_NAME) &&
    CSS.supports('position-anchor', TOOLTIP_ANCHOR_NAME) &&
    CSS.supports('position-area', 'top')
  );
};

const disposeAppTooltipSystem = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const cleanup = window.__SH_APP_TOOLTIP_CLEANUP__;
  if (!cleanup) {
    return;
  }

  cleanup();
  if (window.__SH_APP_TOOLTIP_CLEANUP__ === cleanup) {
    window.__SH_APP_TOOLTIP_CLEANUP__ = undefined;
  }
};

const getPlacementCandidates = (preferredPlacement: TTooltipPlacement): TTooltipPlacement[] => {
  switch (preferredPlacement) {
    case 'bottom':
      return ['bottom', 'top', 'right', 'left'];
    case 'left':
      return ['left', 'right', 'top', 'bottom'];
    case 'right':
      return ['right', 'left', 'top', 'bottom'];
    default:
      return ['top', 'bottom', 'right', 'left'];
  }
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const ensureTooltipElement = (): HTMLDivElement => {
  const existing = document.querySelector<HTMLDivElement>('#app-global-tooltip');
  if (existing) {
    return existing;
  }

  const tooltipElement = document.createElement('div');
  tooltipElement.id = 'app-global-tooltip';
  tooltipElement.className = 'app-global-tooltip';
  document.body.appendChild(tooltipElement);
  return tooltipElement;
};

const resolveTooltipPlacement = (value: string | null | undefined): TTooltipPlacement => {
  if (value === 'bottom' || value === 'left' || value === 'right') {
    return value;
  }

  return 'top';
};

const measureTooltip = (
  tooltipElement: HTMLDivElement,
  text: string,
): { width: number; height: number } => {
  const maxWidth = Math.min(MULTILINE_THRESHOLD_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2);

  tooltipElement.textContent = text;
  tooltipElement.style.left = '-9999px';
  tooltipElement.style.top = '-9999px';
  tooltipElement.style.maxWidth = `${maxWidth}px`;
  tooltipElement.classList.remove(
    'is-visible',
    'is-top',
    'is-bottom',
    'is-left',
    'is-right',
    'is-multiline',
  );

  const nowrapWidth = tooltipElement.offsetWidth;
  if (nowrapWidth > maxWidth) {
    tooltipElement.classList.add('is-multiline');
  }

  return {
    width: tooltipElement.offsetWidth,
    height: tooltipElement.offsetHeight,
  };
};

const resolveTooltipPosition = (
  targetRect: DOMRect,
  tooltipWidth: number,
  tooltipHeight: number,
  placement: TTooltipPlacement,
): { left: number; top: number } => {
  const minLeft = VIEWPORT_PADDING;
  const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - tooltipWidth - VIEWPORT_PADDING);
  const minTop = VIEWPORT_PADDING;
  const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - tooltipHeight - VIEWPORT_PADDING);

  switch (placement) {
    case 'bottom':
      return {
        left: clamp(targetRect.left + (targetRect.width - tooltipWidth) / 2, minLeft, maxLeft),
        top: clamp(targetRect.bottom + TOOLTIP_GAP, minTop, maxTop),
      };
    case 'left':
      return {
        left: clamp(targetRect.left - tooltipWidth - TOOLTIP_GAP, minLeft, maxLeft),
        top: clamp(targetRect.top + (targetRect.height - tooltipHeight) / 2, minTop, maxTop),
      };
    case 'right':
      return {
        left: clamp(targetRect.right + TOOLTIP_GAP, minLeft, maxLeft),
        top: clamp(targetRect.top + (targetRect.height - tooltipHeight) / 2, minTop, maxTop),
      };
    default:
      return {
        left: clamp(targetRect.left + (targetRect.width - tooltipWidth) / 2, minLeft, maxLeft),
        top: clamp(targetRect.top - tooltipHeight - TOOLTIP_GAP, minTop, maxTop),
      };
  }
};

const resolveOverflowScore = (
  position: { left: number; top: number },
  tooltipWidth: number,
  tooltipHeight: number,
): number => {
  const overflowLeft = Math.max(0, VIEWPORT_PADDING - position.left);
  const overflowTop = Math.max(0, VIEWPORT_PADDING - position.top);
  const overflowRight = Math.max(
    0,
    position.left + tooltipWidth + VIEWPORT_PADDING - window.innerWidth,
  );
  const overflowBottom = Math.max(
    0,
    position.top + tooltipHeight + VIEWPORT_PADDING - window.innerHeight,
  );

  return overflowLeft + overflowTop + overflowRight + overflowBottom;
};

export const initAppTooltipSystem = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  disposeAppTooltipSystem();

  const tooltipElement = ensureTooltipElement();
  // 一次性探测环境能力：支持则走原生锚点定位，否则走手动定位回退。
  const useCssAnchorPositioning = supportsCssAnchorPositioning();
  let activeTarget: HTMLElement | null = null;
  let activeSource: TTooltipActivationSource | null = null;
  let pendingTarget: HTMLElement | null = null;
  // 原生锚点定位下当前被赋予 anchor-name 的目标，隐藏时需清理。
  let anchoredTarget: HTMLElement | null = null;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let hasPointerPosition = false;
  let pendingShowTimeoutId: number | null = null;
  let pointerWatchdogId: number | null = null;
  let isPointerTracking = false;
  let isViewportTracking = false;

  const clearPendingTooltip = (): void => {
    if (pendingShowTimeoutId !== null) {
      window.clearTimeout(pendingShowTimeoutId);
      pendingShowTimeoutId = null;
    }

    pendingTarget = null;
  };

  const stopPointerWatchdog = (): void => {
    if (pointerWatchdogId !== null) {
      window.clearInterval(pointerWatchdogId);
      pointerWatchdogId = null;
    }
  };

  const updatePointerPosition = (clientX: number, clientY: number): void => {
    lastPointerX = clientX;
    lastPointerY = clientY;
    hasPointerPosition = true;
  };

  const clearPointerPosition = (): void => {
    hasPointerPosition = false;
  };

  const startPointerTracking = (): void => {
    if (isPointerTracking) {
      return;
    }

    document.addEventListener('pointermove', handlePointerMove, true);
    isPointerTracking = true;
  };

  const stopPointerTracking = (): void => {
    if (!isPointerTracking) {
      return;
    }

    document.removeEventListener('pointermove', handlePointerMove, true);
    isPointerTracking = false;
  };

  const startViewportTracking = (): void => {
    if (isViewportTracking) {
      return;
    }

    document.addEventListener('scroll', syncTooltipPosition, true);
    window.addEventListener('resize', syncTooltipPosition);
    isViewportTracking = true;
  };

  const stopViewportTracking = (): void => {
    if (!isViewportTracking) {
      return;
    }

    document.removeEventListener('scroll', syncTooltipPosition, true);
    window.removeEventListener('resize', syncTooltipPosition);
    isViewportTracking = false;
  };

  const isPointerOverTarget = (target: HTMLElement | null): boolean => {
    if (!target || !hasPointerPosition || !document.body.contains(target)) {
      return false;
    }

    const maxClientX = Math.max(0, window.innerWidth - 1);
    const maxClientY = Math.max(0, window.innerHeight - 1);
    const hitTarget = document.elementFromPoint(
      clamp(Math.round(lastPointerX), 0, maxClientX),
      clamp(Math.round(lastPointerY), 0, maxClientY),
    );

    return hitTarget instanceof Element
      ? hitTarget === target || target.contains(hitTarget)
      : false;
  };

  const ensurePointerWatchdog = (): void => {
    if (pointerWatchdogId !== null || !activeTarget) {
      return;
    }

    pointerWatchdogId = window.setInterval(() => {
      if (!activeTarget) {
        stopPointerWatchdog();
        return;
      }

      if (!document.body.contains(activeTarget)) {
        hideTooltip();
        return;
      }

      if (
        activeSource === 'pointer' &&
        (!hasPointerPosition || !isPointerOverTarget(activeTarget))
      ) {
        hideTooltip();
      }
    }, POINTER_WATCHDOG_INTERVAL_MS);
  };

  // 清理原生锚点定位遗留的内联样式：移除目标上的 anchor-name 与提示框上的 position-* 属性。
  const clearTooltipAnchor = (): void => {
    if (anchoredTarget) {
      anchoredTarget.style.removeProperty('anchor-name');
      anchoredTarget = null;
    }

    tooltipElement.style.removeProperty('position-anchor');
    tooltipElement.style.removeProperty('position-area');
    tooltipElement.style.removeProperty('position-try-fallbacks');
  };

  const hideTooltip = (): void => {
    clearPendingTooltip();
    activeTarget = null;
    activeSource = null;
    stopPointerWatchdog();
    stopPointerTracking();
    stopViewportTracking();
    clearTooltipAnchor();
    tooltipElement.classList.remove(
      'is-visible',
      'is-top',
      'is-bottom',
      'is-left',
      'is-right',
      'is-multiline',
    );
    tooltipElement.style.left = '-9999px';
    tooltipElement.style.top = '-9999px';
    tooltipElement.textContent = '';
  };

  // 手动定位回退：沿用原有的候选方位越界打分 + 滚动 / 缩放跟踪。
  const applyManualPositioning = (
    target: HTMLElement,
    width: number,
    height: number,
    preferredPlacement: TTooltipPlacement,
    lockPlacement: boolean,
  ): void => {
    const targetRect = target.getBoundingClientRect();
    const candidatePlacements = lockPlacement
      ? [preferredPlacement]
      : getPlacementCandidates(preferredPlacement);

    let resolvedPlacement = candidatePlacements[0];
    let resolvedPosition = resolveTooltipPosition(targetRect, width, height, resolvedPlacement);
    let bestOverflowScore = resolveOverflowScore(resolvedPosition, width, height);

    for (const placement of candidatePlacements) {
      const position = resolveTooltipPosition(targetRect, width, height, placement);
      const overflowScore = resolveOverflowScore(position, width, height);

      if (overflowScore < bestOverflowScore) {
        resolvedPlacement = placement;
        resolvedPosition = position;
        bestOverflowScore = overflowScore;
      }

      if (overflowScore === 0) {
        resolvedPlacement = placement;
        resolvedPosition = position;
        break;
      }
    }

    tooltipElement.classList.remove('is-top', 'is-bottom', 'is-left', 'is-right');
    tooltipElement.classList.add(`is-${resolvedPlacement}`, 'is-visible');
    tooltipElement.style.left = `${Math.round(resolvedPosition.left)}px`;
    tooltipElement.style.top = `${Math.round(resolvedPosition.top)}px`;
    startViewportTracking();
  };

  // 原生锚点定位：在目标上声明 anchor-name，提示框通过 position-anchor 关联，
  // position-area 选择方位，position-try-fallbacks 在越界时自动翻转。
  // 滚动 / 缩放时由浏览器原生跟踪锚点，无需手动重算坐标。
  const applyAnchorPositioning = (
    target: HTMLElement,
    placement: TTooltipPlacement,
    lockPlacement: boolean,
  ): void => {
    if (anchoredTarget && anchoredTarget !== target) {
      anchoredTarget.style.removeProperty('anchor-name');
    }
    anchoredTarget = target;
    target.style.setProperty('anchor-name', TOOLTIP_ANCHOR_NAME);

    // 交由锚点定位接管，清除手动定位的坐标。
    tooltipElement.style.left = '';
    tooltipElement.style.top = '';
    tooltipElement.style.setProperty('position-anchor', TOOLTIP_ANCHOR_NAME);
    tooltipElement.style.setProperty('position-area', POSITION_AREA_BY_PLACEMENT[placement]);
    tooltipElement.style.setProperty(
      'position-try-fallbacks',
      lockPlacement ? 'none' : POSITION_TRY_FALLBACKS_BY_PLACEMENT[placement],
    );

    tooltipElement.classList.remove('is-top', 'is-bottom', 'is-left', 'is-right');
    tooltipElement.classList.add(`is-${placement}`, 'is-visible');
  };

  const renderTooltip = (target: HTMLElement, source: TTooltipActivationSource): void => {
    const tooltipText = target.dataset.tooltip?.trim();
    if (!tooltipText) {
      hideTooltip();
      return;
    }

    activeTarget = target;
    activeSource = source;
    const preferredPlacement = resolveTooltipPlacement(target.dataset.tooltipPlacement);
    const lockPlacement = target.dataset.tooltipLockPlacement === 'true';
    const { width, height } = measureTooltip(tooltipElement, tooltipText);

    if (useCssAnchorPositioning) {
      applyAnchorPositioning(target, preferredPlacement, lockPlacement);
    } else {
      applyManualPositioning(target, width, height, preferredPlacement, lockPlacement);
    }

    if (source === 'pointer') {
      startPointerTracking();
      ensurePointerWatchdog();
    }
  };

  const schedulePointerTooltip = (target: HTMLElement): void => {
    if (activeTarget === target && activeSource === 'pointer') {
      return;
    }

    if (pendingTarget === target) {
      return;
    }

    hideTooltip();
    pendingTarget = target;
    startPointerTracking();
    startViewportTracking();
    pendingShowTimeoutId = window.setTimeout(() => {
      const nextTarget = pendingTarget;
      pendingShowTimeoutId = null;
      pendingTarget = null;

      if (!nextTarget || !isPointerOverTarget(nextTarget)) {
        return;
      }

      renderTooltip(nextTarget, 'pointer');
    }, POINTER_TOOLTIP_DELAY_MS);
  };

  const syncTooltipPosition = (): void => {
    if (!pendingTarget && !activeTarget) {
      return;
    }

    if (pendingTarget && !document.body.contains(pendingTarget)) {
      hideTooltip();
      return;
    }

    if (!activeTarget || !document.body.contains(activeTarget)) {
      hideTooltip();
      return;
    }

    renderTooltip(activeTarget, activeSource ?? 'pointer');
  };

  const handlePointerMove = (event: PointerEvent): void => {
    updatePointerPosition(event.clientX, event.clientY);
  };

  const handlePointerOver = (event: PointerEvent): void => {
    updatePointerPosition(event.clientX, event.clientY);

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const tooltipTarget = target.closest<HTMLElement>(TOOLTIP_SELECTOR);
    if (!tooltipTarget) {
      return;
    }

    if (tooltipTarget === activeTarget) {
      return;
    }

    if (tooltipTarget === pendingTarget) {
      return;
    }

    schedulePointerTooltip(tooltipTarget);
  };

  const handlePointerOut = (event: PointerEvent): void => {
    const trackedTarget = activeTarget ?? pendingTarget;
    if (!trackedTarget) {
      return;
    }

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && trackedTarget.contains(relatedTarget)) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Node) || !trackedTarget.contains(target)) {
      return;
    }

    hideTooltip();
  };

  const handleFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const tooltipTarget = target.closest<HTMLElement>(TOOLTIP_SELECTOR);
    if (tooltipTarget) {
      renderTooltip(tooltipTarget, 'focus');
    }
  };

  const handleFocusOut = (event: FocusEvent): void => {
    if (!activeTarget) {
      return;
    }

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && activeTarget.contains(relatedTarget)) {
      return;
    }

    hideTooltip();
  };

  const handlePointerDown = (): void => hideTooltip();

  const handleDocumentMouseLeave = (): void => {
    clearPointerPosition();
    hideTooltip();
  };

  const handleWindowBlur = (): void => {
    clearPointerPosition();
    hideTooltip();
  };

  const handleVisibilityChange = (): void => {
    if (document.hidden) {
      clearPointerPosition();
      hideTooltip();
    }
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      hideTooltip();
    }
  };

  document.addEventListener('pointerover', handlePointerOver);
  document.addEventListener('pointerout', handlePointerOut);
  document.addEventListener('focusin', handleFocusIn);
  document.addEventListener('focusout', handleFocusOut);
  document.addEventListener('pointerdown', handlePointerDown, true);
  document.documentElement.addEventListener('mouseleave', handleDocumentMouseLeave);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('blur', handleWindowBlur);
  window.addEventListener('keydown', handleKeyDown);

  const cleanup = (): void => {
    stopPointerTracking();
    document.removeEventListener('pointerover', handlePointerOver);
    document.removeEventListener('pointerout', handlePointerOut);
    document.removeEventListener('focusin', handleFocusIn);
    document.removeEventListener('focusout', handleFocusOut);
    document.removeEventListener('pointerdown', handlePointerDown, true);
    document.documentElement.removeEventListener('mouseleave', handleDocumentMouseLeave);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    stopViewportTracking();
    window.removeEventListener('blur', handleWindowBlur);
    window.removeEventListener('keydown', handleKeyDown);
    hideTooltip();
  };

  window.__SH_APP_TOOLTIP_CLEANUP__ = cleanup;
};

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeAppTooltipSystem();
  });
}

type TTooltipPlacement = 'top' | 'bottom' | 'left' | 'right';
type TTooltipActivationSource = 'pointer' | 'focus';

const TOOLTIP_SELECTOR = '.app-tooltip-target[data-tooltip]';
const VIEWPORT_PADDING = 12;
const TOOLTIP_GAP = 10;
const MULTILINE_THRESHOLD_WIDTH = 420;
const POINTER_TOOLTIP_DELAY_MS = 3000;
const POINTER_WATCHDOG_INTERVAL_MS = 80;

// 原生 CSS 锚点定位（CSS Anchor Positioning）用到的锚点名与方位映射。
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

// 填充提示文本、限制最大宽度并判定是否多行（在屏外测量，避免闪烁）。
// 具体位置交由原生 CSS 锚点定位计算，此处不再手算坐标。
const prepareTooltipContent = (tooltipElement: HTMLDivElement, text: string): void => {
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
};

export const initAppTooltipSystem = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  disposeAppTooltipSystem();

  const tooltipElement = ensureTooltipElement();
  let activeTarget: HTMLElement | null = null;
  let activeSource: TTooltipActivationSource | null = null;
  let pendingTarget: HTMLElement | null = null;
  // 当前被赋予 anchor-name 的目标元素，隐藏时需清理。
  let anchoredTarget: HTMLElement | null = null;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let hasPointerPosition = false;
  let pendingShowTimeoutId: number | null = null;
  let pointerWatchdogId: number | null = null;
  let isPointerTracking = false;

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

  // 清理锚点定位遗留的内联样式：移除目标上的 anchor-name 与提示框上的 position-* / margin。
  const clearTooltipAnchor = (): void => {
    if (anchoredTarget) {
      anchoredTarget.style.removeProperty('anchor-name');
      anchoredTarget = null;
    }

    tooltipElement.style.removeProperty('position-anchor');
    tooltipElement.style.removeProperty('position-area');
    tooltipElement.style.removeProperty('position-try-fallbacks');
    tooltipElement.style.removeProperty('margin');
  };

  const hideTooltip = (): void => {
    clearPendingTooltip();
    activeTarget = null;
    activeSource = null;
    stopPointerWatchdog();
    stopPointerTracking();
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

  // 原生锚点定位：在目标上声明 anchor-name，提示框通过 position-anchor 关联，
  // position-area 选择方位，position-try-fallbacks 在越界时自动翻转；滚动 / 缩放由
  // 浏览器原生跟踪锚点，无需 JS 重算坐标或监听滚动。
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

    // 覆盖 CSS 中作为隐藏停靠位的 left/top: -9999px，否则显式 inset 会压过 position-area。
    tooltipElement.style.left = 'auto';
    tooltipElement.style.top = 'auto';
    // 用对称外边距重建原有的间隙：对称 margin 在 flip 翻转后仍能保证朝锐点一侧留白。
    tooltipElement.style.margin = `${TOOLTIP_GAP}px`;
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
    const placement = resolveTooltipPlacement(target.dataset.tooltipPlacement);
    const lockPlacement = target.dataset.tooltipLockPlacement === 'true';
    prepareTooltipContent(tooltipElement, tooltipText);
    applyAnchorPositioning(target, placement, lockPlacement);

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

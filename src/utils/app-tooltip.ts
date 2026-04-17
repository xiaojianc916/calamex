type TTooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

const TOOLTIP_SELECTOR = '.app-tooltip-target[data-tooltip]';
const VIEWPORT_PADDING = 12;
const TOOLTIP_GAP = 10;
const MULTILINE_THRESHOLD_WIDTH = 420;

let cleanupTooltipSystem: (() => void) | null = null;

const getPlacementCandidates = (preferredPlacement: TTooltipPlacement): TTooltipPlacement[] => {
  switch (preferredPlacement) {
    case 'bottom':
      return ['bottom', 'top', 'right', 'left'];
    case 'left':
      return ['left', 'right', 'top', 'bottom'];
    case 'right':
      return ['right', 'left', 'top', 'bottom'];
    case 'top':
    default:
      return ['top', 'bottom', 'right', 'left'];
  }
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

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
  tooltipElement.classList.remove('is-visible', 'is-top', 'is-bottom', 'is-left', 'is-right', 'is-multiline');

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
    case 'top':
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
  if (typeof window === 'undefined' || cleanupTooltipSystem) {
    return;
  }

  const tooltipElement = ensureTooltipElement();
  let activeTarget: HTMLElement | null = null;

  const hideTooltip = (): void => {
    activeTarget = null;
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

  const showTooltip = (target: HTMLElement): void => {
    const tooltipText = target.dataset.tooltip?.trim();
    if (!tooltipText) {
      hideTooltip();
      return;
    }

    activeTarget = target;
    const preferredPlacement = resolveTooltipPlacement(target.dataset.tooltipPlacement);
    const lockPlacement = target.dataset.tooltipLockPlacement === 'true';
    const { width, height } = measureTooltip(tooltipElement, tooltipText);
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
  };

  const syncTooltipPosition = (): void => {
    if (!activeTarget || !document.body.contains(activeTarget)) {
      hideTooltip();
      return;
    }

    showTooltip(activeTarget);
  };

  const handlePointerOver = (event: PointerEvent): void => {
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

    showTooltip(tooltipTarget);
  };

  const handlePointerOut = (event: PointerEvent): void => {
    if (!activeTarget) {
      return;
    }

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && activeTarget.contains(relatedTarget)) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Node) || !activeTarget.contains(target)) {
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
      showTooltip(tooltipTarget);
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
  document.addEventListener('scroll', syncTooltipPosition, true);
  window.addEventListener('resize', syncTooltipPosition);
  window.addEventListener('keydown', handleKeyDown);

  cleanupTooltipSystem = () => {
    document.removeEventListener('pointerover', handlePointerOver);
    document.removeEventListener('pointerout', handlePointerOut);
    document.removeEventListener('focusin', handleFocusIn);
    document.removeEventListener('focusout', handleFocusOut);
    document.removeEventListener('pointerdown', handlePointerDown, true);
    document.removeEventListener('scroll', syncTooltipPosition, true);
    window.removeEventListener('resize', syncTooltipPosition);
    window.removeEventListener('keydown', handleKeyDown);
    hideTooltip();
  };
};

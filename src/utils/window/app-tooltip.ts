export interface IAppTooltipSystem {
  dispose: () => void;
}

const TOOLTIP_DELAY_MS = 3000;
const TOOLTIP_ELEMENT_ID = 'app-global-tooltip';
const TOOLTIP_VISIBLE_CLASS = 'is-visible';
const TOOLTIP_CLEANUP_KEY = '__SH_APP_TOOLTIP_CLEANUP__';
const TOOLTIP_TARGET_SELECTOR = '[data-app-tooltip], [data-tooltip], [aria-label], [title]';
const TOOLTIP_TEXT_ATTRIBUTES = [
  'data-app-tooltip',
  'data-tooltip',
  'aria-label',
  'title',
] as const;

type TTooltipCleanupHost = Record<string, (() => void) | undefined>;

const resolveTooltipText = (target: Element): string => {
  for (const attr of TOOLTIP_TEXT_ATTRIBUTES) {
    const value = target.getAttribute(attr);
    if (value) return value;
  }
  return '';
};

export const initAppTooltipSystem = (): IAppTooltipSystem => {
  const tooltipElement = document.createElement('div');
  tooltipElement.id = TOOLTIP_ELEMENT_ID;
  tooltipElement.setAttribute('role', 'tooltip');
  tooltipElement.style.position = 'fixed';
  tooltipElement.style.pointerEvents = 'none';
  tooltipElement.style.zIndex = '9999';
  document.body.appendChild(tooltipElement);

  let hoverTarget: Element | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerMoveAttached = false;

  const clearHoverTimer = (): void => {
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  };

  const setPosition = (event: PointerEvent | MouseEvent): void => {
    tooltipElement.style.left = String(event.clientX + 10) + 'px';
    tooltipElement.style.top = String(event.clientY + 10) + 'px';
  };

  function handlePointerMove(event: PointerEvent): void {
    setPosition(event);
  }

  const attachPointerMove = (): void => {
    if (!pointerMoveAttached) {
      document.addEventListener('pointermove', handlePointerMove);
      pointerMoveAttached = true;
    }
  };

  const detachPointerMove = (): void => {
    if (pointerMoveAttached) {
      document.removeEventListener('pointermove', handlePointerMove);
      pointerMoveAttached = false;
    }
  };

  const show = (target: Element, event?: PointerEvent | MouseEvent): void => {
    const text = resolveTooltipText(target);
    if (!text) return;

    tooltipElement.textContent = text;
    tooltipElement.classList.add(TOOLTIP_VISIBLE_CLASS);

    if (event) {
      setPosition(event);
    }
  };

  const hide = (): void => {
    clearHoverTimer();
    hoverTarget = null;
    tooltipElement.classList.remove(TOOLTIP_VISIBLE_CLASS);
    tooltipElement.textContent = '';
    detachPointerMove();
  };

  const handlePointerOver = (event: PointerEvent): void => {
    const target =
      event.target instanceof Element ? event.target.closest(TOOLTIP_TARGET_SELECTOR) : null;
    if (!target) return;

    hoverTarget = target;
    attachPointerMove();
    setPosition(event);
    clearHoverTimer();
    hoverTimer = setTimeout(() => {
      if (hoverTarget === target) {
        show(target, event);
      }
    }, TOOLTIP_DELAY_MS);
  };

  const handlePointerOut = (): void => {
    hide();
  };

  const handleFocusIn = (event: FocusEvent): void => {
    const target =
      event.target instanceof Element ? event.target.closest(TOOLTIP_TARGET_SELECTOR) : null;
    if (!target) return;
    show(target);
  };

  const handleFocusOut = (): void => {
    hide();
  };

  document.addEventListener('pointerover', handlePointerOver);
  document.addEventListener('pointerout', handlePointerOut);
  document.addEventListener('focusin', handleFocusIn);
  document.addEventListener('focusout', handleFocusOut);

  const dispose = (): void => {
    hide();
    document.removeEventListener('pointerover', handlePointerOver);
    document.removeEventListener('pointerout', handlePointerOut);
    document.removeEventListener('focusin', handleFocusIn);
    document.removeEventListener('focusout', handleFocusOut);
    tooltipElement.remove();
    const host = globalThis as unknown as TTooltipCleanupHost;
    if (host[TOOLTIP_CLEANUP_KEY]) {
      host[TOOLTIP_CLEANUP_KEY] = undefined;
    }
  };

  (globalThis as unknown as TTooltipCleanupHost)[TOOLTIP_CLEANUP_KEY] = dispose;

  return { dispose };
};

export interface IAppTooltipSystem {
  dispose: () => void;
}

const TOOLTIP_DELAY_MS = 3000;
const TOOLTIP_TEXT_ATTRIBUTES = [
  'data-app-tooltip',
  'data-tooltip',
  'aria-label',
  'title',
] as const;
const TOOLTIP_CLASS_NAME = 'app-tooltip';
const TOOLTIP_SELECTOR_ATTRIBUTE = null;

const resolveTooltipText = (target: Element): string => {
  for (const attr of TOOLTIP_TEXT_ATTRIBUTES) {
    const value = target.getAttribute(attr);
    if (value) return value;
  }
  return '';
};

export const initAppTooltipSystem = (): IAppTooltipSystem => {
  const tooltipElement = document.createElement('div');
  tooltipElement.className = TOOLTIP_CLASS_NAME;
  if (TOOLTIP_SELECTOR_ATTRIBUTE) {
    tooltipElement.setAttribute(TOOLTIP_SELECTOR_ATTRIBUTE, '');
  }
  tooltipElement.setAttribute('role', 'tooltip');
  tooltipElement.style.position = 'fixed';
  tooltipElement.style.pointerEvents = 'none';
  tooltipElement.style.zIndex = '9999';
  tooltipElement.style.opacity = '0';
  tooltipElement.hidden = true;
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
    tooltipElement.style.left = `${event.clientX + 10}px`;
    tooltipElement.style.top = `${event.clientY + 10}px`;
  };

  const show = (target: Element, event?: PointerEvent | MouseEvent): void => {
    const text = resolveTooltipText(target);
    if (!text) return;

    tooltipElement.textContent = text;
    tooltipElement.hidden = false;
    tooltipElement.style.opacity = '1';

    if (event) {
      setPosition(event);
    }
  };

  const hide = (): void => {
    clearHoverTimer();
    hoverTarget = null;
    tooltipElement.hidden = true;
    tooltipElement.style.opacity = '0';
    tooltipElement.textContent = '';

    if (pointerMoveAttached) {
      document.removeEventListener('pointermove', handlePointerMove);
      pointerMoveAttached = false;
    }
  };

  function handlePointerMove(event: PointerEvent): void {
    setPosition(event);
  }

  const handlePointerOver = (event: PointerEvent): void => {
    const target =
      event.target instanceof Element
        ? event.target.closest('[data-app-tooltip], [data-tooltip], [aria-label], [title]')
        : null;
    if (!target) return;

    hoverTarget = target;

    if (!pointerMoveAttached) {
      document.addEventListener('pointermove', handlePointerMove);
      pointerMoveAttached = true;
    }

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
      event.target instanceof Element
        ? event.target.closest('[data-app-tooltip], [data-tooltip], [aria-label], [title]')
        : null;
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

  return {
    dispose() {
      hide();
      document.removeEventListener('pointerover', handlePointerOver);
      document.removeEventListener('pointerout', handlePointerOut);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      tooltipElement.remove();
    },
  };
};

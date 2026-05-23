import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initAppTooltipSystem } from './app-tooltip';

// ---------------------------------------------------------------------------
// Test fixtures & constants
// ---------------------------------------------------------------------------

const TOOLTIP_TEXT = '延迟显示提示';

/** initAppTooltipSystem 内部约定的悬停延迟,与实现保持同步;改一处即可。 */
const TOOLTIP_HOVER_DELAY_MS = 3000;

/** 模拟目标元素的 BoundingClientRect。 */
const TARGET_RECT = {
  x: 20,
  y: 24,
  width: 80,
  height: 24,
  top: 24,
  right: 100,
  bottom: 48,
  left: 20,
} as const;

/** 落在 TARGET_RECT 内部的任意一个点(不必是中点,实现只关心命中)。 */
const INSIDE_TARGET_POINT = { x: 36, y: 32 } as const;

/** initAppTooltipSystem 在 window 上挂的卸载句柄(双下划线命名约定)。 */
const TOOLTIP_CLEANUP_KEY = '__SH_APP_TOOLTIP_CLEANUP__' as const;

const TOOLTIP_VISIBLE_CLASS = 'is-visible';
const TOOLTIP_ELEMENT_SELECTOR = '#app-global-tooltip';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const createTooltipTarget = (): HTMLButtonElement => {
  const target = document.createElement('button');
  target.type = 'button';
  target.className = 'app-tooltip-target';
  target.dataset.tooltip = TOOLTIP_TEXT;
  target.getBoundingClientRect = (): DOMRect => ({
    ...TARGET_RECT,
    toJSON: () => undefined,
  }) as DOMRect;

  document.body.appendChild(target);
  return target;
};

/** 取 tooltip DOM 节点;首次调用时打桩 offsetWidth/offsetHeight,jsdom 默认两者为 0。 */
const getTooltipElement = (): HTMLDivElement => {
  const tooltipElement = document.querySelector<HTMLDivElement>(TOOLTIP_ELEMENT_SELECTOR);
  if (!tooltipElement) {
    throw new Error('Tooltip element not initialized');
  }

  Object.defineProperty(tooltipElement, 'offsetWidth', { configurable: true, get: () => 96 });
  Object.defineProperty(tooltipElement, 'offsetHeight', { configurable: true, get: () => 28 });

  return tooltipElement;
};

// ---------------------------------------------------------------------------
// Event dispatch helpers
// ---------------------------------------------------------------------------

const dispatchPointerOver = (
  target: Element,
  point: { x: number; y: number } = INSIDE_TARGET_POINT,
): void => {
  target.dispatchEvent(
    new MouseEvent('pointerover', {
      bubbles: true,
      clientX: point.x,
      clientY: point.y,
    }),
  );
};

const dispatchPointerOut = (target: Element): void => {
  target.dispatchEvent(
    new MouseEvent('pointerout', {
      bubbles: true,
      relatedTarget: null,
    }),
  );
};

const dispatchFocusIn = (target: Element): void => {
  target.dispatchEvent(
    new FocusEvent('focusin', {
      bubbles: true,
      relatedTarget: null,
    }),
  );
};

const isTooltipVisible = (tooltipElement: HTMLElement): boolean =>
  tooltipElement.classList.contains(TOOLTIP_VISIBLE_CLASS);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('initAppTooltipSystem', () => {
  /** 由 elementFromPoint stub 闭包读取,逐用例改写以模拟 hit-test 命中目标。 */
  let hoverHitTarget: Element | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    hoverHitTarget = null;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => hoverHitTarget),
    });
  });

  afterEach(() => {
    window[TOOLTIP_CLEANUP_KEY]?.();
    window[TOOLTIP_CLEANUP_KEY] = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it(`鼠标悬停满 ${TOOLTIP_HOVER_DELAY_MS / 1000} 秒后才显示 tooltip`, () => {
    const target = createTooltipTarget();
    hoverHitTarget = target;

    initAppTooltipSystem();
    const tooltipElement = getTooltipElement();

    dispatchPointerOver(target);

    expect(isTooltipVisible(tooltipElement)).toBe(false);

    vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS - 1);
    expect(isTooltipVisible(tooltipElement)).toBe(false);

    vi.advanceTimersByTime(1);
    expect(isTooltipVisible(tooltipElement)).toBe(true);
    expect(tooltipElement.textContent).toBe(TOOLTIP_TEXT);
  });

  it(`鼠标在 ${TOOLTIP_HOVER_DELAY_MS / 1000} 秒内移出时不显示 tooltip`, () => {
    const target = createTooltipTarget();
    hoverHitTarget = target;

    initAppTooltipSystem();
    const tooltipElement = getTooltipElement();

    dispatchPointerOver(target);
    hoverHitTarget = null;
    dispatchPointerOut(target);

    vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS);
    expect(isTooltipVisible(tooltipElement)).toBe(false);
    expect(tooltipElement.textContent).toBe('');
  });

  it('键盘 focus 进入时仍然立即显示 tooltip', () => {
    const target = createTooltipTarget();

    initAppTooltipSystem();
    const tooltipElement = getTooltipElement();

    dispatchFocusIn(target);

    expect(isTooltipVisible(tooltipElement)).toBe(true);
    expect(tooltipElement.textContent).toBe(TOOLTIP_TEXT);
  });

  it('空闲态不常驻监听 pointermove,只在悬停追踪期间按需挂载', () => {
    const target = createTooltipTarget();
    hoverHitTarget = target;
    const addEventListenerSpy = vi.spyOn(document, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
    const countPointerMoveAdds = (): number =>
      addEventListenerSpy.mock.calls.filter(([eventName]) => eventName === 'pointermove').length;
    const countPointerMoveRemoves = (): number =>
      removeEventListenerSpy.mock.calls.filter(([eventName]) => eventName === 'pointermove').length;

    initAppTooltipSystem();

    expect(countPointerMoveAdds()).toBe(0);

    dispatchPointerOver(target);
    expect(countPointerMoveAdds()).toBe(1);

    dispatchPointerOut(target);
    expect(countPointerMoveRemoves()).toBe(1);
  });

  it('空闲态不常驻监听 scroll/resize,只在需要定位时按需挂载', () => {
    const target = createTooltipTarget();
    hoverHitTarget = target;
    const documentAddEventListenerSpy = vi.spyOn(document, 'addEventListener');
    const documentRemoveEventListenerSpy = vi.spyOn(document, 'removeEventListener');
    const windowAddEventListenerSpy = vi.spyOn(window, 'addEventListener');
    const windowRemoveEventListenerSpy = vi.spyOn(window, 'removeEventListener');
    const countDocumentEventAdds = (eventName: string): number =>
      documentAddEventListenerSpy.mock.calls.filter(([name]) => name === eventName).length;
    const countDocumentEventRemoves = (eventName: string): number =>
      documentRemoveEventListenerSpy.mock.calls.filter(([name]) => name === eventName).length;
    const countWindowEventAdds = (eventName: string): number =>
      windowAddEventListenerSpy.mock.calls.filter(([name]) => name === eventName).length;
    const countWindowEventRemoves = (eventName: string): number =>
      windowRemoveEventListenerSpy.mock.calls.filter(([name]) => name === eventName).length;

    initAppTooltipSystem();

    expect(countDocumentEventAdds('scroll')).toBe(0);
    expect(countWindowEventAdds('resize')).toBe(0);

    dispatchPointerOver(target);
    expect(countDocumentEventAdds('scroll')).toBe(1);
    expect(countWindowEventAdds('resize')).toBe(1);

    dispatchPointerOut(target);
    expect(countDocumentEventRemoves('scroll')).toBe(1);
    expect(countWindowEventRemoves('resize')).toBe(1);
  });
});

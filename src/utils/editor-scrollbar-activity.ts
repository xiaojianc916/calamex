const EDITOR_SCROLLER_SELECTOR = '.codemirror-editor-surface .cm-scroller';
const EDITOR_SCROLLBAR_ACTIVE_CLASS = 'is-editor-scrollbar-active';
const EDITOR_SCROLLBAR_IDLE_HIDE_DELAY_MS = 900;
const EDITOR_SCROLLBAR_GUTTER_WIDTH = 4;

const scrollbarIdleTimers = new WeakMap<HTMLElement, number>();
let initialized = false;

const clearScrollbarIdleTimer = (scroller: HTMLElement): void => {
  const timer = scrollbarIdleTimers.get(scroller);

  if (timer === undefined) {
    return;
  }

  window.clearTimeout(timer);
  scrollbarIdleTimers.delete(scroller);
};

const showScrollbarTemporarily = (scroller: HTMLElement): void => {
  clearScrollbarIdleTimer(scroller);
  scroller.classList.add(EDITOR_SCROLLBAR_ACTIVE_CLASS);

  const timer = window.setTimeout(() => {
    scrollbarIdleTimers.delete(scroller);
    scroller.classList.remove(EDITOR_SCROLLBAR_ACTIVE_CLASS);
  }, EDITOR_SCROLLBAR_IDLE_HIDE_DELAY_MS);

  scrollbarIdleTimers.set(scroller, timer);
};

const resolveEditorScroller = (target: EventTarget | null): HTMLElement | null => {
  if (!(target instanceof Element)) {
    return null;
  }

  return target.closest(EDITOR_SCROLLER_SELECTOR) as HTMLElement | null;
};

const isPointerInScrollbarGutter = (event: PointerEvent, scroller: HTMLElement): boolean => {
  const rect = scroller.getBoundingClientRect();
  const inVerticalGutter =
    event.clientX >= rect.right - EDITOR_SCROLLBAR_GUTTER_WIDTH && event.clientX <= rect.right;
  const inHorizontalGutter =
    event.clientY >= rect.bottom - EDITOR_SCROLLBAR_GUTTER_WIDTH && event.clientY <= rect.bottom;

  return inVerticalGutter || inHorizontalGutter;
};

const handleDocumentScroll = (event: Event): void => {
  const scroller = resolveEditorScroller(event.target);

  if (!scroller) {
    return;
  }

  showScrollbarTemporarily(scroller);
};

const handlePointerMove = (event: PointerEvent): void => {
  const scroller = resolveEditorScroller(event.target);

  if (!scroller || !isPointerInScrollbarGutter(event, scroller)) {
    return;
  }

  showScrollbarTemporarily(scroller);
};

const handlePointerDown = (event: PointerEvent): void => {
  const scroller = resolveEditorScroller(event.target);

  if (!scroller || !isPointerInScrollbarGutter(event, scroller)) {
    return;
  }

  clearScrollbarIdleTimer(scroller);
  scroller.classList.add(EDITOR_SCROLLBAR_ACTIVE_CLASS);

  const handlePointerEnd = (): void => {
    showScrollbarTemporarily(scroller);
    window.removeEventListener('pointerup', handlePointerEnd);
    window.removeEventListener('pointercancel', handlePointerEnd);
  };

  window.addEventListener('pointerup', handlePointerEnd);
  window.addEventListener('pointercancel', handlePointerEnd);
};

export const initEditorScrollbarActivity = (): void => {
  if (initialized || typeof document === 'undefined') {
    return;
  }

  initialized = true;
  document.addEventListener('scroll', handleDocumentScroll, true);
  document.addEventListener('pointermove', handlePointerMove, { passive: true });
  document.addEventListener('pointerdown', handlePointerDown);
};

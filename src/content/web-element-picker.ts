import { finder } from '@medv/finder';

/**
 * Built-in browser element picker, injected into the inspected page over CDP.
 *
 * The Rust control plane exposes a `__calamexPickerResult` binding (via
 * Runtime.addBinding) and then evaluates this bundle to (re)activate the picker.
 * Hovering highlights the element under the cursor; clicking captures a robust
 * CSS selector (@medv/finder) plus a truncated outerHTML and the page url, then
 * ships them back through the binding. Pressing Escape — or calling
 * `__calamexTeardownPicker` — cancels without picking.
 */

const MAX_OUTER_HTML_CHARS = 2000;
const OVERLAY_ID = '__calamex-picker-overlay';

interface PickerResult {
  url: string;
  label: string;
  outerHtml: string;
}

type PickerWindow = Window & {
  __calamexPickerResult?: (payload: string) => void;
  __calamexTeardownPicker?: () => void;
  __calamexPickerActive?: boolean;
};

const pickerWindow = window as unknown as PickerWindow;

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}\u2026`;

const describeElement = (element: Element): string => {
  try {
    return finder(element);
  } catch {
    return element.tagName.toLowerCase();
  }
};

const createOverlay = (): HTMLDivElement => {
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.position = 'fixed';
  overlay.style.zIndex = '2147483647';
  overlay.style.pointerEvents = 'none';
  overlay.style.border = '2px solid #6366f1';
  overlay.style.borderRadius = '2px';
  overlay.style.background = 'rgba(99, 102, 241, 0.16)';
  overlay.style.transition = 'all 60ms ease-out';
  overlay.style.display = 'none';
  return overlay;
};

const activate = (): void => {
  if (pickerWindow.__calamexPickerActive) {
    pickerWindow.__calamexTeardownPicker?.();
  }
  pickerWindow.__calamexPickerActive = true;

  const overlay = createOverlay();
  document.documentElement.appendChild(overlay);

  let current: Element | null = null;

  const moveOverlayTo = (element: Element): void => {
    const rect = element.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  };

  const onMouseMove = (event: MouseEvent): void => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || target.id === OVERLAY_ID) {
      return;
    }
    current = target;
    moveOverlayTo(target);
  };

  const onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const element = current ?? document.elementFromPoint(event.clientX, event.clientY);
    if (element) {
      const result: PickerResult = {
        url: window.location.href,
        label: describeElement(element),
        outerHtml: truncate(element.outerHTML, MAX_OUTER_HTML_CHARS),
      };
      pickerWindow.__calamexPickerResult?.(JSON.stringify(result));
    }
    teardown();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      teardown();
    }
  };

  function teardown(): void {
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    pickerWindow.__calamexPickerActive = false;
    if (pickerWindow.__calamexTeardownPicker === teardown) {
      pickerWindow.__calamexTeardownPicker = undefined;
    }
  }

  pickerWindow.__calamexTeardownPicker = teardown;
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
};

activate();

import { finder } from '@medv/finder';

/**
 * Built-in browser element picker, injected into the inspected page over CDP.
 *
 * The Rust control plane exposes a `__calamexPickerResult` binding (via
 * Runtime.addBinding) and then evaluates this bundle to (re)activate the picker.
 *
 * @medv/finder only turns a node into a CSS selector — it draws no UI — so this
 * script renders its own DevTools-style overlay: a highlight box plus a label
 * badge (tag#id.class + live width × height) that follows the cursor, so the user
 * can see exactly which element is under the pointer. Clicking captures a robust
 * CSS selector (@medv/finder) plus a truncated outerHTML and the page url, then
 * ships them back through the binding. Pressing Escape — or calling
 * `__calamexTeardownPicker` — cancels without picking.
 */

const MAX_OUTER_HTML_CHARS = 2000;
const OVERLAY_ID = '__calamex-picker-overlay';
const BADGE_ID = '__calamex-picker-badge';

interface PickerResult {
  url: string;
  label: string;
  outerHtml: string;
}

type BadgeParts = { badge: HTMLDivElement; selSpan: HTMLSpanElement; sizeSpan: HTMLSpanElement };

type PickerWindow = Window & {
  __calamexPickerResult?: (payload: string) => void;
  __calamexTeardownPicker?: () => void;
  __calamexPickerActive?: boolean;
};

const pickerWindow = window as unknown as PickerWindow;

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}\u2026`;

// Robust CSS selector for the captured payload.
const selectorOf = (element: Element): string => {
  try {
    return finder(element);
  } catch {
    return element.tagName.toLowerCase();
  }
};

// Short, human-readable descriptor (tag#id.class) shown in the hover badge.
const shortLabel = (element: Element): string => {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : '';
  const className = typeof element.className === 'string' ? element.className.trim() : '';
  const cls = className ? `.${className.split(/\s+/).slice(0, 2).join('.')}` : '';
  return `${tag}${id}${cls}`;
};

const createOverlay = (): HTMLDivElement => {
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.position = 'fixed';
  overlay.style.zIndex = '2147483646';
  overlay.style.pointerEvents = 'none';
  overlay.style.border = '2px solid #6366f1';
  overlay.style.borderRadius = '2px';
  overlay.style.background = 'rgba(99, 102, 241, 0.16)';
  overlay.style.boxShadow = '0 0 0 1px rgba(255, 255, 255, 0.6)';
  overlay.style.transition = 'all 60ms ease-out';
  overlay.style.display = 'none';
  return overlay;
};

const createBadge = (): BadgeParts => {
  const badge = document.createElement('div');
  badge.id = BADGE_ID;
  badge.style.position = 'fixed';
  badge.style.zIndex = '2147483647';
  badge.style.pointerEvents = 'none';
  badge.style.display = 'none';
  badge.style.maxWidth = '360px';
  badge.style.padding = '3px 8px';
  badge.style.borderRadius = '6px';
  badge.style.background = '#1e1b4b';
  badge.style.font = '500 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace';
  badge.style.whiteSpace = 'nowrap';
  badge.style.overflow = 'hidden';
  badge.style.textOverflow = 'ellipsis';
  badge.style.boxShadow = '0 2px 10px rgba(15, 23, 42, 0.35)';

  const selSpan = document.createElement('span');
  selSpan.style.color = '#c7d2fe';
  badge.appendChild(selSpan);

  const sizeSpan = document.createElement('span');
  sizeSpan.style.color = '#818cf8';
  sizeSpan.style.marginLeft = '8px';
  badge.appendChild(sizeSpan);

  return { badge, selSpan, sizeSpan };
};

const activate = (): void => {
  if (pickerWindow.__calamexPickerActive) {
    pickerWindow.__calamexTeardownPicker?.();
  }
  pickerWindow.__calamexPickerActive = true;

  const overlay = createOverlay();
  const { badge, selSpan, sizeSpan } = createBadge();
  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(badge);

  let current: Element | null = null;

  const highlight = (element: Element): void => {
    const rect = element.getBoundingClientRect();

    overlay.style.display = 'block';
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    selSpan.textContent = shortLabel(element);
    sizeSpan.textContent = `${Math.round(rect.width)} \u00d7 ${Math.round(rect.height)}`;

    badge.style.display = 'block';
    const badgeTop = rect.top > 26 ? rect.top - 26 : rect.bottom + 6;
    const maxLeft = window.innerWidth - badge.offsetWidth - 4;
    const badgeLeft = Math.max(4, Math.min(rect.left, maxLeft));
    badge.style.left = `${badgeLeft}px`;
    badge.style.top = `${badgeTop}px`;
  };

  const onMouseMove = (event: MouseEvent): void => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || target.id === OVERLAY_ID || target.id === BADGE_ID) {
      return;
    }
    current = target;
    highlight(target);
  };

  const onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const element = current ?? document.elementFromPoint(event.clientX, event.clientY);
    if (element) {
      const result: PickerResult = {
        url: window.location.href,
        label: selectorOf(element),
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
    badge.remove();
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

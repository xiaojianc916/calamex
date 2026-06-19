import { onBeforeUnmount, reactive, ref } from 'vue';
import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types';
import { openExternalUrl } from '@/utils/platform/browser';
import {
  tryReadClipboardText,
  tryWriteClipboardText,
  writeClipboardText,
} from '@/utils/platform/clipboard';

const MENU_WIDTH = 224;
const MENU_HEIGHT = 320;
const VIEWPORT_PADDING = 12;
const MENU_ROOT_SELECTOR = '.linear-context-menu-root';
const SUPPORTED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password']);

type TBrowserContextMenuAction =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'open-link'
  | 'copy-link';

interface IBrowserContextMenuItem extends ILinearContextMenuItem {
  action: TBrowserContextMenuAction;
  children?: IBrowserContextMenuItem[];
}

type TBrowserContextMenuGroup = ILinearContextMenuGroup<IBrowserContextMenuItem>;

interface IBrowserContextMenuState {
  open: boolean;
  x: number;
  y: number;
}

interface IResolvedContextTarget {
  element: HTMLElement | null;
  editableElement: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
  isEditableText: boolean;
  isReadOnly: boolean;
  linkHref: string | null;
  selectedText: string;
  inputSelection: { start: number; end: number } | null;
  documentSelectionRange: Range | null;
  isTerminalSurface: boolean;
}

type TTerminalControls = {
  copySelection: () => Promise<void>;
  pasteFromClipboard: () => Promise<void>;
  selectAll: () => void;
  getSelectionText: () => string;
};

const isTargetInsideMenu = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(MENU_ROOT_SELECTOR) !== null;

const clampMenuPosition = (clientX: number, clientY: number) => ({
  x: Math.min(
    clientX,
    Math.max(VIEWPORT_PADDING, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING),
  ),
  y: Math.min(
    clientY,
    Math.max(VIEWPORT_PADDING, window.innerHeight - MENU_HEIGHT - VIEWPORT_PADDING),
  ),
});

const resolveShortcutModifierLabels = (): {
  primary: string;
  shift: string;
} => {
  const platform =
    typeof navigator !== 'undefined'
      ? `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase()
      : '';
  const isMacLike = /mac|iphone|ipad|ipod/.test(platform);

  return isMacLike ? { primary: '⌘', shift: '⇧' } : { primary: 'Ctrl', shift: 'Shift' };
};

const createShortcutMap = (): Record<TBrowserContextMenuAction, string[]> => {
  const labels = resolveShortcutModifierLabels();

  return {
    undo: [labels.primary, 'Z'],
    redo: [labels.primary, labels.shift, 'Z'],
    cut: [labels.primary, 'X'],
    copy: [labels.primary, 'C'],
    paste: [labels.primary, 'V'],
    'select-all': [labels.primary, 'A'],
    'open-link': [labels.primary, 'Enter'],
    'copy-link': [labels.primary, labels.shift, 'C'],
  };
};

const SHORTCUT_MAP = createShortcutMap();

const isHtmlTextInputElement = (element: Element | null): element is HTMLInputElement =>
  element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has((element.type ?? '').toLowerCase());

const isTextEditableElement = (element: Element | null): boolean =>
  isHtmlTextInputElement(element) ||
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLElement && element.isContentEditable);

const resolveEditableElement = (
  element: HTMLElement | null,
): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null => {
  let current: HTMLElement | null = element;

  while (current) {
    if (isTextEditableElement(current)) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
};

const resolveLinkHref = (element: HTMLElement | null): string | null => {
  const anchor = element?.closest('a[href]') as HTMLAnchorElement | null;
  if (!anchor) {
    return null;
  }

  try {
    const url = new URL(anchor.href, window.location.href);
    return SUPPORTED_LINK_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
};

const resolveInputSelection = (
  element: HTMLInputElement | HTMLTextAreaElement,
): { text: string; start: number; end: number } => {
  const start = element.selectionStart ?? 0;
  const end = element.selectionEnd ?? start;
  return {
    text: start === end ? '' : element.value.slice(start, end),
    start,
    end,
  };
};

const resolveDocumentSelection = (
  element: HTMLElement | null,
): { text: string; range: Range | null } => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return { text: '', range: null };
  }

  if (!element) {
    return {
      text: selection.toString(),
      range: selection.getRangeAt(0).cloneRange(),
    };
  }

  try {
    const range = selection.getRangeAt(0);
    return range.intersectsNode(element)
      ? { text: selection.toString(), range: range.cloneRange() }
      : { text: '', range: null };
  } catch {
    return {
      text: selection.toString(),
      range: selection.getRangeAt(0).cloneRange(),
    };
  }
};

const resolveContextTarget = (target: EventTarget | null): IResolvedContextTarget => {
  const element =
    target instanceof HTMLElement
      ? target
      : target instanceof SVGElement
        ? (target as unknown as HTMLElement)
        : null;
  const editableElement = resolveEditableElement(element);
  const isEditableText = editableElement !== null;
  const isReadOnly =
    editableElement instanceof HTMLInputElement || editableElement instanceof HTMLTextAreaElement
      ? editableElement.readOnly || editableElement.disabled
      : editableElement instanceof HTMLElement
        ? editableElement.getAttribute('contenteditable') === 'false'
        : false;

  const inputSelection =
    editableElement instanceof HTMLInputElement || editableElement instanceof HTMLTextAreaElement
      ? resolveInputSelection(editableElement)
      : null;
  const documentSelection = inputSelection
    ? { text: '', range: null }
    : resolveDocumentSelection(element);
  const selectedText = inputSelection?.text ?? documentSelection.text;

  return {
    element,
    editableElement,
    isEditableText,
    isReadOnly,
    linkHref: resolveLinkHref(element),
    selectedText,
    inputSelection: inputSelection
      ? { start: inputSelection.start, end: inputSelection.end }
      : null,
    documentSelectionRange: documentSelection.range,
    isTerminalSurface:
      element?.closest('.embedded-terminal-host, .embedded-terminal-shell') !== null,
  };
};

const resolveContextMenuPoint = (event: MouseEvent): { x: number; y: number } => {
  if (event.clientX > 0 || event.clientY > 0) {
    return clampMenuPosition(event.clientX, event.clientY);
  }

  const targetElement =
    event.target instanceof HTMLElement || event.target instanceof SVGElement ? event.target : null;
  const rect = targetElement?.getBoundingClientRect();

  if (!rect) {
    return clampMenuPosition(VIEWPORT_PADDING, VIEWPORT_PADDING);
  }

  return clampMenuPosition(rect.left + 12, rect.top + 12);
};

const focusEditableElement = (element: IResolvedContextTarget['editableElement']): void => {
  if (element instanceof HTMLElement) {
    element.focus({ preventScroll: true });
  }
};

const restoreInputSelection = (
  element: HTMLInputElement | HTMLTextAreaElement,
  selection: IResolvedContextTarget['inputSelection'],
): void => {
  focusEditableElement(element);
  if (!selection) {
    return;
  }

  element.setSelectionRange(selection.start, selection.end);
};

const restoreDocumentSelection = (range: Range | null): boolean => {
  if (!range) {
    return false;
  }

  const selection = window.getSelection();
  if (!selection) {
    return false;
  }

  selection.removeAllRanges();
  selection.addRange(range);
  return true;
};

/**
 * execCommand 兜底调用。execCommand 在 W3C 规范中标记为 deprecated，但以下场景
 * 目前无标准 Web API 替代，仍需保留：
 *
 * - undo / redo：W3C 未提供主动触发 undo/redo 的标准 API（beforeinput 的
 *   historyUndo inputType 可监听但不可主动触发），execCommand 是唯一方案。
 *
 * 以下场景已优先使用标准 API，execCommand 仅作 fallback：
 * - cut / copy：优先 navigator.clipboard + setRangeText / Selection API
 * - paste：优先 navigator.clipboard.readText + insertTextIntoEditable
 * - select-all：input/textarea 用 .select()；contentEditable 有 Range API fallback
 * - insertText（contentEditable paste 路径）：优先 execCommand('insertText')，
 *   fallback 到 Range.deleteContents + TextNode 插入
 */
const execDocumentCommand = (command: string, value?: string): boolean => {
  if (typeof document.execCommand !== 'function') {
    return false;
  }

  try {
    return document.execCommand(command, false, value);
  } catch {
    return false;
  }
};

const dispatchEditableInput = (
  element: HTMLInputElement | HTMLTextAreaElement | HTMLElement,
): void => {
  element.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
    }),
  );
};

const cutTextFromInput = async (
  element: HTMLInputElement | HTMLTextAreaElement,
  selection: IResolvedContextTarget['inputSelection'],
): Promise<boolean> => {
  if (!selection || selection.start === selection.end) {
    return false;
  }

  const selectedText = element.value.slice(selection.start, selection.end);
  if (!selectedText) {
    return false;
  }

  if (!(await tryWriteClipboardText(selectedText))) {
    return false;
  }
  element.setRangeText('', selection.start, selection.end, 'start');
  dispatchEditableInput(element);
  return true;
};

const cutTextFromContentEditable = async (
  element: HTMLElement,
  target: IResolvedContextTarget,
): Promise<boolean> => {
  if (!target.selectedText || !restoreDocumentSelection(target.documentSelectionRange)) {
    return false;
  }

  if (!(await tryWriteClipboardText(target.selectedText))) {
    return false;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  selection.deleteFromDocument();
  dispatchEditableInput(element);
  return true;
};

const insertTextIntoEditable = async (
  target: IResolvedContextTarget['editableElement'],
  text: string,
): Promise<boolean> => {
  if (!text || !target) {
    return false;
  }

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.setRangeText(text, start, end, 'end');
    dispatchEditableInput(target);
    return true;
  }

  focusEditableElement(target);
  if (execDocumentCommand('insertText', text)) {
    return true;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  dispatchEditableInput(target);
  return true;
};

const selectDocumentContents = (element: HTMLElement | null): boolean => {
  if (!element) {
    return execDocumentCommand('selectAll');
  }

  const selection = window.getSelection();
  if (!selection) {
    return false;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
};

const restoreEditableSelection = (target: IResolvedContextTarget): void => {
  if (
    target.editableElement instanceof HTMLInputElement ||
    target.editableElement instanceof HTMLTextAreaElement
  ) {
    restoreInputSelection(target.editableElement, target.inputSelection);
    return;
  }

  if (target.documentSelectionRange) {
    restoreDocumentSelection(target.documentSelectionRange);
    return;
  }

  focusEditableElement(target.editableElement);
};

export const useBrowserContextMenu = () => {
  const state = reactive<IBrowserContextMenuState>({
    open: false,
    x: 0,
    y: 0,
  });
  const groups = ref<TBrowserContextMenuGroup[]>([]);
  const contextTarget = ref<IResolvedContextTarget | null>(null);
  let terminalControlsPromise: Promise<TTerminalControls | null> | null = null;

  const getTerminalControls = async (): Promise<TTerminalControls | null> => {
    if (!terminalControlsPromise) {
      terminalControlsPromise = import('@/composables/useIntegratedTerminal')
        .then(({ useIntegratedTerminalControls }) => useIntegratedTerminalControls())
        .catch(() => null);
    }

    return terminalControlsPromise;
  };

  const closeMenu = (): void => {
    state.open = false;
    groups.value = [];
    contextTarget.value = null;
  };

  const buildMenuGroups = (
    target: IResolvedContextTarget,
    hasTerminalSelection = false,
  ): TBrowserContextMenuGroup[] => {
    const hasSelection = target.selectedText.length > 0 || hasTerminalSelection;
    const canEdit = target.isEditableText && !target.isReadOnly;
    const nextGroups: TBrowserContextMenuGroup[] = [];

    if (target.linkHref) {
      nextGroups.push({
        key: 'link-actions',
        title: 'LINK',
        items: [
          {
            key: 'open-link',
            label: '打开链接',
            icon: 'open-external',
            shortcut: SHORTCUT_MAP['open-link'],
            action: 'open-link',
          },
          {
            key: 'copy-link',
            label: '复制链接',
            icon: 'link',
            shortcut: SHORTCUT_MAP['copy-link'],
            action: 'copy-link',
          },
        ],
      });
    }

    if (target.isTerminalSurface) {
      nextGroups.push({
        key: 'terminal-clipboard',

        items: [
          {
            key: 'copy',
            label: '复制',
            icon: 'copy',
            shortcut: SHORTCUT_MAP.copy,
            action: 'copy',
            disabled: !hasSelection,
          },
          {
            key: 'paste',
            label: '粘贴',
            icon: 'paste',
            shortcut: SHORTCUT_MAP.paste,
            action: 'paste',
          },
          {
            key: 'select-all',
            label: '全选',
            icon: 'select-all',
            shortcut: SHORTCUT_MAP['select-all'],
            action: 'select-all',
          },
        ],
      });

      return nextGroups;
    }

    if (!target.linkHref && !target.isEditableText && !hasSelection) {
      return nextGroups;
    }

    if (target.isEditableText) {
      nextGroups.push({
        key: 'edit-actions',
        title: 'EDIT',
        items: [
          {
            key: 'undo',
            label: '撤销',
            icon: 'undo',
            shortcut: SHORTCUT_MAP.undo,
            action: 'undo',
            disabled: !canEdit,
          },
          {
            key: 'redo',
            label: '恢复撤销',
            icon: 'redo',
            shortcut: SHORTCUT_MAP.redo,
            action: 'redo',
            disabled: !canEdit,
          },
        ],
      });
    }

    nextGroups.push({
      key: 'clipboard-actions',

      items: [
        {
          key: 'cut',
          label: '剪切',
          icon: 'cut',
          shortcut: SHORTCUT_MAP.cut,
          action: 'cut',
          disabled: !canEdit || !hasSelection,
        },
        {
          key: 'copy',
          label: '复制',
          icon: 'copy',
          shortcut: SHORTCUT_MAP.copy,
          action: 'copy',
          disabled: !hasSelection,
        },
        {
          key: 'paste',
          label: '粘贴',
          icon: 'paste',
          shortcut: SHORTCUT_MAP.paste,
          action: 'paste',
          disabled: !canEdit,
        },
        {
          key: 'select-all',
          label: '全选',
          icon: 'select-all',
          shortcut: SHORTCUT_MAP['select-all'],
          action: 'select-all',
        },
      ],
    });

    return nextGroups;
  };

  const openMenu = (
    event: MouseEvent,
    target: IResolvedContextTarget,
    hasTerminalSelection = false,
  ): void => {
    groups.value = buildMenuGroups(target, hasTerminalSelection);
    if (groups.value.length === 0) {
      closeMenu();
      return;
    }

    const nextPosition = resolveContextMenuPoint(event);
    state.x = nextPosition.x;
    state.y = nextPosition.y;
    state.open = true;
    contextTarget.value = target;
  };

  const handleCopy = async (target: IResolvedContextTarget): Promise<void> => {
    if (target.isTerminalSurface) {
      const terminalControls = await getTerminalControls();
      if (!terminalControls) {
        return;
      }
      await terminalControls.copySelection();
      return;
    }

    if (target.selectedText && !(await tryWriteClipboardText(target.selectedText))) {
      restoreEditableSelection(target);
      execDocumentCommand('copy');
    }
  };

  const handleCut = async (target: IResolvedContextTarget): Promise<void> => {
    if (!target.editableElement || target.isReadOnly) {
      return;
    }

    if (
      target.editableElement instanceof HTMLInputElement ||
      target.editableElement instanceof HTMLTextAreaElement
    ) {
      restoreInputSelection(target.editableElement, target.inputSelection);
      await cutTextFromInput(target.editableElement, target.inputSelection);
      return;
    }

    if (target.editableElement instanceof HTMLElement && target.editableElement.isContentEditable) {
      if (await cutTextFromContentEditable(target.editableElement, target)) {
        return;
      }
    }

    restoreEditableSelection(target);
    execDocumentCommand('cut');
  };

  const handlePaste = async (target: IResolvedContextTarget): Promise<void> => {
    if (target.isTerminalSurface) {
      const terminalControls = await getTerminalControls();
      if (!terminalControls) {
        return;
      }
      await terminalControls.pasteFromClipboard();
      return;
    }

    if (!target.editableElement || target.isReadOnly) {
      return;
    }

    const clipboardText = await tryReadClipboardText();
    if (clipboardText === null) {
      restoreEditableSelection(target);
      execDocumentCommand('paste');
      return;
    }

    restoreEditableSelection(target);
    await insertTextIntoEditable(target.editableElement, clipboardText);
  };

  const handleSelectAll = async (target: IResolvedContextTarget): Promise<void> => {
    if (target.isTerminalSurface) {
      const terminalControls = await getTerminalControls();
      if (!terminalControls) {
        return;
      }
      terminalControls.selectAll();
      return;
    }

    if (
      target.editableElement instanceof HTMLInputElement ||
      target.editableElement instanceof HTMLTextAreaElement
    ) {
      focusEditableElement(target.editableElement);
      target.editableElement.select();
      return;
    }

    if (target.editableElement instanceof HTMLElement && target.editableElement.isContentEditable) {
      focusEditableElement(target.editableElement);
      if (execDocumentCommand('selectAll')) {
        return;
      }

      selectDocumentContents(target.editableElement);
      return;
    }

    selectDocumentContents(document.body);
  };

  const executeItem = async (item: ILinearContextMenuItem): Promise<void> => {
    const actionItem = item as IBrowserContextMenuItem;
    const target = contextTarget.value;
    closeMenu();

    if (!target || actionItem.disabled) {
      return;
    }

    switch (actionItem.action) {
      case 'undo':
        restoreEditableSelection(target);
        execDocumentCommand('undo');
        return;
      case 'redo':
        restoreEditableSelection(target);
        execDocumentCommand('redo');
        return;
      case 'cut':
        await handleCut(target);
        return;
      case 'copy':
        await handleCopy(target);
        return;
      case 'paste':
        await handlePaste(target);
        return;
      case 'select-all':
        handleSelectAll(target);
        return;
      case 'open-link':
        if (target.linkHref) {
          openExternalUrl(target.linkHref);
        }
        return;
      case 'copy-link':
        if (target.linkHref) {
          await writeClipboardText(target.linkHref);
        }
        return;
      default:
        return;
    }
  };

  const handleWindowPointerDown = (event: PointerEvent): void => {
    if (!state.open || isTargetInsideMenu(event.target)) {
      return;
    }

    closeMenu();
  };

  const handleWindowContextMenu = async (event: MouseEvent): Promise<void> => {
    if (isTargetInsideMenu(event.target)) {
      event.preventDefault();
      return;
    }

    const target = resolveContextTarget(event.target);

    if (event.defaultPrevented) {
      if (state.open) {
        closeMenu();
      }
      return;
    }

    event.preventDefault();

    let hasTerminalSelection = false;
    if (target.isTerminalSurface) {
      const terminalControls = await getTerminalControls();
      hasTerminalSelection = (terminalControls?.getSelectionText()?.length ?? 0) > 0;
    }

    openMenu(event, target, hasTerminalSelection);
  };

  const handleWindowKeydown = (event: KeyboardEvent): void => {
    if (state.open && event.key === 'Escape') {
      closeMenu();
    }
  };

  const handleWindowResize = (): void => {
    if (state.open) {
      closeMenu();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', handleWindowPointerDown, true);
    window.addEventListener('contextmenu', handleWindowContextMenu);
    window.addEventListener('keydown', handleWindowKeydown);
    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('blur', handleWindowResize);
  }

  onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', handleWindowPointerDown, true);
      window.removeEventListener('contextmenu', handleWindowContextMenu);
      window.removeEventListener('keydown', handleWindowKeydown);
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('blur', handleWindowResize);
    }
  });

  return {
    contextMenuState: state,
    contextMenuGroups: groups,
    executeContextMenuItem: executeItem,
  };
};

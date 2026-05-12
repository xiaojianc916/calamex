import type {
  IEditorContextMenuGroup,
  IEditorContextMenuItem,
  TEditorContextMenuAction,
} from '@/components/editor/editor-context-menu.types';
import type { IAiCodeActionRequest } from '@/types/ai';
import { tryReadClipboardText, writeClipboardText } from '@/utils/clipboard';
import { monaco } from '@/utils/monaco';
import type * as Monaco from 'monaco-editor';
import { onBeforeUnmount, reactive, ref } from 'vue';

const MENU_WIDTH = 224;
const SUBMENU_SAFE_WIDTH = 224;
const VIEWPORT_PADDING = 12;
const MENU_ROOT_SELECTOR = '.linear-context-menu-root';
const MENU_TRIGGER_SELECTOR = '.linear-context-menu-trigger';
const RECENT_OPEN_GUARD_MS = 250;
const RECENT_OPEN_DISTANCE_PX = 4;

type TEditorContextMenuPosition = {
  lineNumber: number;
  column: number;
} | null | undefined;

const resolveShortcutModifierLabels = (): {
  primary: string;
  alt: string;
  shift: string;
} => {
  const platform =
    typeof navigator !== 'undefined'
      ? `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase()
      : '';
  const isMacLike = /mac|iphone|ipad|ipod/.test(platform);

  return isMacLike
    ? { primary: '⌘', alt: '⌥', shift: '⇧' }
    : { primary: 'Ctrl', alt: 'Alt', shift: 'Shift' };
};

const createShortcutMap = (): Record<TEditorContextMenuAction, string[]> => {
  const labels = resolveShortcutModifierLabels();

  return {
    'open-terminal': [],
    undo: [labels.primary, 'Z'],
    redo: [labels.primary, labels.shift, 'Z'],
    'format-with-shfmt': [labels.alt, labels.shift, 'F'],
    'toggle-comment-line': [labels.primary, '/'],
    find: [labels.primary, 'F'],
    'goto-line': [labels.primary, 'G'],
    'quick-command': ['F1'],
    'run-current-script': [labels.primary, 'Enter'],
    cut: [labels.primary, 'X'],
    copy: [labels.primary, 'C'],
    paste: [labels.primary, 'V'],
    'select-all': [labels.primary, 'A'],
    'ai-explain-selection': [],
    'ai-fix-diagnostic': [],
    'ai-generate-tests': [],
  };
};

const SHORTCUT_MAP = createShortcutMap();

interface IUseEditorContextMenuOptions {
  getEditor: () => Monaco.editor.IStandaloneCodeEditor | null;
  canRunCurrentScript: () => boolean;
  onOpenTerminalRequest?: () => void;
  onFormatRequest: () => void;
  onCommandPaletteRequest: () => void;
  onRunCurrentScriptRequest: () => void;
  onAiCodeActionRequest?: (
    kind: IAiCodeActionRequest['kind'],
    selection: string,
  ) => Promise<void> | void;
}

interface IEditorContextMenuState {
  open: boolean;
  x: number;
  y: number;
}

const isTargetInsideMenu = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  (target.closest(MENU_ROOT_SELECTOR) !== null || target.closest(MENU_TRIGGER_SELECTOR) !== null);

const clampMenuPosition = (clientX: number, clientY: number) => ({
  x: Math.min(clientX, Math.max(VIEWPORT_PADDING, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING)),
  y: Math.min(clientY, Math.max(VIEWPORT_PADDING, window.innerHeight - 320 - VIEWPORT_PADDING)),
});

const updateSelectionForContextMenu = (
  editor: Monaco.editor.IStandaloneCodeEditor,
  targetPosition: TEditorContextMenuPosition,
): void => {
  if (!targetPosition) {
    return;
  }

  const selection = editor.getSelection();
  if (selection?.containsPosition(targetPosition)) {
    return;
  }

  const nextSelection = new monaco.Selection(
    targetPosition.lineNumber,
    targetPosition.column,
    targetPosition.lineNumber,
    targetPosition.column,
  );
  editor.setSelection(nextSelection);
  editor.setPosition(targetPosition);
};

const runMonacoAction = async (
  editor: Monaco.editor.IStandaloneCodeEditor,
  actionId: string,
): Promise<void> => {
  const action = editor.getAction(actionId);
  if (!action || !action.isSupported()) {
    return;
  }

  await action.run();
};

const isSelectionEmpty = (selection: Monaco.Selection): boolean =>
  selection.startLineNumber === selection.endLineNumber &&
  selection.startColumn === selection.endColumn;

const resolvePrimarySelection = (
  editor: Monaco.editor.IStandaloneCodeEditor,
): Monaco.Selection | null => editor.getSelection();

const resolveTextSelections = (
  editor: Monaco.editor.IStandaloneCodeEditor,
): Monaco.Selection[] => {
  const selections = editor.getSelections() ?? [];
  return selections.filter((selection) => !isSelectionEmpty(selection));
};

const resolveCurrentLineRange = (
  editor: Monaco.editor.IStandaloneCodeEditor,
): Monaco.Range | null => {
  const model = editor.getModel();
  const position = editor.getPosition();

  if (!model || !position) {
    return null;
  }

  const lineNumber = Math.min(Math.max(position.lineNumber, 1), model.getLineCount());
  if (lineNumber < model.getLineCount()) {
    return new monaco.Range(lineNumber, 1, lineNumber + 1, 1);
  }

  return new monaco.Range(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber));
};

const resolveEditorSelectionText = (
  editor: Monaco.editor.IStandaloneCodeEditor,
): string | null => {
  const model = editor.getModel();
  if (!model) {
    return null;
  }

  const textSelections = resolveTextSelections(editor);
  if (textSelections.length > 0) {
    return textSelections
      .map((selection) => model.getValueInRange(selection))
      .join(model.getEOL());
  }

  const lineRange = resolveCurrentLineRange(editor);
  return lineRange ? model.getValueInRange(lineRange) : null;
};

const pushEditorUndoBoundary = (editor: Monaco.editor.IStandaloneCodeEditor): void => {
  editor.pushUndoStop();
};

const copyEditorSelection = async (
  editor: Monaco.editor.IStandaloneCodeEditor,
): Promise<void> => {
  const text = resolveEditorSelectionText(editor);
  if (text === null) {
    await runMonacoAction(editor, 'editor.action.clipboardCopyAction');
    return;
  }

  try {
    await writeClipboardText(text);
  } catch {
    await runMonacoAction(editor, 'editor.action.clipboardCopyAction');
  }
};

const cutEditorSelection = async (
  editor: Monaco.editor.IStandaloneCodeEditor,
): Promise<void> => {
  const model = editor.getModel();
  if (!model) {
    return;
  }

  const textSelections = resolveTextSelections(editor);
  const targetRanges: Monaco.Selection[] | Monaco.Range[] =
    textSelections.length > 0
      ? textSelections
      : (() => {
        const lineRange = resolveCurrentLineRange(editor);
        return lineRange ? [lineRange] : [];
      })();

  if (targetRanges.length === 0) {
    return;
  }

  try {
    await writeClipboardText(
      targetRanges.map((range) => model.getValueInRange(range)).join(model.getEOL()),
    );
  } catch {
    await runMonacoAction(editor, 'editor.action.clipboardCutAction');
    return;
  }

  pushEditorUndoBoundary(editor);
  editor.executeEdits(
    'context-menu.cut',
    targetRanges.map((range) => ({
      range,
      text: '',
      forceMoveMarkers: true,
    })),
  );
  pushEditorUndoBoundary(editor);
};

const pasteIntoEditor = async (
  editor: Monaco.editor.IStandaloneCodeEditor,
): Promise<void> => {
  const clipboardText = await tryReadClipboardText();
  if (clipboardText === null) {
    await runMonacoAction(editor, 'editor.action.clipboardPasteAction');
    return;
  }

  const selection = resolvePrimarySelection(editor);
  if (!selection) {
    return;
  }

  pushEditorUndoBoundary(editor);
  editor.executeEdits('context-menu.paste', [
    {
      range: selection,
      text: clipboardText,
      forceMoveMarkers: true,
    },
  ]);
  pushEditorUndoBoundary(editor);
};

const selectAllEditorText = (editor: Monaco.editor.IStandaloneCodeEditor): void => {
  const model = editor.getModel();
  if (!model) {
    return;
  }

  editor.setSelection(model.getFullModelRange());
};

const triggerEditorCommand = (
  editor: Monaco.editor.IStandaloneCodeEditor,
  commandId: string,
): void => {
  editor.trigger('context-menu', commandId, null);
};

export const useEditorContextMenu = (options: IUseEditorContextMenuOptions) => {
  const state = reactive<IEditorContextMenuState>({
    open: false,
    x: 0,
    y: 0,
  });
  const groups = ref<IEditorContextMenuGroup[]>([]);
  const submenuDirection = ref<'left' | 'right'>('right');
  let lastOpenAt = 0;
  let lastOpenX = -1;
  let lastOpenY = -1;

  const rememberOpenPosition = (browserEvent: MouseEvent): void => {
    lastOpenAt = Date.now();
    lastOpenX = browserEvent.clientX;
    lastOpenY = browserEvent.clientY;
  };

  const isRecentOpenAtSamePoint = (browserEvent: MouseEvent): boolean => {
    if (lastOpenAt === 0) {
      return false;
    }

    return (
      Date.now() - lastOpenAt <= RECENT_OPEN_GUARD_MS &&
      Math.abs(browserEvent.clientX - lastOpenX) <= RECENT_OPEN_DISTANCE_PX &&
      Math.abs(browserEvent.clientY - lastOpenY) <= RECENT_OPEN_DISTANCE_PX
    );
  };

  const closeMenu = (): void => {
    state.open = false;
    groups.value = [];
  };

  const supportsAction = (
    editor: Monaco.editor.IStandaloneCodeEditor,
    actionId: string,
  ): boolean => {
    const action = editor.getAction(actionId);
    return Boolean(action?.isSupported());
  };

  const buildMenuGroups = (
    editor: Monaco.editor.IStandaloneCodeEditor,
  ): IEditorContextMenuGroup[] => {
    const isReadOnly = editor.getOption(monaco.editor.EditorOption.readOnly);
    const supportsFind = supportsAction(editor, 'actions.find');
    const supportsGotoLine = supportsAction(editor, 'editor.action.gotoLine');
    const supportsCommentLine = supportsAction(editor, 'editor.action.commentLine');
    const hasModel = editor.getModel() !== null;
    const canRunCurrentScript = options.canRunCurrentScript();
    const selectedText = resolveEditorSelectionText(editor)?.trim() ?? '';
    const canRunAiAction = hasModel && selectedText.length > 0 && Boolean(options.onAiCodeActionRequest);

    const aiChildren: IEditorContextMenuItem[] = [
      {
        key: 'ai-explain-selection',
        label: 'AI 解释选区',
        icon: 'search',
        action: 'ai-explain-selection',
        disabled: !canRunAiAction,
      },
      {
        key: 'ai-fix-diagnostic',
        label: 'AI 修复诊断',
        icon: 'wrench',
        action: 'ai-fix-diagnostic',
        disabled: !canRunAiAction,
      },
      {
        key: 'ai-generate-tests',
        label: 'AI 生成测试',
        icon: 'flask',
        action: 'ai-generate-tests',
        disabled: !canRunAiAction,
      },
    ];

    const formatChildren: IEditorContextMenuItem[] = [
      {
        key: 'format-with-shfmt',
        label: '使用 shfmt 格式化',
        icon: 'format',
        shortcut: SHORTCUT_MAP['format-with-shfmt'],
        action: 'format-with-shfmt',
        disabled: isReadOnly,
      },
      {
        key: 'toggle-comment-line',
        label: '切换行注释',
        icon: 'comment',
        shortcut: SHORTCUT_MAP['toggle-comment-line'],
        action: 'toggle-comment-line',
        disabled: !supportsCommentLine || isReadOnly,
      },
    ];

    const navigationChildren: IEditorContextMenuItem[] = [
      {
        key: 'find',
        label: '查找',
        icon: 'search',
        shortcut: SHORTCUT_MAP.find,
        action: 'find',
        disabled: !supportsFind,
      },
      {
        key: 'goto-line',
        label: '转到行 / 列',
        icon: 'goto',
        shortcut: SHORTCUT_MAP['goto-line'],
        action: 'goto-line',
        disabled: !supportsGotoLine,
      },
    ];

    return [
      {
        key: 'run-actions',

        items: [
          {
            key: 'open-terminal',
            label: '打开终端',
            icon: 'terminal',
            shortcut: SHORTCUT_MAP['open-terminal'],
            action: 'open-terminal',
            disabled: false,
          },
          {
            key: 'run-current-script',
            label: '运行当前脚本',
            icon: 'play',
            shortcut: SHORTCUT_MAP['run-current-script'],
            action: 'run-current-script',
            disabled: !canRunCurrentScript,
          },
        ],
      },
      {
        key: 'history-actions',

        items: [
          {
            key: 'undo',
            label: '撤销',
            icon: 'undo',
            shortcut: SHORTCUT_MAP.undo,
            action: 'undo',
            disabled: isReadOnly || !hasModel,
          },
          {
            key: 'redo',
            label: '恢复撤销',
            icon: 'redo',
            shortcut: SHORTCUT_MAP.redo,
            action: 'redo',
            disabled: isReadOnly || !hasModel,
          },
        ],
      },
      {
        key: 'code-actions',

        items: [
          {
            key: 'format-tools',
            label: '格式与注释',
            icon: 'format',
            children: formatChildren,
            disabled: formatChildren.every((item) => item.disabled),
          },
          {
            key: 'find-tools',
            label: '查找与跳转',
            icon: 'search',
            children: navigationChildren,
            disabled: navigationChildren.every((item) => item.disabled),
          },
        ],
      },
      {
        key: 'edit-actions',

        items: [
          {
            key: 'cut',
            label: '剪切',
            icon: 'cut',
            shortcut: SHORTCUT_MAP.cut,
            action: 'cut',
            disabled: isReadOnly || !hasModel,
          },
          {
            key: 'copy',
            label: '复制',
            icon: 'copy',
            shortcut: SHORTCUT_MAP.copy,
            action: 'copy',
            disabled: !hasModel,
          },
          {
            key: 'paste',
            label: '粘贴',
            icon: 'paste',
            shortcut: SHORTCUT_MAP.paste,
            action: 'paste',
            disabled: isReadOnly || !hasModel,
          },
        ],
      },
    ];
  };

  const openMenu = (
    editor: Monaco.editor.IStandaloneCodeEditor,
    browserEvent: MouseEvent,
  ): void => {
    const nextPosition = clampMenuPosition(browserEvent.clientX, browserEvent.clientY);

    groups.value = buildMenuGroups(editor);
    state.x = nextPosition.x;
    state.y = nextPosition.y;
    state.open = true;
    rememberOpenPosition(browserEvent);
    submenuDirection.value =
      nextPosition.x + MENU_WIDTH + SUBMENU_SAFE_WIDTH + VIEWPORT_PADDING > window.innerWidth
        ? 'left'
        : 'right';
  };

  const handleEditorMouseDown = (event: Monaco.editor.IEditorMouseEvent): void => {
    if (!event.event.rightButton) {
      return;
    }

    handleBrowserContextMenu(event.event.browserEvent, event.target.position);
  };

  const handleEditorContextMenu = (event: Monaco.editor.IEditorMouseEvent): void => {
    handleBrowserContextMenu(event.event.browserEvent, event.target.position);
  };

  const handleBrowserContextMenu = (
    browserEvent: MouseEvent,
    targetPosition?: TEditorContextMenuPosition,
  ): void => {
    const editor = options.getEditor();
    if (!editor) {
      return;
    }

    browserEvent.preventDefault();
    browserEvent.stopPropagation();
    updateSelectionForContextMenu(editor, targetPosition);
    editor.focus();
    openMenu(editor, browserEvent);
  };

  const executeItem = async (item: IEditorContextMenuItem): Promise<void> => {
    if (!item.action) {
      return;
    }

    const editor = options.getEditor();
    if (!editor) {
      closeMenu();
      return;
    }

    closeMenu();
    editor.focus();

    switch (item.action) {
      case 'ai-explain-selection': {
        const selection = resolveEditorSelectionText(editor);
        if (selection) {
          await options.onAiCodeActionRequest?.('explain_selection', selection);
        }
        return;
      }
      case 'ai-fix-diagnostic': {
        const selection = resolveEditorSelectionText(editor);
        if (selection) {
          await options.onAiCodeActionRequest?.('fix_diagnostic', selection);
        }
        return;
      }
      case 'ai-generate-tests': {
        const selection = resolveEditorSelectionText(editor);
        if (selection) {
          await options.onAiCodeActionRequest?.('generate_tests', selection);
        }
        return;
      }
      case 'undo':
        triggerEditorCommand(editor, 'undo');
        return;
      case 'redo':
        triggerEditorCommand(editor, 'redo');
        return;
      case 'format-with-shfmt':
        options.onFormatRequest();
        return;
      case 'toggle-comment-line':
        await runMonacoAction(editor, 'editor.action.commentLine');
        return;
      case 'find':
        await runMonacoAction(editor, 'actions.find');
        return;
      case 'goto-line':
        await runMonacoAction(editor, 'editor.action.gotoLine');
        return;
      case 'quick-command':
        options.onCommandPaletteRequest();
        return;
      case 'run-current-script':
        options.onRunCurrentScriptRequest();
        return;
      case 'open-terminal':
        options.onOpenTerminalRequest?.();
        return;
      case 'cut':
        await cutEditorSelection(editor);
        return;
      case 'copy':
        await copyEditorSelection(editor);
        return;
      case 'paste':
        await pasteIntoEditor(editor);
        return;
      case 'select-all':
        selectAllEditorText(editor);
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

  const handleWindowContextMenu = (event: MouseEvent): void => {
    if (!event.isTrusted) {
      return;
    }

    // LinearContextMenu opens Reka ContextMenu by dispatching a synthetic contextmenu event.
    // Reka Trigger ignores events that are already defaultPrevented, so we only suppress
    // duplicated native events from real user interaction.
    if (isRecentOpenAtSamePoint(event) && event.isTrusted) {
      event.preventDefault();
      return;
    }

    if (!state.open || isTargetInsideMenu(event.target)) {
      return;
    }

    closeMenu();
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
    window.addEventListener('contextmenu', handleWindowContextMenu, true);
    window.addEventListener('keydown', handleWindowKeydown);
    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('blur', handleWindowResize);
  }

  onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', handleWindowPointerDown, true);
      window.removeEventListener('contextmenu', handleWindowContextMenu, true);
      window.removeEventListener('keydown', handleWindowKeydown);
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('blur', handleWindowResize);
    }
  });

  return {
    contextMenuState: state,
    contextMenuGroups: groups,
    submenuDirection,
    closeContextMenu: closeMenu,
    executeContextMenuItem: executeItem,
    handleBrowserContextMenu,
    handleEditorMouseDown,
    handleEditorContextMenu,
  };
};

import type {
  IEditorContextMenuGroup,
  IEditorContextMenuItem,
  TEditorContextMenuAction,
} from '@/components/editor/editor-context-menu.types';
import { tryReadClipboardText, writeClipboardText } from '@/utils/clipboard';
import { monaco } from '@/utils/monaco';
import { onBeforeUnmount, reactive, ref } from 'vue';
import type { IAiCodeActionRequest } from '@/types/ai';

const MENU_WIDTH = 224;
const SUBMENU_SAFE_WIDTH = 224;
const VIEWPORT_PADDING = 12;
const MENU_ROOT_SELECTOR = '.linear-context-menu-root';

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
  };
};

const SHORTCUT_MAP = createShortcutMap();

interface IUseEditorContextMenuOptions {
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null;
  canRunCurrentScript: () => boolean;
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
  target instanceof Element && target.closest(MENU_ROOT_SELECTOR) !== null;

const clampMenuPosition = (clientX: number, clientY: number) => ({
  x: Math.min(clientX, Math.max(VIEWPORT_PADDING, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING)),
  y: Math.min(clientY, Math.max(VIEWPORT_PADDING, window.innerHeight - 320 - VIEWPORT_PADDING)),
});

const updateSelectionForContextMenu = (
  editor: monaco.editor.IStandaloneCodeEditor,
  event: monaco.editor.IEditorMouseEvent,
): void => {
  const targetPosition = event.target.position;
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
  editor: monaco.editor.IStandaloneCodeEditor,
  actionId: string,
): Promise<void> => {
  const action = editor.getAction(actionId);
  if (!action || !action.isSupported()) {
    return;
  }

  await action.run();
};

const isSelectionEmpty = (selection: monaco.Selection): boolean =>
  selection.startLineNumber === selection.endLineNumber &&
  selection.startColumn === selection.endColumn;

const resolvePrimarySelection = (
  editor: monaco.editor.IStandaloneCodeEditor,
): monaco.Selection | null => editor.getSelection();

const resolveTextSelections = (
  editor: monaco.editor.IStandaloneCodeEditor,
): monaco.Selection[] => {
  const selections = editor.getSelections() ?? [];
  return selections.filter((selection) => !isSelectionEmpty(selection));
};

const resolveCurrentLineRange = (
  editor: monaco.editor.IStandaloneCodeEditor,
): monaco.Range | null => {
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
  editor: monaco.editor.IStandaloneCodeEditor,
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

const pushEditorUndoBoundary = (editor: monaco.editor.IStandaloneCodeEditor): void => {
  editor.pushUndoStop();
};

const copyEditorSelection = async (
  editor: monaco.editor.IStandaloneCodeEditor,
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
  editor: monaco.editor.IStandaloneCodeEditor,
): Promise<void> => {
  const model = editor.getModel();
  if (!model) {
    return;
  }

  const textSelections = resolveTextSelections(editor);
  const targetRanges: monaco.Selection[] | monaco.Range[] =
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
  editor: monaco.editor.IStandaloneCodeEditor,
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

const selectAllEditorText = (editor: monaco.editor.IStandaloneCodeEditor): void => {
  const model = editor.getModel();
  if (!model) {
    return;
  }

  editor.setSelection(model.getFullModelRange());
};

const triggerEditorCommand = (
  editor: monaco.editor.IStandaloneCodeEditor,
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

  const closeMenu = (): void => {
    state.open = false;
    groups.value = [];
  };

  const supportsAction = (
    editor: monaco.editor.IStandaloneCodeEditor,
    actionId: string,
  ): boolean => {
    const action = editor.getAction(actionId);
    return Boolean(action?.isSupported());
  };

  const buildMenuGroups = (
    editor: monaco.editor.IStandaloneCodeEditor,
  ): IEditorContextMenuGroup[] => {
    const isReadOnly = editor.getOption(monaco.editor.EditorOption.readOnly);
    const supportsFind = supportsAction(editor, 'actions.find');
    const supportsGotoLine = supportsAction(editor, 'editor.action.gotoLine');
    const supportsCommentLine = supportsAction(editor, 'editor.action.commentLine');
    const hasModel = editor.getModel() !== null;
    const canRunCurrentScript = options.canRunCurrentScript();
    const selectedText = resolveEditorSelectionText(editor)?.trim() ?? '';
    const canRunAiAction = hasModel && selectedText.length > 0 && Boolean(options.onAiCodeActionRequest);

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
        key: 'ai-actions',
        title: 'AI',
        items: [
          {
            key: 'ai-explain-selection',
            label: 'AI 解释选区',
            icon: 'command',
            action: 'ai-explain-selection',
            disabled: !canRunAiAction,
          },
          {
            key: 'ai-fix-diagnostic',
            label: 'AI 修复诊断',
            icon: 'command',
            action: 'ai-fix-diagnostic',
            disabled: !canRunAiAction,
          },
          {
            key: 'ai-generate-tests',
            label: 'AI 生成测试',
            icon: 'command',
            action: 'ai-generate-tests',
            disabled: !canRunAiAction,
          },
        ],
      },
      {
        key: 'run-actions',
        title: 'RUN',
        items: [
          {
            key: 'run-current-script',
            label: '运行当前脚本',
            icon: 'command',
            shortcut: SHORTCUT_MAP['run-current-script'],
            action: 'run-current-script',
            disabled: !canRunCurrentScript,
          },
        ],
      },
      {
        key: 'history-actions',
        title: 'EDIT',
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
        title: 'EDITOR ACTIONS',
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
          {
            key: 'quick-command',
            label: '命令面板',
            icon: 'command',
            shortcut: SHORTCUT_MAP['quick-command'],
            action: 'quick-command',
            disabled: false,
          },
        ],
      },
      {
        key: 'edit-actions',
        title: 'CLIPBOARD',
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
          {
            key: 'select-all',
            label: '全选',
            icon: 'select-all',
            shortcut: SHORTCUT_MAP['select-all'],
            action: 'select-all',
            disabled: !hasModel,
          },
        ],
      },
    ];
  };

  const openMenu = (
    editor: monaco.editor.IStandaloneCodeEditor,
    event: monaco.editor.IEditorMouseEvent,
  ): void => {
    const browserEvent = event.event.browserEvent;
    const nextPosition = clampMenuPosition(browserEvent.clientX, browserEvent.clientY);

    groups.value = buildMenuGroups(editor);
    state.x = nextPosition.x;
    state.y = nextPosition.y;
    state.open = true;
    submenuDirection.value =
      nextPosition.x + MENU_WIDTH + SUBMENU_SAFE_WIDTH + VIEWPORT_PADDING > window.innerWidth
        ? 'left'
        : 'right';
  };

  const handleEditorContextMenu = (event: monaco.editor.IEditorMouseEvent): void => {
    const editor = options.getEditor();
    if (!editor) {
      return;
    }

    event.event.browserEvent.preventDefault();
    event.event.browserEvent.stopPropagation();
    updateSelectionForContextMenu(editor, event);
    editor.focus();
    openMenu(editor, event);
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
    handleEditorContextMenu,
  };
};

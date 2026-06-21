import { EditorSelection, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { aiService } from '@/services/ipc/ai.service';
import type { IAiInlineCompletionResult } from '@/types/ai';
import { logger } from '@/utils/platform/logger';

const INLINE_COMPLETION_CONTEXT_LIMIT = 8_000;
const INLINE_COMPLETION_CONTEXT_CODE_UNIT_WINDOW = INLINE_COMPLETION_CONTEXT_LIMIT * 2;
const INLINE_COMPLETION_DELAY_MS = 450;
const INLINE_COMPLETION_CONFIG_TTL_MS = 5_000;

// 缓存 AI 配置，避免每次补全（每次按键去抖后）都发起一次 IPC。
// 使用较短 TTL，使设置变更（如关闭行内补全）能在数秒内生效。
let cachedConfigPromise: ReturnType<typeof aiService.getConfig> | null = null;
let cachedConfigAt = 0;

const getInlineCompletionConfig = (): ReturnType<typeof aiService.getConfig> => {
  const now = Date.now();
  if (!cachedConfigPromise || now - cachedConfigAt > INLINE_COMPLETION_CONFIG_TTL_MS) {
    cachedConfigAt = now;
    cachedConfigPromise = aiService.getConfig().catch((error: unknown) => {
      // 获取失败不缓存，下次重新拉取。
      cachedConfigPromise = null;
      throw error;
    });
  }
  return cachedConfigPromise;
};

interface IInlineCompletionState {
  from: number;
  text: string;
}

export interface ICodeMirrorInlineCompletionOptions {
  getFilePath: () => string | null | undefined;
  getLanguage: () => string;
}

class InlineCompletionGhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: InlineCompletionGhostWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = 'cm-ghostText';
    span.textContent = this.text;
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const setInlineCompletionGhost = StateEffect.define<IInlineCompletionState | null>();

const inlineCompletionGhostField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setInlineCompletionGhost)) {
        continue;
      }
      const next = effect.value;
      if (!next?.text) {
        return Decoration.none;
      }
      const widget = Decoration.widget({
        side: 1,
        widget: new InlineCompletionGhostWidget(next.text),
      });
      return Decoration.set([widget.range(next.from)]);
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const inlineCompletionState = StateField.define<IInlineCompletionState | null>({
  create() {
    return null;
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setInlineCompletionGhost)) {
        return effect.value;
      }
    }
    if (transaction.docChanged) {
      return null;
    }
    if (!value) {
      return null;
    }
    const mappedFrom = transaction.changes.mapPos(value.from);
    return { ...value, from: mappedFrom };
  },
});

export const clipInlineContext = (value: string, limit: number): string => {
  if (limit <= 0 || value.length === 0) {
    return '';
  }

  let codePoints = 0;
  let start = value.length;
  while (start > 0 && codePoints < limit) {
    start -= 1;
    const code = value.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff && start > 0) {
      const previousCode = value.charCodeAt(start - 1);
      if (previousCode >= 0xd800 && previousCode <= 0xdbff) {
        start -= 1;
      }
    }
    codePoints += 1;
  }
  return value.slice(start);
};

// 从字符串「开头」保留至多 limit 个码点，且不在末尾切断一个代理对(与 clipInlineContext 对称，
// 后者从结尾保留)。用于裁剪光标右侧的 suffix 上下文。
export const clipInlineContextTrailing = (value: string, limit: number): string => {
  if (limit <= 0 || value.length === 0) {
    return '';
  }
  let codePoints = 0;
  let end = 0;
  while (end < value.length && codePoints < limit) {
    const code = value.charCodeAt(end);
    if (code >= 0xd800 && code <= 0xdbff && end + 1 < value.length) {
      const nextCode = value.charCodeAt(end + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        end += 1;
      }
    }
    end += 1;
    codePoints += 1;
  }
  return value.slice(0, end);
};

const resolveInlineCompletionContexts = (
  view: EditorView,
  cursorOffset: number,
): { prefix: string; suffix: string } => {
  const prefixStart = Math.max(0, cursorOffset - INLINE_COMPLETION_CONTEXT_CODE_UNIT_WINDOW);
  return {
    prefix: clipInlineContext(
      view.state.doc.sliceString(prefixStart, cursorOffset),
      INLINE_COMPLETION_CONTEXT_LIMIT,
    ),
    suffix: clipInlineContextTrailing(
      view.state.doc.sliceString(
        cursorOffset,
        cursorOffset + INLINE_COMPLETION_CONTEXT_CODE_UNIT_WINDOW,
      ),
      INLINE_COMPLETION_CONTEXT_LIMIT,
    ),
  };
};

const resolveInlineCompletionInsertText = (
  cursorOffset: number,
  result: IAiInlineCompletionResult,
): string => {
  if (result.range.startOffset !== cursorOffset || result.range.endOffset !== cursorOffset) {
    return '';
  }
  return result.insertText;
};

const acceptInlineCompletion = (view: EditorView): boolean => {
  const ghost = view.state.field(inlineCompletionState, false);
  if (!ghost?.text.trim() || view.state.selection.main.head !== ghost.from) {
    return false;
  }
  view.dispatch({
    changes: { from: ghost.from, insert: ghost.text },
    selection: EditorSelection.cursor(ghost.from + ghost.text.length),
    effects: setInlineCompletionGhost.of(null),
  });
  return true;
};

export const createCodeMirrorInlineCompletionController = (
  options: ICodeMirrorInlineCompletionOptions,
) => {
  let timerId: number | null = null;
  let requestId = 0;
  let viewRef: EditorView | null = null;

  const clearTimer = (): void => {
    if (timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  };

  const clearGhost = (): void => {
    viewRef?.dispatch({ effects: setInlineCompletionGhost.of(null) });
  };

  const requestInlineCompletion = async (
    nextRequestId: number,
    cursorOffset: number,
  ): Promise<void> => {
    const view = viewRef;
    if (!view || options.getLanguage() !== 'shell') {
      return;
    }
    const config = await getInlineCompletionConfig();
    if (nextRequestId !== requestId || !config.inlineCompletionEnabled) {
      return;
    }
    const { prefix, suffix } = resolveInlineCompletionContexts(view, cursorOffset);
    const result = await aiService.inlineComplete({
      filePath: options.getFilePath() ?? 'untitled.sh',
      language: 'shell',
      cursorOffset,
      prefix,
      suffix,
    });
    const insertText = resolveInlineCompletionInsertText(cursorOffset, result);
    if (nextRequestId !== requestId || !insertText.trim()) {
      return;
    }
    viewRef?.dispatch({
      effects: setInlineCompletionGhost.of({ from: cursorOffset, text: insertText }),
    });
  };

  const schedule = (view: EditorView): void => {
    viewRef = view;
    clearTimer();
    requestId += 1;
    clearGhost();
    if (options.getLanguage() !== 'shell') {
      return;
    }
    const cursorOffset = view.state.selection.main.head;
    const nextRequestId = requestId;
    timerId = window.setTimeout(() => {
      timerId = null;
      // 行内补全是尽力而为的后台能力：请求失败(网络/Provider/IPC)静默降级，
      // 仅在 debug 级别留痕，避免未捕获的 promise rejection 噪声。
      void requestInlineCompletion(nextRequestId, cursorOffset).catch((error: unknown) => {
        logger.debug({ event: 'codemirror.inline_completion.request_failed', err: error });
      });
    }, INLINE_COMPLETION_DELAY_MS);
  };

  return {
    clear(): void {
      clearTimer();
      requestId += 1;
      clearGhost();
    },
    destroy(): void {
      clearTimer();
      requestId += 1;
      viewRef = null;
    },
    extensions: [
      inlineCompletionGhostField,
      inlineCompletionState,
      keymap.of([{ key: 'Tab', run: acceptInlineCompletion }]),
    ],
    handleUpdate(update: ViewUpdate): void {
      if (update.docChanged) {
        schedule(update.view);
        return;
      }
      // 纯移动光标(无文档变化)不应触发 AI 补全请求：仅作废待定请求并清掉已展示的 ghost，
      // 否则方向键导航也会在停顿后打一次补全 IPC。
      if (update.selectionSet) {
        viewRef = update.view;
        clearTimer();
        requestId += 1;
        clearGhost();
      }
    },
  };
};

/**
 * LSP ↔ CM6 桥接
 *
 * 把 bash-language-server 的诊断 / 补全 / 悬停接入 CM6。
 *
 * Goals:
 *   - 单一全局 diagnostics 监听 + 按 filePath 分派（多编辑器场景安全）
 *   - 不依赖全局 latestRawDiags
 *   - completion / hover 前自动 flush 未发的 didChange
 *   - attach / detach 严格成对，无监听泄漏
 *   - lspBridge.start 自动去重
 */

import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import { autocompletion } from '@codemirror/autocomplete';
import type { Diagnostic } from '@codemirror/lint';
import { setDiagnostics } from '@codemirror/lint';
import type { Extension, Text } from '@codemirror/state';
import {
  EditorView,
  hoverTooltip,
  type Tooltip,
  type ViewUpdate,
} from '@codemirror/view';
import type { UnlistenFn } from '@tauri-apps/api/event';

// ============================================================================
// Tauri IPC（懒加载，避免 SSR / 测试环境炸）
// ============================================================================
type TauriCore = typeof import('@tauri-apps/api/core');
type TauriEvent = typeof import('@tauri-apps/api/event');
let coreMod: TauriCore | null = null;
let eventMod: TauriEvent | null = null;

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!coreMod) coreMod = await import('@tauri-apps/api/core');
  return coreMod.invoke<T>(cmd, args);
}
async function tauriListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!eventMod) eventMod = await import('@tauri-apps/api/event');
  return eventMod.listen<T>(event, (e) => handler(e.payload));
}

// ============================================================================
// 与 Rust 端对齐的类型
// ============================================================================
interface LspDiag {
  filePath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: number; // 1=Error 2=Warning 3=Info 4=Hint
  message: string;
  code: string | null;
  source: string | null;
}
interface LspDiagEvent {
  filePath: string;
  diagnostics: LspDiag[];
}
interface LspItem {
  label: string;
  insertText: string | null;
  kind: number | null;
  detail: string | null;
  documentation: string | null;
}
interface LspHover {
  contents: string;
}

// ============================================================================
// Bridge 单例
// ============================================================================
type FileHandler = (diags: LspDiag[]) => void;

class LspBridge {
  private started = false;
  private startPromise: Promise<void> | null = null;
  private unlistenDiagnostics: UnlistenFn | null = null;
  private fileHandlers = new Map<string, FileHandler>();

  async start(workspaceRoot: string): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      // 先建立监听，避免 didOpen → 第一波诊断丢失
      this.unlistenDiagnostics = await tauriListen<LspDiagEvent>(
        'lsp-diagnostics',
        (e) => {
          const h = this.fileHandlers.get(e.filePath);
          if (h) h(e.diagnostics);
        },
      );
      try {
        await tauriInvoke<void>('lsp_start', { workspaceRoot });
        this.started = true;
      } catch (err) {
        // start 失败要拆掉监听
        this.unlistenDiagnostics?.();
        this.unlistenDiagnostics = null;
        throw err;
      }
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.unlistenDiagnostics) {
      this.unlistenDiagnostics();
      this.unlistenDiagnostics = null;
    }
    this.fileHandlers.clear();
    await tauriInvoke<void>('lsp_stop');
  }

  isStarted(): boolean {
    return this.started;
  }

  /** 注册按文件的诊断 handler，返回解注册函数。 */
  registerFile(filePath: string, handler: FileHandler): () => void {
    this.fileHandlers.set(filePath, handler);
    return () => {
      if (this.fileHandlers.get(filePath) === handler) {
        this.fileHandlers.delete(filePath);
      }
    };
  }

  didOpen(filePath: string, content: string, languageId: string): Promise<void> {
    return tauriInvoke<void>('lsp_did_open', { filePath, content, languageId });
  }
  didChange(filePath: string, content: string, version: number): Promise<void> {
    return tauriInvoke<void>('lsp_did_change', { filePath, content, version });
  }
  didClose(filePath: string): Promise<void> {
    return tauriInvoke<void>('lsp_did_close', { filePath });
  }
  completion(filePath: string, line: number, column: number): Promise<LspItem[]> {
    return tauriInvoke<LspItem[]>('lsp_completion', { filePath, line, column });
  }
  hover(filePath: string, line: number, column: number): Promise<LspHover | null> {
    return tauriInvoke<LspHover | null>('lsp_hover', { filePath, line, column });
  }
}

export const lspBridge = new LspBridge();

// 兼容旧的命名导出
export const lspStartBridge = (workspaceRoot: string) => lspBridge.start(workspaceRoot);
export const lspStopBridge = () => lspBridge.stop();
export const lspDidOpenBridge = (f: string, c: string, l: string) =>
  lspBridge.didOpen(f, c, l);
export const lspDidChangeBridge = (f: string, c: string, v: number) =>
  lspBridge.didChange(f, c, v);
export const lspDidCloseBridge = (f: string) => lspBridge.didClose(f);

// ============================================================================
// 严重度 / 种类映射
// ============================================================================
function severityToCm6(sev: number): 'error' | 'warning' | 'info' | 'hint' {
  switch (sev) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'info';
    default:
      return 'hint';
  }
}
function lspKindToType(kind: number | null): string {
  switch (kind) {
    case 2:
      return 'method';
    case 3:
      return 'function';
    case 6:
      return 'variable';
    case 14:
      return 'keyword';
    default:
      return 'text';
  }
}

function lspDiagToPositioned(d: LspDiag, doc: Text): Diagnostic {
  const lineNo = Math.min(Math.max(d.line + 1, 1), doc.lines);
  const line = doc.line(lineNo);
  const from = Math.min(line.from + d.column, line.to);
  const endLineNo = Math.min(Math.max(d.endLine + 1, 1), doc.lines);
  const endLine = doc.line(endLineNo);
  let to = Math.min(endLine.from + d.endColumn, endLine.to);
  if (to < from) to = from;
  return {
    from,
    to,
    severity: severityToCm6(d.severity),
    message: d.message,
    source: d.code ?? d.source ?? 'shellcheck',
  };
}

// ============================================================================
// CM6 Extension 工厂
// ============================================================================
export interface LspExtensionOptions {
  filePath: string;
  languageId: string; // e.g. "shellscript"
  /** 取当前最新内容；调用方负责其安全性 */
  getContent: () => string;
  /** didChange debounce 毫秒；默认 200 */
  changeDebounceMs?: number;
}

export interface LspExtensionHandle {
  extensions: Extension[];
  attach(view: EditorView): void;
  detach(): void;
}

export function createLspExtension(opts: LspExtensionOptions): LspExtensionHandle {
  const { filePath, languageId, getContent } = opts;
  const debounceMs = opts.changeDebounceMs ?? 200;

  let view: EditorView | null = null;
  let unregisterDiag: (() => void) | null = null;

  // 版本号 1 与 Rust didOpen 的 version=1 对齐；didChange 起步用 2。
  let docVersion = 1;
  let lastSentVersion = 1;
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  let detached = false;

  /** 立刻把还未发的 didChange 同步发出。completion / hover 前必调。 */
  async function flushPendingChanges(): Promise<void> {
    if (detached) return;
    if (lastSentVersion === docVersion) return;
    if (changeTimer) {
      clearTimeout(changeTimer);
      changeTimer = null;
    }
    const v = docVersion;
    const content = getContent();
    try {
      await lspBridge.didChange(filePath, content, v);
      lastSentVersion = v;
    } catch {
      // 静默：下次再试
    }
  }

  function scheduleDidChange(): void {
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      changeTimer = null;
      if (detached) return;
      void flushPendingChanges();
    }, debounceMs);
  }

  function onDiagnostics(diags: LspDiag[]): void {
    if (!view || detached) return;
    const doc = view.state.doc;
    const positioned = diags.map((d) => lspDiagToPositioned(d, doc));
    view.dispatch(setDiagnostics(view.state, positioned));
  }

  const completionSource: CompletionSource = async (
    ctx: CompletionContext,
  ): Promise<CompletionResult | null> => {
    if (detached) return null;
    const word = ctx.matchBefore(/[\w$]*/u);
    // 非显式触发且不在词中 → 不打扰
    if (!ctx.explicit && (!word || word.from === word.to)) return null;

    try {
      await flushPendingChanges();
      const pos = ctx.pos;
      const line = ctx.state.doc.lineAt(pos);
      const items = await lspBridge.completion(filePath, line.number - 1, pos - line.from);
      if (!items.length) return null;
      return {
        from: word ? word.from : pos,
        options: items.map(
          (item): Completion => ({
            label: item.label,
            detail: item.detail ?? undefined,
            info: item.documentation ?? undefined,
            type: lspKindToType(item.kind),
            apply: item.insertText ?? item.label,
          }),
        ),
        validFor: /^[\w$]*$/u,
      };
    } catch {
      return null;
    }
  };

  const hoverExt = hoverTooltip(async (v, pos): Promise<Tooltip | null> => {
    if (detached) return null;
    try {
      await flushPendingChanges();
      const line = v.state.doc.lineAt(pos);
      const result = await lspBridge.hover(filePath, line.number - 1, pos - line.from);
      if (!result || !result.contents) return null;
      return {
        pos,
        create() {
          const dom = document.createElement('div');
          dom.className = 'cm-lsp-hover';
          // 纯文本兜底；上层可以替换为 markdown 渲染
          dom.textContent = result.contents;
          return { dom };
        },
      };
    } catch {
      return null;
    }
  });

  const viewListener = EditorView.updateListener.of((update: ViewUpdate) => {
    if (!view) view = update.view;
    if (update.docChanged) {
      docVersion++;
      scheduleDidChange();
    }
  });

  const extensions: Extension[] = [
    autocompletion({ override: [completionSource] }),
    hoverExt,
    viewListener,
  ];

  return {
    extensions,
    attach(v: EditorView) {
      view = v;
      detached = false;
      docVersion = 1;
      lastSentVersion = 1;
      unregisterDiag = lspBridge.registerFile(filePath, onDiagnostics);
      // didOpen 必须先发；完成后再允许 didChange
      void lspBridge
        .didOpen(filePath, getContent(), languageId)
        .catch(() => {
          /* 失败让 detach 收尾 */
        });
    },
    detach() {
      detached = true;
      if (changeTimer) {
        clearTimeout(changeTimer);
        changeTimer = null;
      }
      if (unregisterDiag) {
        unregisterDiag();
        unregisterDiag = null;
      }
      void lspBridge.didClose(filePath).catch(() => { });
      view = null;
    },
  };
}
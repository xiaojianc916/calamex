/**
 * LSP ↔ CM6 桥接
 *
 * 把 bash-language-server 的诊断 / 补全 / 悬停接入 CM6。
 *
 * Goals:
 *   - 单一全局 diagnostics 监听 + 按 filePath 分派(多编辑器、同文件多订阅者都安全)
 *   - 监听 Rust 端 `lsp-crashed` 事件,自动切回 stopped 并清屏诊断
 *   - completion / hover 前自动 flush 未发的 didChange,且 flush 串行化
 *   - didOpen → didChange 因果链:didChange/completion/hover 都等 openPromise
 *   - attach / detach 严格成对,双重 attach 自动 detach 旧的,无监听泄漏
 *   - lspBridge.start 自动去重 + HMR 兼容单例
 *   - filePath 跨前后端归一化(POSIX 正斜杠),避免 Windows 反斜杠错配
 */

import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import type { Diagnostic } from '@codemirror/lint';
import { setDiagnostics } from '@codemirror/lint';
import type { Extension, Text } from '@codemirror/state';
import { EditorView, hoverTooltip, type Tooltip, type ViewUpdate } from '@codemirror/view';
import type { UnlistenFn } from '@tauri-apps/api/event';

// 懒加载 Shiki（避免阻塞编辑器初始化）
type ShikiMod = typeof import('@/services/editor/shiki');
let shikiModPromise: Promise<ShikiMod> | null = null;
function getShikiMod(): Promise<ShikiMod> {
  shikiModPromise ??= import('@/services/editor/shiki');
  return shikiModPromise;
}

// ============================================================================
// Tauri IPC(懒加载,避免 SSR / 测试环境炸)
// ============================================================================
type TauriCore = typeof import('@tauri-apps/api/core');
type TauriEvent = typeof import('@tauri-apps/api/event');
let corePromise: Promise<TauriCore> | null = null;
let eventPromise: Promise<TauriEvent> | null = null;

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  corePromise ??= import('@tauri-apps/api/core');
  const core = await corePromise;
  return core.invoke<T>(cmd, args);
}
async function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  eventPromise ??= import('@tauri-apps/api/event');
  const ev = await eventPromise;
  return ev.listen<T>(event, (e) => handler(e.payload));
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
interface LspCrashedEvent {
  exitStatus?: string;
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
// 路径归一化
// ============================================================================
/**
 * 统一前后端 filePath 表示:去掉 Windows 扩展路径前缀,全部用正斜杠。
 *
 * Windows 上 Tauri 可能返回 `\\?\D:\workspace\test.sh` 这样的
 * 扩展路径(extended-length path)。`\\?\` 前缀在 Rust 的
 * path_to_uri → uri_to_path 往返中会被错误截断,导致前后端路径不一致。
 * 这里统一剥掉前缀再归一化。
 */
function normalizePath(p: string): string {
  // 去掉 Windows 扩展路径前缀 \\?\ 或 \\.\ (含正斜杠变体)
  let cleaned = p;
  if (cleaned.startsWith('\\\\?\\UNC\\')) {
    cleaned = '\\\\' + cleaned.slice('\\\\?\\UNC\\'.length);
  } else if (cleaned.startsWith('\\\\?\\') || cleaned.startsWith('\\\\.\\')) {
    cleaned = cleaned.slice('\\\\?\\'.length);
  } else if (cleaned.startsWith('//?/UNC/')) {
    cleaned = '//' + cleaned.slice('//?/UNC/'.length);
  } else if (cleaned.startsWith('//?/') || cleaned.startsWith('//./')) {
    cleaned = cleaned.slice('//?/'.length);
  }
  return cleaned.replace(/\\/g, '/');
}

// ============================================================================
// Bridge 单例
// ============================================================================
type FileHandler = (diags: LspDiag[]) => void;
export type BridgeStateEvent =
  | { type: 'started' }
  | { type: 'stopped' }
  | { type: 'crashed'; exitStatus?: string };
export type BridgeStateListener = (e: BridgeStateEvent) => void;

interface PendingDidOpen {
  filePath: string;
  content: string;
  languageId: string;
}

class LspBridge {
  private started = false;
  private startPromise: Promise<void> | null = null;
  private unlistenDiagnostics: UnlistenFn | null = null;
  private unlistenCrashed: UnlistenFn | null = null;
  /** 同一文件可有多个订阅者(diff 视图、并排编辑等场景) */
  private fileHandlers = new Map<string, Set<FileHandler>>();
  /** 启动前到达的 didOpen,按 filePath 去重,后写覆盖 */
  private pendingOps = new Map<string, PendingDidOpen>();
  private stateListeners = new Set<BridgeStateListener>();

  async start(workspaceRoot: string): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      // 先建监听,避免 didOpen → 第一波诊断丢失
      this.unlistenDiagnostics = await tauriListen<LspDiagEvent>('lsp-diagnostics', (e) => {
        const key = normalizePath(e.filePath);
        const handlers = this.fileHandlers.get(key);
        console.log(
          `[lsp] diagnostics event: filePath=${key} diags=${e.diagnostics.length} handlers=${handlers?.size ?? 0}`,
        );
        if (!handlers) return;
        for (const h of handlers) {
          try {
            h(e.diagnostics);
          } catch (err) {
            console.warn('[lsp-bridge] diagnostics handler error', err);
          }
        }
      });
      this.unlistenCrashed = await tauriListen<LspCrashedEvent>('lsp-crashed', (payload) => {
        this.onBackendCrashed(payload?.exitStatus);
      });

      try {
        console.log('[lsp] invoking lsp_start with workspaceRoot:', workspaceRoot);
        await tauriInvoke<void>('lsp_start', { workspaceRoot });
        this.started = true;
        console.log('[lsp] lsp_start succeeded, started=true');
        this.emitState({ type: 'started' });
        await this.flushPendingOps();
      } catch (err) {
        console.error('[lsp] lsp_start FAILED:', err);
        this.tearDownListeners();
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
    // 如果还在 start,等它结束(成功或失败)再 stop
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        /* ignore */
      }
    }
    if (!this.started && !this.unlistenDiagnostics && !this.unlistenCrashed) return;

    this.started = false;
    this.pendingOps.clear();
    this.clearAllDiagnostics();
    this.fileHandlers.clear();
    this.tearDownListeners();
    try {
      await tauriInvoke<void>('lsp_stop');
    } catch (err) {
      console.warn('[lsp-bridge] lsp_stop invoke failed', err);
    } finally {
      this.emitState({ type: 'stopped' });
    }
  }

  isStarted(): boolean {
    return this.started;
  }

  /** 订阅 bridge 状态变化(started / stopped / crashed) */
  onStateChange(listener: BridgeStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /** 注册按文件的诊断 handler,返回解注册函数。同一文件可注册多个 handler。 */
  registerFile(filePath: string, handler: FileHandler): () => void {
    const key = normalizePath(filePath);
    console.log(`[lsp] registerFile: key=${key}`);
    let set = this.fileHandlers.get(key);
    if (!set) {
      set = new Set();
      this.fileHandlers.set(key, set);
    }
    set.add(handler);
    return () => {
      const s = this.fileHandlers.get(key);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) this.fileHandlers.delete(key);
    };
  }

  async didOpen(filePath: string, content: string, languageId: string): Promise<void> {
    const key = normalizePath(filePath);
    if (this.startPromise) {
      console.log(`[lsp] didOpen WAITING for start: key=${key}`);
      try {
        await this.startPromise;
      } catch {
        console.log(`[lsp] didOpen start FAILED, aborting: key=${key}`);
        return;
      }
    }
    if (this.started) {
      console.log(`[lsp] didOpen SENDING: key=${key} lang=${languageId} len=${content.length}`);
      await tauriInvoke<void>('lsp_did_open', { filePath: key, content, languageId });
      return;
    }
    console.log(`[lsp] didOpen QUEUED: key=${key}`);
    this.pendingOps.set(key, { filePath: key, content, languageId });
  }

  /** @returns 是否真正发送出去(false = 当前未启动,调用方应自行处理重发) */
  async didChange(filePath: string, content: string, version: number): Promise<boolean> {
    if (!this.started) return false;
    await tauriInvoke<void>('lsp_did_change', {
      filePath: normalizePath(filePath),
      content,
      version,
    });
    return true;
  }

  async didClose(filePath: string): Promise<void> {
    const key = normalizePath(filePath);
    this.pendingOps.delete(key);
    if (!this.started) return;
    await tauriInvoke<void>('lsp_did_close', { filePath: key });
  }

  async completion(filePath: string, line: number, column: number): Promise<LspItem[]> {
    if (!this.started) return [];
    return tauriInvoke<LspItem[]>('lsp_completion', {
      filePath: normalizePath(filePath),
      line,
      column,
    });
  }

  async hover(filePath: string, line: number, column: number): Promise<LspHover | null> {
    if (!this.started) return null;
    return tauriInvoke<LspHover | null>('lsp_hover', {
      filePath: normalizePath(filePath),
      line,
      column,
    });
  }

  // --- 内部 ----------------------------------------------------------------

  private tearDownListeners() {
    this.unlistenDiagnostics?.();
    this.unlistenDiagnostics = null;
    this.unlistenCrashed?.();
    this.unlistenCrashed = null;
  }

  private clearAllDiagnostics() {
    for (const handlers of this.fileHandlers.values()) {
      for (const h of handlers) {
        try {
          h([]);
        } catch (err) {
          console.warn('[lsp-bridge] clear handler error', err);
        }
      }
    }
  }

  private onBackendCrashed(exitStatus?: string) {
    if (!this.started) return;
    this.started = false;
    // 不清空 fileHandlers——编辑器可能想保留监听等候自动重启
    this.clearAllDiagnostics();
    this.emitState({ type: 'crashed', exitStatus });
  }

  private async flushPendingOps(): Promise<void> {
    const ops = Array.from(this.pendingOps.values());
    this.pendingOps.clear();
    for (const op of ops) {
      try {
        await tauriInvoke<void>('lsp_did_open', {
          filePath: op.filePath,
          content: op.content,
          languageId: op.languageId,
        });
      } catch (err) {
        console.warn('[lsp-bridge] replay didOpen failed', op.filePath, err);
      }
    }
  }

  private emitState(e: BridgeStateEvent) {
    for (const l of this.stateListeners) {
      try {
        l(e);
      } catch (err) {
        console.warn('[lsp-bridge] state listener error', err);
      }
    }
  }
}

// HMR / SSR 安全的全局单例:Vite 热更新不会复制 bridge,避免监听泄漏。
declare global {
  // eslint-disable-next-line no-var
  var __lspBridge__: LspBridge | undefined;
}
export const lspBridge: LspBridge = (globalThis.__lspBridge__ ??= new LspBridge());

// --- 兼容旧的命名导出 -------------------------------------------------------
/** @deprecated 用 `lspBridge.start(...)` */
export const lspStartBridge = (workspaceRoot: string) => lspBridge.start(workspaceRoot);
/** @deprecated 用 `lspBridge.stop()` */
export const lspStopBridge = () => lspBridge.stop();
/** @deprecated 用 `lspBridge.didOpen(...)` */
export const lspDidOpenBridge = (f: string, c: string, l: string) => lspBridge.didOpen(f, c, l);
/** @deprecated 用 `lspBridge.didChange(...)` */
export const lspDidChangeBridge = (f: string, c: string, v: number) =>
  lspBridge.didChange(f, c, v).then(() => undefined);
/** @deprecated 用 `lspBridge.didClose(...)` */
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
    case 4:
      return 'hint';
    default:
      // 与 Rust 侧对齐:缺省视为 Error
      return 'error';
  }
}
function lspKindToType(kind: number | null): string {
  // LSP CompletionItemKind 1..=25 → CM6 type 字符串(只覆盖 bash 常见)
  switch (kind) {
    case 1:
      return 'text';
    case 2:
      return 'method';
    case 3:
      return 'function';
    case 4:
      return 'function'; // Constructor
    case 5:
      return 'property'; // Field
    case 6:
      return 'variable';
    case 7:
      return 'class';
    case 8:
      return 'interface';
    case 9:
      return 'namespace'; // Module
    case 10:
      return 'property';
    case 11:
      return 'constant'; // Unit
    case 12:
      return 'constant'; // Value
    case 13:
      return 'enum';
    case 14:
      return 'keyword';
    case 15:
      return 'text'; // Snippet
    case 17:
      return 'text'; // File
    case 21:
      return 'constant';
    default:
      return 'text';
  }
}

// bash 标识符包含 `-`(命令名)和 `$`(变量)。
const BASH_IDENT_RE = /[\w$-]*/u;
const BASH_IDENT_VALID_FOR = /^[\w$-]*$/u;

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
// Markdown → HTML 轻量渲染（LSP 文档专用）
// ============================================================================

/**
 * 把 bash-language-server 返回的 man-page 风格 markdown 转成 HTML。
 * 支持 ```lang 代码块（用 Shiki 高亮）、行内代码、段落。
 * 所有异常内部消化，确保始终返回合法的 HTML 字符串。
 */
async function renderLspDoc(md: string): Promise<string> {
  try {
    // 统一换行符，避免 Windows \r\n 导致正则不匹配
    const normalized = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 分离代码块和普通文本
    const parts: Array<
      { type: 'code'; lang: string; code: string } | { type: 'text'; text: string }
    > = [];
    const codeBlockRe = /```(\S*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = codeBlockRe.exec(normalized)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', text: normalized.slice(lastIndex, match.index) });
      }
      parts.push({
        type: 'code',
        lang: match[1] || 'bash',
        code: match[2].replace(/\n$/, ''),
      });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < normalized.length) {
      parts.push({ type: 'text', text: normalized.slice(lastIndex) });
    }

    // 如果没有任何代码块也没有文本 → 兜底：整个内容按文本段落渲染
    if (parts.length === 0 && normalized.trim()) {
      parts.push({ type: 'text', text: normalized });
    }

    // 渲染各部分
    const rendered: string[] = [];
    for (const part of parts) {
      if (part.type === 'code') {
        rendered.push(await renderCodeBlock(part.lang, part.code));
      } else {
        rendered.push(renderTextBlock(part.text));
      }
    }
    return rendered.join('') || escapeHtml(normalized);
  } catch (err) {
    console.warn('[lsp] renderLspDoc failed', err);
    // 最终兜底：转义后展示纯文本
    return `<pre class="cm-lsp-code-block"><code>${escapeHtml(md)}</code></pre>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderTextBlock(text: string): string {
  // 段落分割
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return '';

  return paragraphs
    .map((p) => {
      // 行内代码
      const withInlineCode = p.replace(
        /`([^`]+)`/g,
        '<code class="cm-lsp-inline-code">$1</code>',
      );
      return `<p class="cm-lsp-para">${withInlineCode}</p>`;
    })
    .join('');
}

async function renderCodeBlock(lang: string, code: string): Promise<string> {
  try {
    const shiki = await getShikiMod();
    const hl = shiki.getShikiHighlighter();
    const shikiLang = lang ? shiki.toShikiLanguage(lang) : null;

    if (hl && shikiLang) {
      await shiki.ensureShikiLanguageLoaded(shikiLang);
      const html = hl.codeToHtml(code, { lang: shikiLang, theme: 'dark-plus' });
      return `<div class="cm-lsp-code-block">${html}</div>`;
    }
  } catch {
    // Shiki 不可用时优雅降级
  }
  // 降级：纯文本代码块
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<pre class="cm-lsp-code-block"><code>${escaped}</code></pre>`;
}

// ============================================================================
// 补全详情面板构建
// ============================================================================

function lspKindLabel(kind: number | null): string {
  switch (kind) {
    case 1: return '文本';
    case 2: return '方法';
    case 3: return '函数';
    case 6: return '变量';
    case 9: return '模块';
    case 14: return '关键字';
    case 15: return '代码片段';
    default: return kind ? `kind ${kind}` : '';
  }
}

function highlightSnippetPlaceholders(snippet: string): string {
  return snippet.replace(
    /\$\{(\d+):([^}]+)\}/g,
    '<span class="cm-lsp-ph">$2</span>',
  ).replace(
    /\$(\d+)/g,
    '<span class="cm-lsp-ph">$$1</span>',
  );
}

function buildCompletionInfoPanel(item: LspItem): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'cm-lsp-info';

  const kindLabel = lspKindLabel(item.kind);
  const snippetHtml = item.insertText
    ? highlightSnippetPlaceholders(escapeHtml(item.insertText))
    : '';

  dom.innerHTML = `
    <div class="cm-lsp-info-head">
      <span class="cm-lsp-info-title">${escapeHtml(item.label)}</span>
      ${kindLabel ? `<span class="cm-lsp-info-tag">${kindLabel}</span>` : ''}
      <span class="cm-lsp-info-tag">bash-language-server</span>
    </div>
    ${item.detail ? `<p class="cm-lsp-info-detail">${escapeHtml(item.detail)}</p>` : ''}
    ${item.documentation ? `<div class="cm-lsp-info-doc"></div>` : ''}
    ${snippetHtml ? `<pre class="cm-lsp-info-snippet"><code>${snippetHtml}</code></pre>` : ''}
    <div class="cm-lsp-info-foot">
      <span>${snippetHtml ? 'Tab 切换占位 · ' : ''}Enter 插入</span>
    </div>`;

  // 异步渲染 markdown 文档
  if (item.documentation) {
    const docEl = dom.querySelector('.cm-lsp-info-doc')!;
    renderLspDoc(item.documentation).then((html) => {
      docEl.innerHTML = html;
    }).catch(() => {});
  }

  // CM6 补全信息面板有内置 max-width，去掉
  requestAnimationFrame(() => {
    const info = dom.closest('.cm-completionInfo') as HTMLElement | null;
    if (info) info.style.maxWidth = 'none';
  });

  return dom;
}

// ============================================================================
// CM6 Extension 工厂
// ============================================================================
export interface LspExtensionOptions {
  filePath: string;
  languageId: string; // e.g. "shellscript"
  /** 取当前最新内容;调用方负责其安全性 */
  getContent: () => string;
  /** didChange debounce 毫秒;默认 200 */
  changeDebounceMs?: number;
  /** 内部失败时的回调(IPC 失败、解析失败等)。默认 console.warn */
  onError?: (err: unknown) => void;
}

export interface LspExtensionHandle {
  extensions: Extension[];
  /** LSP 补全源,合并到上层 autocompletion 的 override 列表中避免冲突 */
  completionSource: CompletionSource;
  attach(view: EditorView): void;
  detach(): void;
}

export function createLspExtension(opts: LspExtensionOptions): LspExtensionHandle {
  const { filePath, languageId, getContent } = opts;
  const debounceMs = opts.changeDebounceMs ?? 200;
  const onError = opts.onError ?? ((err) => console.warn('[lsp-extension]', err));

  let view: EditorView | null = null;
  let attached = false;
  let detached = false;
  let unregisterDiag: (() => void) | null = null;

  // 版本号 1 与 Rust didOpen 的 version=1 对齐;didChange 起步用 2。
  let docVersion = 1;
  let lastSentVersion = 1;
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  let openPromise: Promise<void> | null = null;
  let flushInFlight: Promise<void> | null = null;

  function cancelTimer() {
    if (changeTimer) {
      clearTimeout(changeTimer);
      changeTimer = null;
    }
  }

  /** 单次实际发送 */
  async function doFlush(): Promise<void> {
    // didChange 必须排在 didOpen 之后,否则 bash-ls 会忽略
    if (openPromise) {
      try {
        await openPromise;
      } catch {
        return;
      }
    }
    if (detached) return;
    cancelTimer();
    const v = docVersion;
    // 用 view.state 做权威 snapshot,fallback 到 getContent
    const content = view?.state.doc.toString() ?? getContent();
    try {
      const sent = await lspBridge.didChange(filePath, content, v);
      if (sent) lastSentVersion = v;
    } catch (err) {
      onError(err);
    }
  }

  /** 把还未发的 didChange 同步发出。串行化 + 循环补齐至最新版本。 */
  async function flushPendingChanges(): Promise<void> {
    if (detached) return;
    while (!detached && lastSentVersion !== docVersion) {
      if (flushInFlight) {
        try {
          await flushInFlight;
        } catch {
          /* swallow, 下一轮重试 */
        }
        continue;
      }
      const prev = lastSentVersion;
      flushInFlight = doFlush();
      try {
        await flushInFlight;
      } finally {
        flushInFlight = null;
      }
      if (lastSentVersion === prev) {
        // 没推进 → LSP 不可用或失败,退出避免死循环
        break;
      }
    }
  }

  function scheduleDidChange(): void {
    cancelTimer();
    changeTimer = setTimeout(() => {
      changeTimer = null;
      if (detached) return;
      void flushPendingChanges();
    }, debounceMs);
  }

  function onDiagnostics(diags: LspDiag[]): void {
    if (!view || detached) return;
    // 空诊断不覆盖 ShellCheck 的结果
    if (diags.length === 0) return;
    const doc = view.state.doc;
    const positioned = diags.map((d) => lspDiagToPositioned(d, doc));
    view.dispatch(setDiagnostics(view.state, positioned));
  }

  const completionSource: CompletionSource = async (
    ctx: CompletionContext,
  ): Promise<CompletionResult | null> => {
    if (detached) return null;
    const word = ctx.matchBefore(BASH_IDENT_RE);
    if (!ctx.explicit && (!word || word.from === word.to)) return null;

    try {
      await flushPendingChanges();
      if (detached) return null;
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
            info: () => buildCompletionInfoPanel(item),
            type: lspKindToType(item.kind),
            apply: item.insertText ?? item.label,
          }),
        ),
        validFor: BASH_IDENT_VALID_FOR,
      };
    } catch (err) {
      onError(err);
      return null;
    }
  };

  const hoverExt = hoverTooltip(async (v, pos): Promise<Tooltip | null> => {
    if (detached) return null;
    try {
      await flushPendingChanges();
      if (detached) return null;
      const line = v.state.doc.lineAt(pos);
      const result = await lspBridge.hover(filePath, line.number - 1, pos - line.from);
      if (!result?.contents) return null;
      // 异步渲染 markdown → HTML（Shiki 代码高亮）
      const html = await renderLspDoc(result.contents);
      return {
        pos,
        create() {
          const dom = document.createElement('div');
          dom.className = 'cm-lsp-hover';
          dom.innerHTML = html;
          // CM6 的 tooltip wrapper 有内置 max-width，去掉
          requestAnimationFrame(() => {
            const tooltip = dom.closest('.cm-tooltip') as HTMLElement | null;
            if (tooltip) tooltip.style.maxWidth = 'none';
          });
          return { dom };
        },
      };
    } catch (err) {
      onError(err);
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

  const extensions: Extension[] = [hoverExt, viewListener];

  function detachInternal() {
    detached = true;
    attached = false;
    cancelTimer();
    flushInFlight = null;
    openPromise = null;
    if (unregisterDiag) {
      unregisterDiag();
      unregisterDiag = null;
    }
    void lspBridge.didClose(filePath).catch((err) => onError(err));
    view = null;
  }

  return {
    extensions,
    /** LSP 补全源，调用方应将其合并到自有 autocompletion 的 override 列表中 */
    completionSource,
    attach(v: EditorView) {
      // 双重 attach 守卫:先把旧的拆掉
      if (attached) detachInternal();
      attached = true;
      detached = false;
      view = v;
      docVersion = 1;
      lastSentVersion = 1;
      flushInFlight = null;
      unregisterDiag = lspBridge.registerFile(filePath, onDiagnostics);
      openPromise = lspBridge.didOpen(filePath, getContent(), languageId).catch((err) => {
        onError(err);
      });
    },
    detach() {
      detachInternal();
    },
  };
}

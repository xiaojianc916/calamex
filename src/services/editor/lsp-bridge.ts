/**
 * LSP ↔ CM6 桥接
 *
 * 把 bash-language-server 的诊断 / 补全 / 悬停接入 CM6。
 *
 * Goals:
 *   - 单一全局 diagnostics 监听 + 按 filePath 分派(多编辑器、同文件多订阅者都安全)
 *   - 监听 Rust 端 `lsp-crashed` 事件，自动切回 stopped 并清屏诊断
 *   - completion / hover 前自动 flush 未发的 didChange，且 flush 串行化
 *   - didOpen → didChange 因果链:didChange/completion/hover 都等 openPromise
 *   - attach / detach 严格成对，双重 attach 自动 detach 旧的，无监听泄漏
 *   - lspBridge.start 自动去重 + HMR 兼容单例
 *   - filePath 跨前后端归一化(POSIX 正斜杠)，避免 Windows 反斜杠错配
 *   - 跟踪已打开文档，崩溃自动重启后重放 didOpen，恢复诊断/补全
 *   - 诊断不自行 dispatch，交由上层与 ShellCheck 合并为单一来源(见 createLspExtension 的 onDiagnostics)
 */

import { highlightCodeToHtml } from "@/services/editor/codemirror-static-highlight";
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import type { Diagnostic } from "@codemirror/lint";
import { setDiagnostics } from "@codemirror/lint";
import type { Extension, Text } from "@codemirror/state";
import {
  EditorView,
  hoverTooltip,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import type { UnlistenFn } from "@tauri-apps/api/event";

export const lspCompletionTheme = EditorView.theme({}, {});

// ============================================================================
// Lucide SVG 图标（补全种类图标）
// ============================================================================
const LUCIDE_PATHS: Record<string, string> = {
  // square-function — 命令 / 函数
  function:
    "M17.5 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11ZM9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3M9 11h5.7",
  // key-round — 关键字
  keyword: "m15 15-6 6v-4H4v-4h2v-2a6 6 0 0 1 6-6h3v4h-3a2 2 0 0 0-2 2v2h5Z",
  // braces — 变量
  variable: "M8 21s-4-3-4-9 4-9 4-9m8 0s4 3 4 9-4 9-4 9M5 12h14",
  // tag — 选项 / 属性
  property:
    "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42zM7.5 7.5h.01",
  // hash — 常量 / 取值
  constant: "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18",
  // box — 类型 / 类
  class:
    "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16ZM3.3 7l8.7 5 8.7-5M12 22V12",
  // list — 枚举
  enum: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  // chevrons — 运算符
  operator: "M18 7V5a1 1 0 0 0-1-1H7l6 8-6 8h10a1 1 0 0 0 1-1v-2",
  // braces — 代码片段
  snippet:
    "M8 3H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4c0 1.1.9 2 2 2h2M16 21h2a2 2 0 0 0 2-2v-4c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-2",
  // align-left — 普通文本(不再用 'T' 字形)
  text: "M15 12H3M17 6H3M21 18H3",
};

// 把 LSP 的细分种类归并到上面已有图标
const TYPE_ICON_ALIASES: Record<string, string> = {
  method: "function",
  constructor: "function",
  interface: "class",
  namespace: "class",
  module: "class",
  enumMember: "constant",
  value: "constant",
  field: "property",
  type: "keyword",
};

function cm6TypeToLucide(type: string): string {
  const resolved = TYPE_ICON_ALIASES[type] ?? type;
  return LUCIDE_PATHS[resolved] ?? LUCIDE_PATHS.text;
}

export function createLucideCompletionIcon(type: string): HTMLElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", cm6TypeToLucide(type));
  svg.appendChild(path);
  const wrapper = document.createElement("span");
  wrapper.className = "cm-lsp-icon";
  wrapper.setAttribute("data-type", type);
  wrapper.appendChild(svg);
  return wrapper;
}

// ============================================================================
// Tauri IPC(懒加载，避免 SSR / 测试环境炸)
// ============================================================================
type TauriCore = typeof import("@tauri-apps/api/core");
type TauriEvent = typeof import("@tauri-apps/api/event");
let corePromise: Promise<TauriCore> | null = null;
let eventPromise: Promise<TauriEvent> | null = null;

async function tauriInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  corePromise ??= import("@tauri-apps/api/core");
  const core = await corePromise;
  return core.invoke<T>(cmd, args);
}
async function tauriListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  eventPromise ??= import("@tauri-apps/api/event");
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
 * 统一前后端 filePath 表示:去掉 Windows 扩展路径前缀，全部用正斜杠。
 *
 * Windows 上 Tauri 可能返回 `\\?\D:\workspace\test.sh` 这样的
 * 扩展路径(extended-length path)。`\\?\` 前缀在 Rust 的
 * path_to_uri → uri_to_path 往返中会被错误截断，导致前后端路径不一致。
 * 这里统一剥掉前缀再归一化。
 */
function normalizePath(p: string): string {
  // 去掉 Windows 扩展路径前缀 \\?\ 或 \\.\ (含正斜杠变体)
  let cleaned = p;
  if (cleaned.startsWith("\\\\?\\UNC\\")) {
    cleaned = "\\\\" + cleaned.slice("\\\\?\\UNC\\".length);
  } else if (cleaned.startsWith("\\\\?\\") || cleaned.startsWith("\\\\.\\")) {
    cleaned = cleaned.slice("\\\\?\\".length);
  } else if (cleaned.startsWith("//?/UNC/")) {
    cleaned = "//" + cleaned.slice("//?/UNC/".length);
  } else if (cleaned.startsWith("//?/") || cleaned.startsWith("//./")) {
    cleaned = cleaned.slice("//?/".length);
  }
  return cleaned.replace(/\\/g, "/");
}

// ============================================================================
// Bridge 单例
// ============================================================================
type FileHandler = (diags: LspDiag[]) => void;
export type BridgeStateEvent =
  | { type: "started" }
  | { type: "stopped" }
  | { type: "crashed"; exitStatus?: string };
export type BridgeStateListener = (e: BridgeStateEvent) => void;

interface OpenDocument {
  filePath: string;
  content: string;
  languageId: string;
  version: number;
}

class LspBridge {
  private started = false;
  private startPromise: Promise<void> | null = null;
  private unlistenDiagnostics: UnlistenFn | null = null;
  private unlistenCrashed: UnlistenFn | null = null;
  /** 同一文件可有多个订阅者(diff 视图、并排编辑等场景) */
  private fileHandlers = new Map<string, Set<FileHandler>>();
  /**
   * 已打开文档的最新快照，按 filePath 去重。用于:
   *  1) 启动前到达的 didOpen 排队;
   *  2) 崩溃自动重启后重放 didOpen，恢复服务端文档状态。
   */
  private openDocuments = new Map<string, OpenDocument>();
  private stateListeners = new Set<BridgeStateListener>();

  async start(workspaceRoot: string): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      // 幂等:重启(尤其崩溃后)前先拆掉可能残留的监听，避免重复注册导致泄漏
      this.tearDownListeners();
      // 先建监听，避免 didOpen → 第一波诊断丢失
      this.unlistenDiagnostics = await tauriListen<LspDiagEvent>(
        "lsp-diagnostics",
        (e) => {
          const key = normalizePath(e.filePath);
          const handlers = this.fileHandlers.get(key);
          if (!handlers) return;
          for (const h of handlers) {
            try {
              h(e.diagnostics);
            } catch (err) {
              console.warn("[lsp-bridge] diagnostics handler error", err);
            }
          }
        },
      );
      this.unlistenCrashed = await tauriListen<LspCrashedEvent>(
        "lsp-crashed",
        (payload) => {
          this.onBackendCrashed(payload?.exitStatus);
        },
      );

      try {
        await tauriInvoke<void>("lsp_start", { workspaceRoot });
        this.started = true;
        this.emitState({ type: "started" });
        await this.replayOpenDocuments();
      } catch (err) {
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
    // 如果还在 start，等它结束(成功或失败)再 stop
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        /* ignore */
      }
    }
    if (!this.started && !this.unlistenDiagnostics && !this.unlistenCrashed)
      return;

    this.started = false;
    // 主动停止 = 彻底遗忘已打开文档(与崩溃区别:崩溃保留以便重放)
    this.openDocuments.clear();
    this.clearAllDiagnostics();
    this.fileHandlers.clear();
    this.tearDownListeners();
    try {
      await tauriInvoke<void>("lsp_stop");
    } catch (err) {
      console.warn("[lsp-bridge] lsp_stop invoke failed", err);
    } finally {
      this.emitState({ type: "stopped" });
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

  /** 注册按文件的诊断 handler，返回解注册函数。同一文件可注册多个 handler。 */
  registerFile(filePath: string, handler: FileHandler): () => void {
    const key = normalizePath(filePath);
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

  async didOpen(
    filePath: string,
    content: string,
    languageId: string,
  ): Promise<void> {
    const key = normalizePath(filePath);
    // 记录最新快照:崩溃重启重放、启动前排队都依赖它
    this.openDocuments.set(key, {
      filePath: key,
      content,
      languageId,
      version: 1,
    });
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        return;
      }
    }
    if (this.started) {
      await tauriInvoke<void>("lsp_did_open", {
        filePath: key,
        content,
        languageId,
      });
    }
    // 未启动:已记入 openDocuments，待 start 成功后由 replayOpenDocuments 重放
  }

  /** @returns 是否真正发送出去(false = 当前未启动，调用方应自行处理重发) */
  async didChange(
    filePath: string,
    content: string,
    version: number,
  ): Promise<boolean> {
    const key = normalizePath(filePath);
    const doc = this.openDocuments.get(key);
    if (doc) {
      doc.content = content;
      doc.version = version;
    }
    if (!this.started) return false;
    await tauriInvoke<void>("lsp_did_change", {
      filePath: key,
      content,
      version,
    });
    return true;
  }

  async didClose(filePath: string): Promise<void> {
    const key = normalizePath(filePath);
    this.openDocuments.delete(key);
    if (!this.started) return;
    await tauriInvoke<void>("lsp_did_close", { filePath: key });
  }

  async completion(
    filePath: string,
    line: number,
    column: number,
  ): Promise<LspItem[]> {
    if (!this.started) return [];
    return tauriInvoke<LspItem[]>("lsp_completion", {
      filePath: normalizePath(filePath),
      line,
      column,
    });
  }

  async hover(
    filePath: string,
    line: number,
    column: number,
  ): Promise<LspHover | null> {
    if (!this.started) return null;
    return tauriInvoke<LspHover | null>("lsp_hover", {
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
          console.warn("[lsp-bridge] clear handler error", err);
        }
      }
    }
  }

  private onBackendCrashed(exitStatus?: string) {
    if (!this.started) return;
    this.started = false;
    // 保留 fileHandlers 与 openDocuments——自动重启后可重放 didOpen 并继续接收诊断
    this.clearAllDiagnostics();
    this.emitState({ type: "crashed", exitStatus });
  }

  /** 向(重新)启动的服务重放所有已打开文档的最新内容，恢复服务端文档状态。 */
  private async replayOpenDocuments(): Promise<void> {
    const docs = Array.from(this.openDocuments.values());
    for (const doc of docs) {
      try {
        await tauriInvoke<void>("lsp_did_open", {
          filePath: doc.filePath,
          content: doc.content,
          languageId: doc.languageId,
        });
      } catch (err) {
        console.warn("[lsp-bridge] replay didOpen failed", doc.filePath, err);
      }
    }
  }

  private emitState(e: BridgeStateEvent) {
    for (const l of this.stateListeners) {
      try {
        l(e);
      } catch (err) {
        console.warn("[lsp-bridge] state listener error", err);
      }
    }
  }
}

// HMR / SSR 安全的全局单例:Vite 热更新不会复制 bridge，避免监听泄漏。
declare global {
  // eslint-disable-next-line no-var
  var __lspBridge__: LspBridge | undefined;
}
export const lspBridge: LspBridge = (globalThis.__lspBridge__ ??=
  new LspBridge());

// --- 兼容旧的命名导出 -------------------------------------------------------
/** @deprecated 用 `lspBridge.start(...)` */
export const lspStartBridge = (workspaceRoot: string) =>
  lspBridge.start(workspaceRoot);
/** @deprecated 用 `lspBridge.stop()` */
export const lspStopBridge = () => lspBridge.stop();
/** @deprecated 用 `lspBridge.didOpen(...)` */
export const lspDidOpenBridge = (f: string, c: string, l: string) =>
  lspBridge.didOpen(f, c, l);
/** @deprecated 用 `lspBridge.didChange(...)` */
export const lspDidChangeBridge = (f: string, c: string, v: number) =>
  lspBridge.didChange(f, c, v).then(() => undefined);
/** @deprecated 用 `lspBridge.didClose(...)` */
export const lspDidCloseBridge = (f: string) => lspBridge.didClose(f);

// ============================================================================
// 严重度 / 种类映射
// ============================================================================
function severityToCm6(sev: number): "error" | "warning" | "info" | "hint" {
  switch (sev) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      // 与 Rust 侧对齐:缺省视为 Error
      return "error";
  }
}
function lspKindToType(kind: number | null): string {
  // LSP CompletionItemKind 1..=25 → CM6 type 字符串(只覆盖 bash 常见)
  switch (kind) {
    case 1:
      return "text";
    case 2:
      return "method";
    case 3:
      return "function";
    case 4:
      return "function"; // Constructor
    case 5:
      return "property"; // Field
    case 6:
      return "variable";
    case 7:
      return "class";
    case 8:
      return "interface";
    case 9:
      return "namespace"; // Module
    case 10:
      return "property";
    case 11:
      return "constant"; // Unit
    case 12:
      return "constant"; // Value
    case 13:
      return "enum";
    case 14:
      return "keyword";
    case 15:
      return "snippet"; // Snippet
    case 17:
      return "text"; // File
    case 21:
      return "constant";
    default:
      return "text";
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
    source: d.code ?? d.source ?? "bash-language-server",
  };
}

// ============================================================================
// Markdown → HTML 轻量渲染（LSP 文档专用）
// ============================================================================

/**
 * 把 bash-language-server 返回的 man-page 风格 markdown 转成 HTML。
 * 支持 ```lang 代码块（用 CodeMirror/Lezer 静态高亮）、行内代码、段落。
 * 所有异常内部消化，确保始终返回合法的 HTML 字符串。
 */
async function renderLspDoc(md: string): Promise<string> {
  try {
    // 统一换行符，避免 Windows \r\n 导致正则不匹配
    const normalized = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // 分离代码块和普通文本
    const parts: Array<
      | { type: "code"; lang: string; code: string }
      | { type: "text"; text: string }
    > = [];
    const codeBlockRe = /```(\S*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = codeBlockRe.exec(normalized)) !== null) {
      if (match.index > lastIndex) {
        parts.push({
          type: "text",
          text: normalized.slice(lastIndex, match.index),
        });
      }
      parts.push({
        type: "code",
        lang: match[1] || "bash",
        code: match[2].replace(/\n$/, ""),
      });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < normalized.length) {
      parts.push({ type: "text", text: normalized.slice(lastIndex) });
    }

    // 如果没有任何代码块也没有文本 → 兜底：整个内容按文本段落渲染
    if (parts.length === 0 && normalized.trim()) {
      parts.push({ type: "text", text: normalized });
    }

    // 渲染各部分
    const rendered: string[] = [];
    for (const part of parts) {
      if (part.type === "code") {
        rendered.push(await renderCodeBlock(part.lang, part.code));
      } else {
        rendered.push(renderTextBlock(part.text));
      }
    }
    return rendered.join("") || escapeHtml(normalized);
  } catch (err) {
    console.warn("[lsp] renderLspDoc failed", err);
    // 最终兜底：转义后展示纯文本
    return `<pre class="cm-lsp-code-block"><code>${escapeHtml(md)}</code></pre>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderTextBlock(text: string): string {
  // 段落分割
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return "";

  return paragraphs
    .map((p) => {
      const escaped = escapeHtml(p);
      const withInlineCode = escaped.replace(
        /`([^`]+)`/g,
        '<code class="cm-lsp-inline-code">$1</code>',
      );
      return `<p class="cm-lsp-para">${withInlineCode}</p>`;
    })
    .join("");
}

async function renderCodeBlock(lang: string, code: string): Promise<string> {
  return `<div class="cm-lsp-code-block">${highlightCodeToHtml(code, lang || "bash")}</div>`;
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
  /**
   * 收到该文件的 LSP 诊断时回调(已映射为 CM6 Diagnostic[]，可为空表示清空)。
   * 提供后，扩展不再自行 setDiagnostics —— 由上层把 LSP 与 ShellCheck 等来源
   * 合并为单一诊断集合后统一写入，避免两套来源互相覆盖。
   */
  onDiagnostics?: (diags: Diagnostic[]) => void;
}

export interface LspExtensionHandle {
  extensions: Extension[];
  /** LSP 补全源,合并到上层 autocompletion 的 override 列表中避免冲突 */
  completionSource: CompletionSource;
  attach(view: EditorView): void;
  detach(): void;
}

export function createLspExtension(
  opts: LspExtensionOptions,
): LspExtensionHandle {
  const { filePath, languageId, getContent } = opts;
  const debounceMs = opts.changeDebounceMs ?? 200;
  const onError =
    opts.onError ?? ((err) => console.warn("[lsp-extension]", err));

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
    const doc = view.state.doc;
    const positioned = diags.map((d) => lspDiagToPositioned(d, doc));
    if (opts.onDiagnostics) {
      // 交给上层合并(LSP + ShellCheck → 单一来源);空数组用于清空 LSP 部分
      opts.onDiagnostics(positioned);
      return;
    }
    // 兜底:无上层合并时退回自管理(仍会覆盖其它 lint 来源,故推荐提供 onDiagnostics)
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
      const items = await lspBridge.completion(
        filePath,
        line.number - 1,
        pos - line.from,
      );
      if (!items.length) return null;
      return {
        from: word ? word.from : pos,
        options: items.map(
          (item): Completion => ({
            label: item.label,
            detail: item.detail ?? undefined,
            info: item.documentation
              ? () => {
                const documentation = item.documentation ?? "";
                const dom = document.createElement("div");
                dom.className = "cm-lsp-doc";
                dom.textContent = documentation;
                renderLspDoc(documentation)
                  .then((h) => {
                    dom.innerHTML = h;
                  })
                  .catch(() => { });
                return dom;
              }
              : undefined,
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
      const result = await lspBridge.hover(
        filePath,
        line.number - 1,
        pos - line.from,
      );
      if (!result?.contents) return null;
      // 异步渲染 markdown → HTML（CodeMirror/Lezer 代码高亮）
      const html = await renderLspDoc(result.contents);
      return {
        pos,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-lsp-hover";
          dom.innerHTML = html;
          // CM6 的 tooltip wrapper 有内置 max-width，去掉
          requestAnimationFrame(() => {
            const tooltip = dom.closest(".cm-tooltip") as HTMLElement | null;
            if (tooltip) tooltip.style.maxWidth = "none";
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
      openPromise = lspBridge
        .didOpen(filePath, getContent(), languageId)
        .catch((err) => {
          onError(err);
        });
    },
    detach() {
      detachInternal();
    },
  };
}

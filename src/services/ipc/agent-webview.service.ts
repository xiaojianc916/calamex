import {
  type AgentWebviewBoundsInput,
  type AgentWebviewConsoleEvent,
  type AgentWebviewCreateInput,
  type AgentWebviewElementPickedEvent,
  type AgentWebviewNavigatedEvent,
  type AgentWebviewNavigateInput,
  type AgentWebviewVisibleInput,
  commands,
  events,
} from '@/bindings/tauri';
import { callSpectaCommand } from '@/services/tauri.ipc-runtime';

/**
 * agent 内置浏览器的 CDP 远程调试端口(默认绑 127.0.0.1)。
 *
 * 单一事实来源:前端创建 webview 与 agent-sidecar `connectOverCDP` 必须用同一个端口。
 */
export const AGENT_WEBVIEW_CDP_PORT = 9333;

export type TAgentWebviewBounds = AgentWebviewBoundsInput;
export type TAgentWebviewNavigatedEvent = AgentWebviewNavigatedEvent;
export type TAgentWebviewConsoleEvent = AgentWebviewConsoleEvent;
export type TAgentWebviewElementPickedEvent = AgentWebviewElementPickedEvent;

/** 创建(或复用)内置浏览器子 webview。幂等:已存在则只更新位置/尺寸并导航。 */
export const createAgentWebview = (input: AgentWebviewCreateInput): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'agent_webview_create',
      guardHint: 'create agent webview',
      timeoutMs: 5_000,
      idempotent: true,
      audit: 'info',
      input,
    },
    async ({ traceId }) => {
      await commands.agentWebviewCreate(input, traceId);
    },
  );

/** 同步子 webview 的位置/尺寸。高频调用:audit=none 避免日志刷屏。 */
export const setAgentWebviewBounds = (input: AgentWebviewBoundsInput): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'agent_webview_set_bounds',
      guardHint: 'sync agent webview bounds',
      timeoutMs: 1_000,
      idempotent: true,
      audit: 'none',
      input,
    },
    async ({ traceId }) => {
      await commands.agentWebviewSetBounds(input, traceId);
    },
  );

/** 显示/隐藏子 webview。 */
export const setAgentWebviewVisible = (input: AgentWebviewVisibleInput): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'agent_webview_set_visible',
      guardHint: 'toggle agent webview visibility',
      timeoutMs: 1_000,
      idempotent: true,
      audit: 'none',
      input,
    },
    async ({ traceId }) => {
      await commands.agentWebviewSetVisible(input, traceId);
    },
  );

/** 导航到新 URL。 */
export const navigateAgentWebview = (input: AgentWebviewNavigateInput): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'agent_webview_navigate',
      guardHint: 'navigate agent webview',
      timeoutMs: 5_000,
      idempotent: false,
      audit: 'info',
      input,
    },
    async ({ traceId }) => {
      await commands.agentWebviewNavigate(input, traceId);
    },
  );

/** 后退一步(CDP 真实历史)。 */
export const backAgentWebview = (): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'agent_webview_back',
      guardHint: 'agent webview back',
      timeoutMs: 5_000,
      idempotent: false,
      audit: 'none',
      input: {},
    },
    async ({ traceId }) => {
      await commands.agentWebviewBack(traceId);
    },
  );

/** 前进一步(CDP 真实历史)。 */
export const forwardAgentWebview = (): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'agent_webview_forward',
      guardHint: 'agent webview forward',
      timeoutMs: 5_000,
      idempotent: false,
      audit: 'none',
      input: {},
    },
    async ({ traceId }) => {
      await commands.agentWebviewForward(traceId);
    },
  );

/** 刷新当前页面(CDP Page.reload)。 */
export const reloadAgentWebview = (): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'agent_webview_reload',
      guardHint: 'agent webview reload',
      timeoutMs: 5_000,
      idempotent: false,
      audit: 'none',
      input: {},
    },
    async ({ traceId }) => {
      await commands.agentWebviewReload(traceId);
    },
  );

/** 进入「选择元素」模式(注入 @medv/finder 拾取脚本,页面内悬停高亮+点击捕获)。 */
export const startSelectAgentWebview = (): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'agent_webview_start_select',
      guardHint: 'start agent webview element select',
      timeoutMs: 5_000,
      idempotent: false,
      audit: 'info',
      input: {},
    },
    async ({ traceId }) => {
      await commands.agentWebviewStartSelect(traceId);
    },
  );

/** 退出「选择元素」模式(拆除注入的 finder 拾取脚本)。幂等:未在选择态也安全。 */
export const cancelSelectAgentWebview = (): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'agent_webview_cancel_select',
      guardHint: 'cancel agent webview element select',
      timeoutMs: 5_000,
      idempotent: true,
      audit: 'none',
      input: {},
    },
    async ({ traceId }) => {
      await commands.agentWebviewCancelSelect(traceId);
    },
  );

/** 在系统默认浏览器中打开 URL(官方 opener,Rust 侧)。 */
export const openExternalAgentWebview = (input: AgentWebviewNavigateInput): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'agent_webview_open_external',
      guardHint: 'open url in system browser',
      timeoutMs: 5_000,
      idempotent: false,
      audit: 'info',
      input,
    },
    async ({ traceId }) => {
      await commands.agentWebviewOpenExternal(input, traceId);
    },
  );

/** 订阅主框架导航事件(url + canGoBack/canGoForward)。返回 unlisten。 */
export const onAgentWebviewNavigated = (handler: (payload: AgentWebviewNavigatedEvent) => void) =>
  events.agentWebviewNavigatedEvent.listen((event) => handler(event.payload));

/** 订阅页面控制台事件(console.* + 浏览器级日志)。返回 unlisten。 */
export const onAgentWebviewConsole = (handler: (payload: AgentWebviewConsoleEvent) => void) =>
  events.agentWebviewConsoleEvent.listen((event) => handler(event.payload));

/** 订阅「选择元素」结果(label=CSS 选择器 + outerHTML + url)。返回 unlisten。 */
export const onAgentWebviewElementPicked = (
  handler: (payload: AgentWebviewElementPickedEvent) => void,
) => events.agentWebviewElementPickedEvent.listen((event) => handler(event.payload));

/** 销毁子 webview。幂等:不存在也视为成功。 */
export const destroyAgentWebview = (): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'agent_webview_destroy',
      guardHint: 'destroy agent webview',
      timeoutMs: 2_000,
      idempotent: true,
      audit: 'info',
      input: {},
    },
    async ({ traceId }) => {
      await commands.agentWebviewDestroy(traceId);
    },
  );

import {
  commands,
  type AgentWebviewBoundsInput,
  type AgentWebviewCreateInput,
  type AgentWebviewNavigateInput,
  type AgentWebviewVisibleInput,
} from '@/bindings/tauri';
import { callSpectaCommand } from '@/services/tauri.ipc-runtime';

/**
 * agent 内置浏览器的 CDP 远程调试端口(默认绑 127.0.0.1)。
 *
 * 单一事实来源:前端创建 webview 与 agent-sidecar `connectOverCDP` 必须用同一个端口。
 * 阶段4 接入 sidecar 时从本常量 import,避免两边硬编码不一致。
 */
export const AGENT_WEBVIEW_CDP_PORT = 9333;

export type TAgentWebviewBounds = AgentWebviewBoundsInput;

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

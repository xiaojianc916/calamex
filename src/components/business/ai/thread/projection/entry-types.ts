/**
 * 平铺会话时间线(flat transcript)的投影模型。
 *
 * 设计对齐 Zed `acp_thread::AgentThreadEntry`(UserMessage / AssistantMessage /
 * ToolCall / CompletedPlan / ContextCompaction):整条会话被拍扁成一串自上而下、
 * 按时间顺序排列的条目,每个条目类型独立渲染。工具调用条目自身持有其展开内容
 * (文本 / Diff / 终端),对齐 Zed `ToolCall.content: Vec<ToolCallContent>`,而不是
 * 把这些内容塞进独立的面板 / 仪表盘卡片。
 *
 * 本模型是纯 UI 投影:不改动任何 wire schema,字段全部从既有的 `IAiChatMessage`
 * 推导而来。
 */
import type {
  IWebSearchSourceChip,
  TTaskIcon,
} from '@/components/business/ai/plan/runtime-timeline';
import type { IAiContextReference } from '@/types/ai/context';
import type { IAiAgentChangedFile, IAiAgentPatchSummary, IAiDiffHunkPreview } from '@/types/ai/patch';

/**
 * 工具调用条目的展开内容。对齐 Zed `acp_thread::ToolCallContent`:
 * `ContentBlock`(markdown) / `Diff` / `Terminal` 均作为工具调用的子内容,
 * 由工具调用条目自身懒展开,而不是独立卡片。
 */
export type TAiThreadToolContent =
  | { type: 'raw'; id: string; title: 'Raw Input' | 'Output'; code: string }
  | { type: 'text'; id: string; markdown: string }
  | {
      type: 'diff';
      id: string;
      file: IAiAgentChangedFile;
      patchSummaryId: string;
      /**
       * 协议自带的内联 diff hunk(ACP 路径)。存在时 `.vue` 直接渲染,
       * 不再经 `patches` prop 按路径反查;缺省时(Mastra 路径)回退到
       * `patches` 查询,保持向后兼容。
       */
      hunks?: IAiDiffHunkPreview[];
    }
  | { type: 'terminal'; id: string; title: string; output: string; streaming: boolean };

/**
 * 工具调用状态。对齐 Zed `acp_thread::ToolCallStatus`,但仅保留本项目数据真实
 * 可产生的状态(不臆造):
 * - `pending` / `running` / `succeeded` / `failed`:来自运行时任务节点或 wire 工具调用
 * - `awaiting-confirmation`:运行时进入等待决策(对应 Zed `WaitingForConfirmation`)
 * - `denied`:wire 工具调用被拒绝
 * - `canceled`:运行被取消
 */
export type TAiThreadToolStatus =
  | 'pending'
  | 'running'
  | 'awaiting-confirmation'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'canceled';

/** Plan 控制条目的阶段。控制条作为时间线中的一条普通条目呈现,而非独立仪表盘。 */
export type TAiThreadPlanPhase = 'awaiting-approval' | 'running';

interface IAiThreadEntryBase {
  /** 全局唯一且稳定的条目 id;用于 v-for key 与逐条展开状态记忆。 */
  id: string;
  /** 来源消息 id;便于回溯、事件透传与按消息分组。 */
  messageId: string;
}

/** 用户消息条目。 */
export interface IAiThreadUserMessageEntry extends IAiThreadEntryBase {
  kind: 'user-message';
  markdown: string;
  references: IAiContextReference[];
}

/** 助手最终文本回复条目(对应 Zed AssistantMessage 的文本块)。 */
export interface IAiThreadAssistantTextEntry extends IAiThreadEntryBase {
  kind: 'assistant-text';
  markdown: string;
  /** 来源消息是否正在流式输出;渲染层据此实现“流式展开,完成后自动折叠”。 */
  streaming: boolean;
}

/** 推理(thinking)条目(对应 Zed AssistantMessage 的 Thought 块)。 */
export interface IAiThreadReasoningEntry extends IAiThreadEntryBase {
  kind: 'reasoning';
  segments: string[];
  isLong: boolean;
  /** 来源消息是否正在流式输出;渲染层据此实现“流式展开,完成后自动折叠”。 */
  streaming: boolean;
}

/** 工具调用条目(对应 Zed ToolCall);自身持有展开内容,默认折叠。 */
export interface IAiThreadToolCallEntry extends IAiThreadEntryBase {
  kind: 'tool-call';
  toolName?: string;
  icon: TTaskIcon;
  title: string;
  /**
   * 结构化标题(对齐 Zed 工具行的「动词 + 参数」两段式展示):`titleVerb` 为动作
   * 动词(如 “Read file” / “Edit file” / “Run command”),`titleArgument` 为其参数
   * (路径 / 命令 / 正则等)。两者均可缺省;缺省时渲染层回退到整段 `title` 字符串。
   * `title` 仍保留为完整字符串,作为可访问名称与按路径关联 diff 的依据(单一数据源)。
   */
  titleVerb?: string;
  titleArgument?: string;
  tags: string[];
  tail?: string;
  status: TAiThreadToolStatus;
  content: TAiThreadToolContent[];
  webSearchSources?: IWebSearchSourceChip[];
  /** 抑制把原始 JSON / 工具名当作标签泄露(沿用运行时时间线语义)。 */
  suppressMeta?: boolean;
}

/**
 * Plan 审批 / 运行控制条目。并入时间线,像一条普通消息一样自上而下出现,而不是
 * 独立的执行仪表盘(对应用户要求,也对齐 Zed 把 plan 作为 entry 的取向)。
 */
export interface IAiThreadPlanControlEntry extends IAiThreadEntryBase {
  kind: 'plan-control';
  goal: string;
  references: IAiContextReference[];
  phase: TAiThreadPlanPhase;
}

/** 上下文整理条目(对应 Zed ContextCompaction)。 */
export interface IAiThreadContextCompactionEntry extends IAiThreadEntryBase {
  kind: 'context-compaction';
  text: string;
}

/** 改动文件汇总条目(末尾汇总;具体 diff 行内联在对应工具调用条目里)。 */
export interface IAiThreadChangedFilesSummaryEntry extends IAiThreadEntryBase {
  kind: 'changed-files-summary';
  summary: IAiAgentPatchSummary;
}

/** 平铺时间线条目联合体。 */
export type TAiThreadEntry =
  | IAiThreadUserMessageEntry
  | IAiThreadAssistantTextEntry
  | IAiThreadReasoningEntry
  | IAiThreadToolCallEntry
  | IAiThreadPlanControlEntry
  | IAiThreadContextCompactionEntry
  | IAiThreadChangedFilesSummaryEntry;

export type TAiThreadEntryKind = TAiThreadEntry['kind'];

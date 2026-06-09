/**
 * 活动 run + 工具确认 → composer 区“运行态状态条”(`RunStatusBar`)视图模型的纯映射。
 *
 * 设计取向(对齐 Codex `codex-rs/tui` 的 `status_indicator_widget` + `bottom_pane`
 * approval 语义):运行进行中以一条纤细状态条呈现 header / 进度 / 当前步骤,并提供
 * 中断(取消)与暂停 / 继续;一旦有待决工具确认,运行控制让位给确认(确认未决时
 * 不允许误触暂停 / 取消)。计划“等待批准”阶段不在此条呈现——它作为时间线内联的
 * Plan 控制条目(`plan-control`)出现,与本状态条职责分离。
 *
 * run 状态 → header 文案逐条复刻 `AiPlanModePanel.runStatusLabel`,进度
 * (done / total)复刻其 `completedStepCount` / `totalStepCount`,不发明新语义。
 */
import type { IAiTaskPlanStep, IAiToolConfirmationRequest, TAiAgentRunStatus } from '@/types/ai';

/** 状态条阶段。 */
export type TRunStatusPhase = 'running' | 'paused' | 'awaiting-confirmation';

/** 计划执行进度(已完成 / 总步骤)。 */
export interface IRunStatusProgress {
  done: number;
  total: number;
}

/** `RunStatusBar` 的业务视图模型(elapsed 计时与 busy 由容器层注入,不在此派生)。 */
export interface IRunStatusViewModel {
  phase: TRunStatusPhase;
  header: string;
  detail: string | null;
  progress: IRunStatusProgress | null;
  confirmation: IAiToolConfirmationRequest | null;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
}

/** 派生状态条所需输入(容器层从计划 / agent store 取值后传入)。 */
export interface IRunStatusInput {
  /** 当前活动 run;无 run 时为 null(此时可能仍有直连工具确认)。 */
  run: { status: TAiAgentRunStatus; steps: readonly IAiTaskPlanStep[] } | null;
  /** 已按当前会话过滤后的“可见”工具确认请求;无则 null。 */
  confirmation: IAiToolConfirmationRequest | null;
}

/** run 状态 → 中文 header 文案(复刻 `AiPlanModePanel.runStatusLabel`)。 */
export const describeAgentRunStatus = (status: TAiAgentRunStatus): string => {
  switch (status) {
    case 'waiting-for-plan-approval':
      return '等待批准';
    case 'running-plan':
      return '运行中';
    case 'running-step':
      return '执行步骤中';
    case 'waiting-for-tool-confirmation':
      return '等待工具确认';
    case 'paused':
      return '可继续';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return '未知状态';
  }
};

/** 步骤集合 → 进度;无步骤时返回 null(不展示进度)。 */
const deriveProgress = (steps: readonly IAiTaskPlanStep[]): IRunStatusProgress | null => {
  const total = steps.length;
  if (total === 0) {
    return null;
  }
  const done = steps.filter((step) => step.status === 'done').length;
  return { done, total };
};

/** 当前正在执行的步骤标题作为细节行(对齐 Zed / Codex 展示“当前步骤”)。 */
const deriveRunningStepDetail = (steps: readonly IAiTaskPlanStep[]): string | null => {
  const runningStep = steps.find((step) => step.status === 'running');
  const title = runningStep?.title.trim() ?? '';
  return title.length > 0 ? title : null;
};

/** 非空摘要 → 文本,否则 null。 */
const normalizeSummary = (summary: string): string | null => {
  const trimmed = summary.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * 把活动 run + 可见工具确认映射为状态条视图模型;不需要呈现状态条时返回 null。
 *
 * 优先级:
 * 1. 有可见工具确认 → `awaiting-confirmation`(运行控制全部禁用,让位给确认)。
 * 2. run 暂停 → `paused`(仅可继续 / 取消)。
 * 3. run 运行中(`running-plan` / `running-step`)→ `running`(可暂停 / 取消)。
 * 4. 其余(等待批准 → 时间线内联审批;终态;无 run)→ 不呈现(null)。
 */
export const deriveRunStatus = (input: IRunStatusInput): IRunStatusViewModel | null => {
  const { run, confirmation } = input;

  if (confirmation !== null) {
    return {
      phase: 'awaiting-confirmation',
      header: confirmation.question,
      detail: normalizeSummary(confirmation.summary),
      progress: deriveProgress(run?.steps ?? []),
      confirmation,
      canPause: false,
      canResume: false,
      canCancel: false,
    };
  }

  if (run === null) {
    return null;
  }

  if (run.status === 'paused') {
    return {
      phase: 'paused',
      header: describeAgentRunStatus('paused'),
      detail: null,
      progress: deriveProgress(run.steps),
      confirmation: null,
      canPause: false,
      canResume: true,
      canCancel: true,
    };
  }

  if (run.status === 'running-plan' || run.status === 'running-step') {
    return {
      phase: 'running',
      header: describeAgentRunStatus(run.status),
      detail: deriveRunningStepDetail(run.steps),
      progress: deriveProgress(run.steps),
      confirmation: null,
      canPause: true,
      canResume: false,
      canCancel: true,
    };
  }

  return null;
};

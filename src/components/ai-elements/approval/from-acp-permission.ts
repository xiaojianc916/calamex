import type { IToolConfirmationApproval } from './from-tool-confirmation';
import type { IApprovalPromptOption, TApprovalPromptTone } from './types';

/**
 * ACP 权限选项的 kind 线值。对齐 `src-tauri/src/acp/approval.rs::kind_wire`
 * 抹给 webview 的 snake_case 值（含未知变体兜底 `other`）。
 */
export type TAcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'
  | 'other';

/** 单个权限可选项（camelCase 线格式，对齐 Rust `ApprovalOptionInfo`）。 */
export interface IAcpPermissionOption {
  optionId: string;
  name: string;
  kind: TAcpPermissionOptionKind;
}

/**
 * 宿主 `ApprovalRegistry` 经反向 `session/request_permission` 抹给 webview 的
 * 权限请求详情（camelCase 线格式，对齐 Rust `ApprovalRequestInfo`）。
 */
export interface IAcpPermissionRequest {
  sessionId: string;
  toolCallId: string;
  options: IAcpPermissionOption[];
}

/**
 * 调用方按 `toolCallId` 关联到已渲染的工具调用后，可补充标题/摘要/影响。
 * ACP 的 request_permission 负载本身不含问句，故标题等信息由上层注入。
 */
export interface IBuildAcpPermissionApprovalOptions {
  title?: string;
  summary?: string | null;
  impact?: string | null;
}

/** 默认标题：ACP 负载无问句时的通用回退。 */
const DEFAULT_PERMISSION_TITLE = '是否允许此工具调用？';

/** kind → 单键快捷键。allow_once / allow_always / reject_once 给键，其余留空。 */
const SHORTCUT_BY_KIND: Record<TAcpPermissionOptionKind, string | undefined> = {
  allow_once: 'y',
  allow_always: 'a',
  reject_once: 'n',
  reject_always: undefined,
  other: undefined,
};

/** kind → 语气。拒绝类为危险（danger），其余默认。 */
const TONE_BY_KIND: Record<TAcpPermissionOptionKind, TApprovalPromptTone> = {
  allow_once: 'default',
  allow_always: 'default',
  reject_once: 'danger',
  reject_always: 'danger',
  other: 'default',
};

/**
 * 将 ACP 权限请求映射为既有审批浮层 VM（`IToolConfirmationApproval`），
 * 从而复用 `ApprovalPrompt.vue`，渲染层零改动。
 *
 * - `optionId` 逐字保留为决策 id：回投时与代理给出的 optionId 一致，
 *   对齐 `approval.rs` 的「逐字 optionId 优先」匹配；
 * - `name` 直接作为可读 label（由代理提供，openWorld 友好）；
 * - `kind` 仅用于附加快捷键与语气，不参与决策值。
 */
export const buildAcpPermissionApproval = (
  request: IAcpPermissionRequest,
  context: IBuildAcpPermissionApprovalOptions = {},
): IToolConfirmationApproval => {
  const options: IApprovalPromptOption[] = request.options.map((option) => ({
    id: option.optionId,
    label: option.name,
    shortcut: SHORTCUT_BY_KIND[option.kind],
    tone: TONE_BY_KIND[option.kind],
  }));

  const title = context.title?.trim() || DEFAULT_PERMISSION_TITLE;
  const summary = context.summary?.trim() || null;
  const impactRaw = context.impact?.trim() ?? '';
  const impact = impactRaw && impactRaw !== summary ? impactRaw : null;

  return { title, summary, impact, options };
};

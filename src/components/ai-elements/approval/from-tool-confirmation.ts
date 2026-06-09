import type { IAiToolConfirmationRequest, TAiToolConfirmationOptionId } from '@/types/ai';

import type { IApprovalPromptOption } from './types';

/**
 * 将业务层的工具确认请求映射为 Codex 风格审批浮层所需的展示数据。
 *
 * 对齐 Codex `approval_overlay.rs` 的 exec/apply-patch 审批:
 *   - 问句作为加粗标题;
 *   - 详情(影响范围/命令)作为上下文呈现;
 *   - 只列出可执行的决策选项(`view-details` 不是一个决策,信息已内联呈现,故滤除)。
 */
const SHORTCUT_BY_OPTION_ID: Partial<Record<TAiToolConfirmationOptionId, string>> = {
  'allow-once': 'y',
  'allow-run': 'a',
  skip: 's',
  stop: 'n',
};

export interface IToolConfirmationApproval {
  title: string;
  summary: string | null;
  impact: string | null;
  options: IApprovalPromptOption[];
}

export const buildToolConfirmationApproval = (
  confirmation: IAiToolConfirmationRequest,
): IToolConfirmationApproval => {
  const options: IApprovalPromptOption[] = confirmation.options
    .filter((option) => option.id !== 'view-details')
    .map((option) => ({
      id: option.id,
      label: option.label,
      shortcut: SHORTCUT_BY_OPTION_ID[option.id],
      tone: option.tone === 'danger' ? 'danger' : 'default',
    }));

  const summary = confirmation.summary.trim() || null;
  const impactRaw = confirmation.impact?.trim() ?? '';
  const impact = impactRaw && impactRaw !== summary ? impactRaw : null;
  const title = confirmation.question.trim() || confirmation.toolName;

  return { title, summary, impact, options };
};

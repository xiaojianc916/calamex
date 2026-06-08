export type TApprovalPromptTone = 'default' | 'danger';

/**
 * 一条审批可选项。对齐 Codex `approval_overlay.rs` 的 `ApprovalOption`:
 * 每项有稳定 id、可读 label、可选的单键快捷键，以及语气(默认/危险)。
 */
export interface IApprovalPromptOption {
  id: string;
  label: string;
  shortcut?: string;
  tone?: TApprovalPromptTone;
}

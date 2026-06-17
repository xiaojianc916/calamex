export { default as ApprovalPrompt } from './ApprovalPrompt.vue';
export type {
  IAcpPermissionOption,
  IAcpPermissionRequest,
  IBuildAcpPermissionApprovalOptions,
  TAcpPermissionOptionKind,
} from './from-acp-permission';
export { buildAcpPermissionApproval } from './from-acp-permission';
export type { IToolConfirmationApproval } from './from-tool-confirmation';
export { buildToolConfirmationApproval } from './from-tool-confirmation';
export type { IApprovalPromptOption, TApprovalPromptTone } from './types';

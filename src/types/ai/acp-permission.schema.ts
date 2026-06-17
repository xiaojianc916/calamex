import { z } from 'zod';

/**
 * ACP 反向 `session/request_permission` 权限请求的运行时校验 schema。
 *
 * 校验宿主经 `ai:sidecar-approval` webview 事件抹来的负载，对齐 Rust
 * `acp::approval::ApprovalRequestInfo` / `ApprovalOptionInfo`（serde camelCase）。
 *
 * 浅校验取舍：
 * - `sessionId` / `toolCallId` / `optionId` 是定位挂起审批与逐字回投决策所必需，
 *   强制非空；
 * - `name` 由代理提供、openWorld 友好（外部 agent 文案不可控），不强制非空，
 *   避免空文案导致整条审批被丢弃、回合永久挂起；
 * - `kind` 未知变体兜底 `'other'`（对齐 `approval.rs::kind_wire`），新代理引入
 *   新选项类型时仍可渲染，仅退化掉快捷键/语气增强。
 *
 * 单独成文件（不并入 sidecar.schema.ts）以隔离 ACP 第二语言与 Mastra 边车契约，
 * 符合 ADR-20260617「投影边界做 ACL、两套契约平级不混淆」的分层取舍。
 */

export const ACP_PERMISSION_OPTION_KINDS = [
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
  'other',
] as const;

export const acpPermissionOptionKindSchema = z
  .enum(ACP_PERMISSION_OPTION_KINDS)
  .catch('other');

export const acpPermissionOptionPayloadSchema = z.object({
  optionId: z.string().min(1),
  name: z.string(),
  kind: acpPermissionOptionKindSchema,
});

export const acpPermissionRequestPayloadSchema = z.object({
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
  options: z.array(acpPermissionOptionPayloadSchema),
});

export type TAcpPermissionOptionKindWire = z.infer<typeof acpPermissionOptionKindSchema>;
export type IAcpPermissionOptionPayload = z.infer<typeof acpPermissionOptionPayloadSchema>;
export type IAcpPermissionRequestPayload = z.infer<typeof acpPermissionRequestPayloadSchema>;

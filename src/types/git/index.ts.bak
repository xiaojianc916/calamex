// Git 领域类型的唯一真源是 Rust 后端，经 tauri-specta 生成到 `@/bindings/tauri`。
// 这里仅做语义化再导出（`IGit*` 别名），避免手写副本与生成绑定漂移。
import type {
  GitBranchCheckoutRequest,
  GitBranchCreateRequest,
  GitBranchListPayload,
  GitBranchPayload,
  GitCommitHistoryPayload,
  GitCommitHistoryRequest,
  GitCommitRequest,
  GitCommitResultPayload,
  GitCommitSummaryPayload,
  GitDiffPreviewPayload,
  GitDiffPreviewRequest,
  GitFileBaselinePayload,
  GitFileStatusPayload,
  GitPathOperationRequest,
  GitPullRequestSupportPayload,
  GitRepositoryRootRequest,
  GitRepositoryStatusPayload,
  GitStashApplyRequest,
  GitStashDropRequest,
  GitStashEntryPayload,
  GitStashListPayload,
  GitStashSaveRequest,
} from '@/bindings/tauri';

// 后端枚举经 specta 序列化为字符串，生成绑定层目前以 `string` 暴露。
// 以下别名仅用于语义标注（取值范围见 Rust 端定义），不再约束为字面量联合。
export type TGitChangeKind = string;
export type TGitDiffMode = string;
export type TGitBranchKind = string;
export type TGitPullRequestProvider = string;

export type IGitCommitSummaryPayload = GitCommitSummaryPayload;
export type IGitCommitHistoryRequest = GitCommitHistoryRequest;
export type IGitCommitHistoryPayload = GitCommitHistoryPayload;
export type IGitFileStatusPayload = GitFileStatusPayload;
export type IGitBranchPayload = GitBranchPayload;
export type IGitBranchListPayload = GitBranchListPayload;
export type IGitBranchCheckoutRequest = GitBranchCheckoutRequest;
export type IGitBranchCreateRequest = GitBranchCreateRequest;
export type IGitRepositoryStatusPayload = GitRepositoryStatusPayload;
export type IGitRepositoryRootRequest = GitRepositoryRootRequest;
export type IGitFileBaselinePayload = GitFileBaselinePayload;
export type IGitStashEntryPayload = GitStashEntryPayload;
export type IGitStashListPayload = GitStashListPayload;
export type IGitStashSaveRequest = GitStashSaveRequest;
export type IGitStashApplyRequest = GitStashApplyRequest;
export type IGitStashDropRequest = GitStashDropRequest;
export type IGitPullRequestSupportPayload = GitPullRequestSupportPayload;
export type IGitDiffPreviewRequest = GitDiffPreviewRequest;
export type IGitDiffPreviewPayload = GitDiffPreviewPayload;
export type IGitPathOperationRequest = GitPathOperationRequest;
export type IGitCommitRequest = GitCommitRequest;
export type IGitCommitResultPayload = GitCommitResultPayload;

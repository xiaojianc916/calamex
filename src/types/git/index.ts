// Git 领域类型的唯一真源是 Rust 后端，经 tauri-specta 生成到 `@/bindings/tauri`。
// 这里仅做语义化再导出（`IGit*` 别名），避免手写副本与生成绑定漂移。
import type {
  GitBranchCheckoutRequest,
  GitBranchCreateRequest,
  GitBranchListPayload,
  GitBranchPayload,
  GitCommitCheckoutRequest,
  GitCommitDetailPayload,
  GitCommitDetailRequest,
  GitCommitFileChangePayload,
  GitCommitHistoryPayload,
  GitCommitHistoryRequest,
  GitCommitRequest,
  GitCommitResultPayload,
  GitCommitRevertRequest,
  GitCommitSummaryPayload,
  GitDiffPreviewPayload,
  GitDiffPreviewRequest,
  GitFileBaselinePayload,
  GitFileStatusPayload,
  GitPathOperationRequest,
  GitPullRequestCloseRequest,
  GitPullRequestCreateRequest,
  GitPullRequestDetailPayload,
  GitPullRequestDetailRequest,
  GitPullRequestListRequest,
  GitPullRequestMergeRequest,
  GitPullRequestSummaryPayload,
  GitPullRequestSupportPayload,
  GitRemoteSetRequest,
  GitRepositoryRootRequest,
  GitRepositoryStatusPayload,
  GitStashApplyRequest,
  GitStashDropRequest,
  GitStashEntryPayload,
  GitStashListPayload,
  GitStashSaveRequest,
} from '@/bindings/tauri';

export type TGitChangeKind = string;
export type TGitDiffMode = string;
export type TGitBranchKind = string;
export type TGitPullRequestProvider = string;
export type TGitPullRequestState = string;

export type IGitCommitSummaryPayload = GitCommitSummaryPayload;
export type IGitCommitHistoryRequest = GitCommitHistoryRequest;
export type IGitCommitHistoryPayload = GitCommitHistoryPayload;
export type IGitCommitDetailRequest = GitCommitDetailRequest;
export type IGitCommitDetailPayload = GitCommitDetailPayload;
export type IGitCommitFileChangePayload = GitCommitFileChangePayload;
export type IGitCommitCheckoutRequest = GitCommitCheckoutRequest;
export type IGitCommitRevertRequest = GitCommitRevertRequest;
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
export type IGitPullRequestListRequest = GitPullRequestListRequest;
export type IGitPullRequestDetailRequest = GitPullRequestDetailRequest;
export type IGitPullRequestCreateRequest = GitPullRequestCreateRequest;
export type IGitPullRequestMergeRequest = GitPullRequestMergeRequest;
export type IGitPullRequestCloseRequest = GitPullRequestCloseRequest;
export type IGitPullRequestSummaryPayload = GitPullRequestSummaryPayload;
export type IGitPullRequestDetailPayload = GitPullRequestDetailPayload;
export type IGitRemoteSetRequest = GitRemoteSetRequest;
export type IGitDiffPreviewRequest = GitDiffPreviewRequest;
export type IGitDiffPreviewPayload = GitDiffPreviewPayload;
export type IGitPathOperationRequest = GitPathOperationRequest;
export type IGitCommitRequest = GitCommitRequest;
export type IGitCommitResultPayload = GitCommitResultPayload;

// ── GitHub auth (手动定义直到 tauri-specta 重新生成绑定) ─────────────────────
export interface IGitHubAuthRequest {
  repositoryRootPath: string;
}

export interface IGitHubDeviceAuthCompleteRequest extends IGitHubAuthRequest {
  deviceCode: string;
  interval: number;
}

export interface IGitHubAuthStatusPayload {
  authenticated: boolean;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string | null;
  email: string | null;
  source: string | null;
  message: string | null;
}

export interface IGitHubDeviceAuthPayload {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

// ── commit file diff (手动定义直到 tauri-specta 重新生成绑定) ──────────────────
export interface IGitDiffLine {
  tag: string; // 'add' | 'remove' | 'context'
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface IGitDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: IGitDiffLine[];
}

export interface IGitCommitFileDiffRequest {
  repositoryRootPath: string;
  commitId: string;
  relativePath: string;
}

export interface IGitCommitFileDiffPayload {
  relativePath: string;
  fileName: string;
  title: string;
  hunks: IGitDiffHunk[];
  isBinary: boolean;
  isEmpty: boolean;
}

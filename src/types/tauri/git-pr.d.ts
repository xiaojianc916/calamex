import type {
  IGitPullRequestCloseRequest,
  IGitPullRequestCreateRequest,
  IGitPullRequestDetailPayload,
  IGitPullRequestDetailRequest,
  IGitPullRequestListRequest,
  IGitPullRequestMergeRequest,
  IGitPullRequestSummaryPayload,
} from '../git';

declare module '@/types/tauri' {
  interface ITauriService {
    listGitPullRequests(payload: IGitPullRequestListRequest): Promise<IGitPullRequestSummaryPayload[]>;
    getGitPullRequestDetail(payload: IGitPullRequestDetailRequest): Promise<IGitPullRequestDetailPayload>;
    createGitPullRequest(payload: IGitPullRequestCreateRequest): Promise<IGitPullRequestSummaryPayload>;
    mergeGitPullRequest(payload: IGitPullRequestMergeRequest): Promise<IGitPullRequestSummaryPayload>;
    closeGitPullRequest(payload: IGitPullRequestCloseRequest): Promise<IGitPullRequestSummaryPayload>;
  }
}

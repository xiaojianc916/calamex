import type {
  WorkspaceReplacementAppliedFile,
  WorkspaceReplacementApplyPayload,
  WorkspaceReplacementApplyRequest,
  WorkspaceReplacementExpectedFile,
  WorkspaceReplacementFilePreview,
  WorkspaceReplacementLinePreview,
  WorkspaceReplacementPreviewPayload,
  WorkspaceReplacementRequest,
  WorkspaceSearchPayload,
  WorkspaceSearchRequest,
  WorkspaceSearchResult,
  WorkspaceSearchResultKind,
  WorkspaceSearchScope,
  WorkspaceSearchStreamEvent,
} from '@/bindings/tauri';

export type TWorkspaceSearchScope = WorkspaceSearchScope;

export type TWorkspaceSearchResultKind = WorkspaceSearchResultKind;

export type IWorkspaceSearchRequest = Omit<WorkspaceSearchRequest, 'limit' | 'streamToken'> & {
  limit?: number;
  // 内容搜索流式推送的关联标识：带上后端会按发现顺序分批推送内容命中，事件回带同一 search_id。
  // 留空（或 null）则沿用一次性返回。
  streamToken?: number | null;
};

export type IWorkspaceSearchResult = WorkspaceSearchResult;

export type IWorkspaceSearchPayload = WorkspaceSearchPayload;

export type IWorkspaceSearchStreamEvent = WorkspaceSearchStreamEvent;

export type IWorkspaceReplacementRequest = Omit<WorkspaceReplacementRequest, 'limit'> & {
  limit?: number;
};

export type IWorkspaceReplacementExpectedFile = WorkspaceReplacementExpectedFile;

export type IWorkspaceReplacementApplyRequest = Omit<
  WorkspaceReplacementApplyRequest,
  'request'
> & {
  request: IWorkspaceReplacementRequest;
};

export type IWorkspaceReplacementFilePreview = WorkspaceReplacementFilePreview;

export type IWorkspaceReplacementLinePreview = WorkspaceReplacementLinePreview;

export type IWorkspaceReplacementPreviewPayload = WorkspaceReplacementPreviewPayload;

export type IWorkspaceReplacementAppliedFile = WorkspaceReplacementAppliedFile;

export type IWorkspaceReplacementApplyPayload = WorkspaceReplacementApplyPayload;

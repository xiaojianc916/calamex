export type TWorkspaceSearchScope = 'all' | 'file-name' | 'symbol' | 'content';

export type TWorkspaceSearchResultKind = 'file-name' | 'content' | 'symbol';

export interface IWorkspaceSearchRequest {
  workspaceRootPath: string;
  query: string;
  scope: TWorkspaceSearchScope;
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  useStructural: boolean;
  includePatterns: string[];
  excludePatterns: string[];
  limit?: number;
}

export interface IWorkspaceSearchResult {
  path: string;
  relativePath: string;
  name: string;
  kind: TWorkspaceSearchResultKind;
  lineNumber: number | null;
  lineText: string | null;
  matchStart: number | null;
  matchEnd: number | null;
  score: number;
}

export interface IWorkspaceSearchPayload {
  rootPath: string;
  scannedFileCount: number;
  results: IWorkspaceSearchResult[];
}

export interface IWorkspaceReplacementRequest {
  workspaceRootPath: string;
  query: string;
  replacement: string;
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  useStructural: boolean;
  includePatterns: string[];
  excludePatterns: string[];
  limit?: number;
}

export interface IWorkspaceReplacementExpectedFile {
  path: string;
  beforeHash: string;
  includedMatchIds?: string[];
}

export interface IWorkspaceReplacementApplyRequest {
  request: IWorkspaceReplacementRequest;
  expectedFiles: IWorkspaceReplacementExpectedFile[];
}

export interface IWorkspaceReplacementFilePreview {
  path: string;
  relativePath: string;
  replacementCount: number;
  beforeHash: string;
  afterHash: string;
  diff: string;
  diffTruncated: boolean;
  linePreviews: IWorkspaceReplacementLinePreview[];
}

export interface IWorkspaceReplacementLinePreview {
  id: string;
  lineNumber: number;
  beforeLine: string;
  afterLine: string;
  replacementCount: number;
}

export interface IWorkspaceReplacementPreviewPayload {
  rootPath: string;
  fileCount: number;
  replacementCount: number;
  files: IWorkspaceReplacementFilePreview[];
}

export interface IWorkspaceReplacementAppliedFile {
  path: string;
  relativePath: string;
  replacementCount: number;
  byteSize: number;
}

export interface IWorkspaceReplacementApplyPayload {
  rootPath: string;
  changedFileCount: number;
  replacementCount: number;
  files: IWorkspaceReplacementAppliedFile[];
}

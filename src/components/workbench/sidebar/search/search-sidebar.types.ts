import type {
  IWorkspaceReplacementFilePreview,
  IWorkspaceReplacementLinePreview,
  TWorkspaceSearchResultKind,
} from '@/types/search';

export type TSearchReason = TWorkspaceSearchResultKind;
export type TSearchToggleOption =
  | 'matchCase'
  | 'wholeWord'
  | 'useRegex'
  | 'contentFuzzy'
  | 'showPathFilters';
export type TReplacementSegmentKind = 'equal' | 'removed' | 'added' | 'empty';
export type TReplacementSegmentPart = 'prefix' | 'removed' | 'added' | 'suffix';

// 命中锚定片段在整行中的角色：前缀（命中之前，左侧按真实像素截断）、命中区（始终完整可见）、
// 后缀（命中之后，右侧按真实像素截断）。视觉截断与省略号完全交给 CSS，数据层不再拼省略号。
export type TSnippetSegmentPart = 'prefix' | 'core' | 'suffix';

export interface IHighlightedSegment {
  text: string;
  matched: boolean;
}

export interface ISnippetSegment {
  text: string;
  matched: boolean;
  part: TSnippetSegmentPart;
}

export interface ISearchResultItem {
  path: string;
  relativePath: string;
  resultKey: string;
  reason: TSearchReason;
  snippetSegments: ISnippetSegment[];
  score: number;
  lineNumber: number | null;
  matchStart: number | null;
  matchEnd: number | null;
}

export interface ISearchResultGroup {
  path: string;
  name: string;
  parentPath: string;
  results: ISearchResultItem[];
}

export interface IFlatSearchRow {
  kind: 'group' | 'line';
  key: string;
  group: ISearchResultGroup;
  result: ISearchResultItem | null;
}

export interface ISearchMatcher {
  hasQuery: boolean;
  errorMessage: string;
  highlight: (value: string) => IHighlightedSegment[];
}

export interface IReplacementLineSegment {
  text: string;
  kind: TReplacementSegmentKind;
  part: TReplacementSegmentPart;
}

export interface IReplacementLineView extends IWorkspaceReplacementLinePreview {
  segments: IReplacementLineSegment[];
}

export interface IReplacementFileView extends IWorkspaceReplacementFilePreview {
  name: string;
  parentPath: string;
  visibleReplacementCount: number;
  visibleLinePreviews: IReplacementLineView[];
}

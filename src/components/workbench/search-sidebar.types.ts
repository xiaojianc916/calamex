import type {
  IWorkspaceReplacementFilePreview,
  IWorkspaceReplacementLinePreview,
  TWorkspaceSearchResultKind,
} from '@/types/search';

export type TSearchReason = TWorkspaceSearchResultKind;
export type TSearchToggleOption = 'matchCase' | 'wholeWord' | 'useRegex' | 'showPathFilters';
export type TReplacementSegmentKind = 'equal' | 'removed' | 'added' | 'empty';
export type TReplacementSegmentPart = 'whole' | 'prefix' | 'removed' | 'added' | 'suffix';

export interface IHighlightedSegment {
  text: string;
  matched: boolean;
}

export interface ISearchResultItem {
  path: string;
  relativePath: string;
  resultKey: string;
  reason: TSearchReason;
  snippetSegments: IHighlightedSegment[];
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

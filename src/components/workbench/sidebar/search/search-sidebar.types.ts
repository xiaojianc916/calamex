export interface ISearchHighlightSegment {
  text: string;
  isMatch: boolean;
}

export interface ISearchMatcher {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  matchWholeWord: boolean;
}

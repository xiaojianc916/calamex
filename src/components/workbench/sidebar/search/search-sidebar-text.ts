import type { ISearchHighlightSegment, ISearchMatcher } from './search-sidebar.types';

const REGEX_SPECIAL_CHARACTERS = /[.*+?^${}()|[\]\\]/g;

export function escapeRegExp(value: string): string {
  return value.replace(REGEX_SPECIAL_CHARACTERS, '\\$&');
}

export function buildSearchPattern(matcher: ISearchMatcher): RegExp | null {
  if (matcher.query.length === 0) {
    return null;
  }
  let source = matcher.isRegex ? matcher.query : escapeRegExp(matcher.query);
  if (matcher.matchWholeWord) {
    source = '\\b(?:' + source + ')\\b';
  }
  const flags = matcher.caseSensitive ? 'g' : 'gi';
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

export function splitHighlightSegments(
  text: string,
  matcher: ISearchMatcher,
): ISearchHighlightSegment[] {
  const pattern = buildSearchPattern(matcher);
  if (!pattern) {
    return [{ text, isMatch: false }];
  }
  const segments: ISearchHighlightSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const matched = match[0];
    if (matched.length === 0) {
      continue;
    }
    if (start > lastIndex) {
      segments.push({ text: text.slice(lastIndex, start), isMatch: false });
    }
    segments.push({ text: matched, isMatch: true });
    lastIndex = start + matched.length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isMatch: false });
  }
  return segments.length > 0 ? segments : [{ text, isMatch: false }];
}

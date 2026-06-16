import type { CSSProperties } from 'vue';
import {
  type ICodeMirrorHighlightToken,
  isBold,
  isItalic,
  isUnderline,
} from '@/components/ai-elements/code-block/utils';
import type { ISshPreviewMatchHit } from '@/utils/file/ssh-file-preview';
import { splitTextGraphemes } from '@/utils/file/text-preview';

export interface IRenderedPreviewSegment {
  key: string;
  text: string;
  style: CSSProperties;
  matched: boolean;
  active: boolean;
}

export interface IRenderedPreviewLine {
  key: string;
  lineIndex: number;
  segments: IRenderedPreviewSegment[];
}

export interface IIndexedPreviewMatchHit extends ISshPreviewMatchHit {
  globalIndex: number;
}

export type TSshPreviewThemeStyle = CSSProperties & Record<`--${string}`, string>;

export function formatRemoteFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function resolveTokenStyle(token: ICodeMirrorHighlightToken): CSSProperties {
  return {
    color: token.color ?? undefined,
    backgroundColor: token.bgColor ?? undefined,
    ...token.htmlStyle,
    fontStyle: isItalic(token.fontStyle) ? 'italic' : undefined,
    fontWeight: isBold(token.fontStyle) ? '600' : undefined,
    textDecoration: isUnderline(token.fontStyle) ? 'underline' : undefined,
  };
}

export function buildRenderedLineSegments(
  tokens: readonly ICodeMirrorHighlightToken[],
  line: string,
  lineHits: readonly IIndexedPreviewMatchHit[],
  currentActiveHitIndex: number,
): IRenderedPreviewSegment[] {
  const graphemes = splitTextGraphemes(line);
  if (graphemes.length === 0) {
    return [];
  }

  const styles: CSSProperties[] = [];

  for (const token of tokens) {
    const tokenStyle = resolveTokenStyle(token);
    const tokenGraphemes = splitTextGraphemes(token.content);

    for (let index = 0; index < tokenGraphemes.length; index += 1) {
      styles.push(tokenStyle);
    }
  }

  while (styles.length < graphemes.length) {
    styles.push({});
  }

  if (styles.length > graphemes.length) {
    styles.length = graphemes.length;
  }

  const matchedFlags = Array.from({ length: graphemes.length }, () => ({
    matched: false,
    active: false,
  }));

  for (const hit of lineHits) {
    for (let index = hit.start; index < hit.end && index < matchedFlags.length; index += 1) {
      matchedFlags[index] = {
        matched: true,
        active: hit.globalIndex === currentActiveHitIndex,
      };
    }
  }

  const segments: IRenderedPreviewSegment[] = [];
  let currentText = '';
  let currentStyle = styles[0] ?? {};
  let currentStyleKey = JSON.stringify(currentStyle);
  let currentMatched = matchedFlags[0]?.matched ?? false;
  let currentActive = matchedFlags[0]?.active ?? false;

  const pushSegment = (): void => {
    if (!currentText) {
      return;
    }

    segments.push({
      key: `segment-${segments.length}`,
      text: currentText,
      style: currentStyle,
      matched: currentMatched,
      active: currentActive,
    });
  };

  for (let index = 0; index < graphemes.length; index += 1) {
    const nextStyle = styles[index] ?? {};
    const nextStyleKey = JSON.stringify(nextStyle);
    const nextMatched = matchedFlags[index]?.matched ?? false;
    const nextActive = matchedFlags[index]?.active ?? false;

    if (
      index > 0 &&
      (nextStyleKey !== currentStyleKey ||
        nextMatched !== currentMatched ||
        nextActive !== currentActive)
    ) {
      pushSegment();
      currentText = '';
      currentStyle = nextStyle;
      currentStyleKey = nextStyleKey;
      currentMatched = nextMatched;
      currentActive = nextActive;
    }

    currentText += graphemes[index] ?? '';
  }

  pushSegment();

  return segments;
}

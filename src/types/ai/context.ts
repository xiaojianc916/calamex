export type TAiContextKind =
  | 'current-file'
  | 'selection'
  | 'cursor-window'
  | 'diagnostics'
  | 'git-diff'
  | 'terminal-log'
  | 'search-result'
  | 'image-attachment'
  | 'symbol-definition'
  | 'symbol-references'
  | 'project-tree'
  | 'skill';

export interface IAiContextRange {
  startLine: number;
  endLine: number;
}

export interface IAiImageAttachmentPreview {
  src: string;
  width: number | null;
  height: number | null;
  mimeType: string;
}

export interface IAiContextReference {
  id: string;
  kind: TAiContextKind;
  label: string;
  path: string | null;
  range: IAiContextRange | null;
  contentPreview: string;
  redacted: boolean;
  attachmentPreview?: IAiImageAttachmentPreview;
}

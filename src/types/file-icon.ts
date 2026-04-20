export type TFileIconEntryKind = 'file' | 'directory';

export interface IFileIconMap {
  filenames: Record<string, string>;
  compoundExtensions: Record<string, string>;
  extensions: Record<string, string>;
}

export interface IFileIconGlyph {
  viewBox: string;
  body: string;
}

export interface IFileIconResolveOptions {
  kind: TFileIconEntryKind;
  path?: string | null;
  expanded?: boolean;
}
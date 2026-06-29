export type TShellCompletionKind =
  | 'keyword'
  | 'command'
  | 'flag'
  | 'value'
  | 'variable'
  | 'snippet'
  | 'operator';

export interface IShellCompletionEntry {
  label: string;
  kind: TShellCompletionKind;
  detail: string;
  documentation?: string;
  insertText?: string;
  insertAsSnippet?: boolean;
  priority?: number;
}

export interface IShellCommandValueSuggestionSpec {
  names: string[];
  detail?: string;
  insertText?: string;
  insertAsSnippet?: boolean;
  priority?: number;
}

export interface IShellCommandArgumentSpec {
  label: string;
  detail?: string;
  isOptional?: boolean;
  isVariadic?: boolean;
  suggestions?: IShellCommandValueSuggestionSpec[];
}

export interface IShellCommandOptionSpec {
  names: string[];
  detail?: string;
  insertText?: string;
  insertAsSnippet?: boolean;
  priority?: number;
  arg?: IShellCommandArgumentSpec;
  args?: IShellCommandArgumentSpec[];
}

export interface IShellCommandNodeSpec {
  names: string[];
  detail?: string;
  priority?: number;
  flags?: IShellCommandOptionSpec[];
  args?: IShellCommandArgumentSpec[];
  subcommands?: IShellCommandNodeSpec[];
}

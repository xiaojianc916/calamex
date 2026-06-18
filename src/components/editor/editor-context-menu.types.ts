import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
  TLinearContextMenuIcon,
} from '@/components/common/linear-context-menu.types';

export type TEditorContextMenuIcon = Extract<
  TLinearContextMenuIcon,
  | 'format'
  | 'search'
  | 'command'
  | 'comment'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'goto'
  | 'undo'
  | 'redo'
  | 'terminal'
  | 'play'
  | 'sparkles'
  | 'minus'
  | 'plus'
>;

export type TEditorContextMenuAction =
  | 'open-terminal'
  | 'undo'
  | 'redo'
  | 'format-with-shfmt'
  | 'toggle-comment-line'
  | 'find'
  | 'goto-line'
  | 'quick-command'
  | 'run-current-script'
  | 'fold-all'
  | 'unfold-all'
  | 'cut'
  | 'copy'
  | 'paste';

export interface IEditorContextMenuItem extends Omit<ILinearContextMenuItem, 'icon' | 'children'> {
  icon: TEditorContextMenuIcon;
  action?: TEditorContextMenuAction;
  children?: IEditorContextMenuItem[];
}

export type IEditorContextMenuGroup = ILinearContextMenuGroup<IEditorContextMenuItem>;

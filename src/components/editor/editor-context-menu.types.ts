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
  | 'select-all'
  | 'goto'
  | 'undo'
  | 'redo'
  | 'command'
>;

export type TEditorContextMenuAction =
  | 'ai-explain-selection'
  | 'ai-fix-diagnostic'
  | 'ai-generate-tests'
  | 'undo'
  | 'redo'
  | 'format-with-shfmt'
  | 'toggle-comment-line'
  | 'find'
  | 'goto-line'
  | 'quick-command'
  | 'run-current-script'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'select-all';

export interface IEditorContextMenuItem
  extends Omit<ILinearContextMenuItem, 'icon' | 'children'> {
  icon: TEditorContextMenuIcon;
  action?: TEditorContextMenuAction;
  children?: IEditorContextMenuItem[];
}

export type IEditorContextMenuGroup = ILinearContextMenuGroup<IEditorContextMenuItem>;

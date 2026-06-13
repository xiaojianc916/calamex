import type { ILinearContextMenuGroup } from '@/components/common/linear-context-menu.types';
import type { ISshAuthOption, ISshFileItem } from '@/types/ssh';

export const CONTEXT_MENU_WIDTH = 172;
export const CONTEXT_MENU_HEIGHT = 252;
export const SSH_BREADCRUMB_COLLAPSE_THRESHOLD = 4;
export const SSH_BREADCRUMB_TAIL_COUNT = 2;
export const DEFAULT_SELECTED_FILE_ID = 'ssh-client';
export const MANUAL_CONNECTION_ID = 'manual';
export const DEFAULT_SSH_PORT = '22';
export const TERMINAL_OPEN_DELAY_MS = 120;
export const SSH_PASSWORD_SEND_DELAY_MS = 180;
export const SSH_TERMINAL_HOST_KEY_POLICY = 'accept-new';

export const SSH_CONTEXT_MENU_GROUPS: ILinearContextMenuGroup[] = [
  {
    key: 'file-actions',
    title: '',
    items: [
      { key: 'new-folder', label: '新建文件夹', icon: 'plus' },
      { key: 'rename', label: '重命名', icon: 'rename' },
      { key: 'copy-path', label: '复制路径', icon: 'copy' },
      { key: 'download', label: '下载到本地', icon: 'download' },
      { key: 'upload', label: '上传到此处', icon: 'upload' },
    ],
  },
  {
    key: 'danger-actions',
    title: '',
    items: [{ key: 'delete', label: '删除', icon: 'trash', variant: 'destructive' }],
  },
];

export const SSH_AUTH_OPTIONS: ISshAuthOption[] = [
  { value: 'password', label: '密码认证' },
  { value: 'key', label: '密钥认证' },
];

export const FALLBACK_SELECTED_FILE: ISshFileItem = {
  id: DEFAULT_SELECTED_FILE_ID,
  name: 'ssh_client.rs',
  kind: 'rust',
  metaLabel: '8.7 KB',
  path: 'ssh_client.rs',
  isDirectory: false,
};

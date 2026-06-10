import type { ISidebarDomainDefinition } from './sidebar.types';

export const SIDEBAR_DOMAINS: readonly ISidebarDomainDefinition[] = [
  {
    domain: 'explorer',
    view: 'explorer',
    label: '文件',
    description: 'Workspace file tree, inline creation, rename, delete, and file watching.',
  },
  {
    domain: 'search',
    view: 'search',
    label: '搜索',
    description: 'Workspace search, path filters, replacement preview, and result virtualization.',
  },
  {
    domain: 'source-control',
    view: 'source-control',
    label: 'Git',
    description: 'Git status, history graph, branches, pull requests, and stash workflows.',
  },
  {
    domain: 'run',
    view: 'run',
    label: '模板',
    description: 'Run actions, command templates, active run summary, and run history.',
  },
  {
    domain: 'ssh',
    view: 'extensions',
    label: 'SSH',
    description: 'SSH connection form, remote explorer, transfers, and remote file preview.',
  },
] as const;

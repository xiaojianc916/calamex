import type { TWorkbenchSidebarView } from '@/types/app';

export type TSidebarDomain = 'explorer' | 'search' | 'source-control' | 'run' | 'ssh';

export interface ISidebarDomainDefinition {
  domain: TSidebarDomain;
  view: Exclude<TWorkbenchSidebarView, 'ai'>;
  label: string;
  description: string;
}

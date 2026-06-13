import type { TSidebarDomain } from './sidebar.types';
import { SIDEBAR_DOMAINS } from './sidebarMeta';

export const DEFAULT_SIDEBAR_DOMAIN: TSidebarDomain = 'explorer';

export const SIDEBAR_DOMAIN_ORDER: readonly TSidebarDomain[] = SIDEBAR_DOMAINS.map(
  (definition) => definition.domain,
);

export function isSidebarDomain(value: string): value is TSidebarDomain {
  return SIDEBAR_DOMAIN_ORDER.includes(value as TSidebarDomain);
}

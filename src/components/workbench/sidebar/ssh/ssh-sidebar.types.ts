import type { ISshPathSegment } from '@/types/ssh';

export type TSshBreadcrumbItem =
  | (ISshPathSegment & { type: 'segment' })
  | { id: 'ssh-path-ellipsis'; type: 'ellipsis'; segments: ISshPathSegment[] };

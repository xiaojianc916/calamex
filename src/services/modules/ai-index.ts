import { aiService } from '@/services/modules/ai';
import type { IAiQueryIndexPayload } from '@/types/ai';

export const aiIndexService = {
  build(workspaceRootPath: string) {
    return aiService.buildIndex({ workspaceRootPath });
  },
  queryText(workspaceRootPath: string, query: string, limit = 30): Promise<IAiQueryIndexPayload> {
    return aiService.queryIndex({ workspaceRootPath, query, limit });
  },
};
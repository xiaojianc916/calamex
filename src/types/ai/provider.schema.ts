import { z } from 'zod';

import {
  aiConfigPayloadSchema,
  aiCredentialStatusPayloadSchema,
  aiModelEndpointConfigPayloadSchema,
  aiModelRoleSchema,
  aiProviderConnectionPayloadSchema,
  aiProviderConnectionRequestSchema,
  aiProviderTestPayloadSchema,
  aiProviderTypeSchema,
  aiSaveCredentialsRequestSchema,
} from '@/types/ai/schema';

export const aiProviderCatalogEntrySchema = z.object({
  providerType: aiProviderTypeSchema,
  label: z.string().trim().min(1),
  roles: z.array(aiModelRoleSchema).min(1),
  modelIds: z.array(z.string().trim().min(1)),
});

export {
  aiConfigPayloadSchema,
  aiCredentialStatusPayloadSchema,
  aiModelEndpointConfigPayloadSchema,
  aiModelRoleSchema,
  aiProviderConnectionPayloadSchema,
  aiProviderConnectionRequestSchema,
  aiProviderTestPayloadSchema,
  aiProviderTypeSchema,
  aiSaveCredentialsRequestSchema,
};

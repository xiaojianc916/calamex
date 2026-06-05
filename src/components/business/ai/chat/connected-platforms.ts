import type { IAiCredentialStatusPayload } from '@/types/ai';

/**
 * 从 AI 配置的凭证列表中收集「后台已配置 key」的厂商 platform id 集合。
 *
 * 只有 `hasCredentials === true` 的厂商才会进入集合;model picker 据此决定是否
 * 展示「已接入」徽标 —— 未在后台配置 key 的厂商不展示任何徽标。
 */
export const collectConnectedPlatformIds = (
  credentials: readonly IAiCredentialStatusPayload[] | undefined,
): ReadonlySet<string> =>
  new Set(
    (credentials ?? [])
      .filter((credential) => credential.hasCredentials)
      .map((credential) => credential.providerId),
  );

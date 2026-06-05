import { describe, expect, it } from 'vitest';
import { collectConnectedPlatformIds } from '@/components/business/ai/chat/connected-platforms';
import type { IAiCredentialStatusPayload } from '@/types/ai';

const credential = (providerId: string, hasCredentials: boolean): IAiCredentialStatusPayload => ({
  providerId,
  hasCredentials,
  alias: '默认',
  keyPreview: '',
});

describe('collectConnectedPlatformIds', () => {
  it('returns an empty set when credentials are missing or empty', () => {
    expect(collectConnectedPlatformIds(undefined).size).toBe(0);
    expect(collectConnectedPlatformIds([]).size).toBe(0);
  });

  it('includes only providers whose key is configured in the backend', () => {
    const result = collectConnectedPlatformIds([
      credential('alibaba', true),
      credential('zhipuai', false),
      credential('openai', true),
    ]);

    expect([...result].sort()).toEqual(['alibaba', 'openai']);
    expect(result.has('zhipuai')).toBe(false);
  });
});

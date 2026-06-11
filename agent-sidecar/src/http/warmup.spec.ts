import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { disposeWarmupScheduler, scheduleBackgroundWarmup } from './warmup.js';

const warmupInput = {
  modelConfig: {
    modelId: 'openai/gpt-4o-mini',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
  },
};

const waitForMacrotask = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

describe('background LLM warmup lifecycle', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    disposeWarmupScheduler();
    globalThis.fetch = originalFetch;
  });

  it('cancels scheduled warmups before they start', async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('fetch should not be called');
    }) as typeof fetch;

    scheduleBackgroundWarmup(warmupInput, 'test');
    disposeWarmupScheduler();
    await waitForMacrotask();

    assert.equal(fetchCalls, 0);
  });

  it('aborts an active warmup when the scheduler is disposed', async () => {
    let fetchCalls = 0;
    let capturedSignal: AbortSignal | null = null as AbortSignal | null;
    let resolveFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });

    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1;
      capturedSignal = init?.signal ?? null;
      resolveFetchStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }) as typeof fetch;

    scheduleBackgroundWarmup(warmupInput, 'test');
    await fetchStarted;

    assert.equal(fetchCalls, 1);
    assert.ok(capturedSignal, 'expected warmup fetch to receive an abort signal');
    assert.equal(capturedSignal.aborted, false);

    disposeWarmupScheduler();
    assert.equal(capturedSignal.aborted, true);
  });
});

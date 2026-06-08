#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

const file = 'src/store/git.ts';
const filePath = resolve(root, file);

const originalText = readFileSync(filePath, 'utf8');
const eol = originalText.includes('\r\n') ? '\r\n' : '\n';
let text = originalText.replace(/\r\n/g, '\n');

const replaceExact = (description, oldText, newText) => {
  const count = text.split(oldText).length - 1;

  if (count === 0) {
    if (text.includes(newText.trim())) {
      console.log(`skipped ${file}: ${description} already applied`);
      return false;
    }

    throw new Error(
      [
        `${file}: ${description} not found`,
        'Expected snippet:',
        oldText,
      ].join('\n'),
    );
  }

  if (count !== 1) {
    throw new Error(
      `${file}: ${description} expected 1 occurrence, found ${count}`,
    );
  }

  text = text.replace(oldText, newText);
  console.log(`patched ${file}: ${description}`);
  return true;
};

const insertAfter = (description, anchor, insertion, alreadyAppliedNeedle) => {
  if (text.includes(alreadyAppliedNeedle)) {
    console.log(`skipped ${file}: ${description} already applied`);
    return false;
  }

  if (!text.includes(anchor)) {
    throw new Error(
      [
        `${file}: ${description} anchor not found`,
        'Expected anchor:',
        anchor,
      ].join('\n'),
    );
  }

  text = text.replace(anchor, `${anchor}${insertion}`);
  console.log(`patched ${file}: ${description}`);
  return true;
};

insertAfter(
  'add PR persistent cache constants',
  `const PULL_REQUEST_DETAIL_CACHE_LIMIT = 20;
`,
  `const PULL_REQUEST_PERSISTED_CACHE_PREFIX = 'calamex.gitPullRequests.';
const PULL_REQUEST_PERSISTED_CACHE_VERSION = 1;
`,
  `const PULL_REQUEST_PERSISTED_CACHE_PREFIX =`,
);

insertAfter(
  'add PR persistent cache helpers',
  `const createPullRequestDetailCacheKey = (repositoryRootPath: string, number: number): string =>
  \`${'${normalizeFileSystemPath(repositoryRootPath)}|${number}'}\`;

`,
  `type TPersistedPullRequestListCache = {
  version: number;
  fetchedAt: number;
  payload: IGitPullRequestSummaryPayload[];
};

type TPersistedPullRequestDetailCache = {
  version: number;
  fetchedAt: number;
  payload: IGitPullRequestDetailPayload;
};

const createPullRequestPersistedCacheKey = (
  kind: 'list' | 'detail',
  cacheKey: string,
): string =>
  \`${'${PULL_REQUEST_PERSISTED_CACHE_PREFIX}${PULL_REQUEST_PERSISTED_CACHE_VERSION}.${kind}.${encodeURIComponent(cacheKey)}'}\`;

const getPullRequestPersistentStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const readPersistedPullRequestList = (
  cacheKey: string,
): TPersistedPullRequestListCache | null => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return null;

  try {
    const rawValue = storage.getItem(createPullRequestPersistedCacheKey('list', cacheKey));
    if (!rawValue) return null;

    const parsed = JSON.parse(rawValue) as Partial<TPersistedPullRequestListCache>;
    if (
      parsed.version !== PULL_REQUEST_PERSISTED_CACHE_VERSION ||
      typeof parsed.fetchedAt !== 'number' ||
      !Array.isArray(parsed.payload)
    ) {
      return null;
    }

    return {
      version: PULL_REQUEST_PERSISTED_CACHE_VERSION,
      fetchedAt: parsed.fetchedAt,
      payload: parsed.payload,
    };
  } catch {
    return null;
  }
};

const writePersistedPullRequestList = (
  cacheKey: string,
  payload: IGitPullRequestSummaryPayload[],
  fetchedAt: number,
): void => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return;

  try {
    storage.setItem(
      createPullRequestPersistedCacheKey('list', cacheKey),
      JSON.stringify({
        version: PULL_REQUEST_PERSISTED_CACHE_VERSION,
        fetchedAt,
        payload,
      } satisfies TPersistedPullRequestListCache),
    );
  } catch {
    // Best-effort cache snapshot only.
  }
};

const readPersistedPullRequestDetail = (
  cacheKey: string,
): TPersistedPullRequestDetailCache | null => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return null;

  try {
    const rawValue = storage.getItem(createPullRequestPersistedCacheKey('detail', cacheKey));
    if (!rawValue) return null;

    const parsed = JSON.parse(rawValue) as Partial<TPersistedPullRequestDetailCache>;
    if (
      parsed.version !== PULL_REQUEST_PERSISTED_CACHE_VERSION ||
      typeof parsed.fetchedAt !== 'number' ||
      !parsed.payload
    ) {
      return null;
    }

    return {
      version: PULL_REQUEST_PERSISTED_CACHE_VERSION,
      fetchedAt: parsed.fetchedAt,
      payload: parsed.payload,
    };
  } catch {
    return null;
  }
};

const writePersistedPullRequestDetail = (
  cacheKey: string,
  payload: IGitPullRequestDetailPayload,
  fetchedAt: number,
): void => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return;

  try {
    storage.setItem(
      createPullRequestPersistedCacheKey('detail', cacheKey),
      JSON.stringify({
        version: PULL_REQUEST_PERSISTED_CACHE_VERSION,
        fetchedAt,
        payload,
      } satisfies TPersistedPullRequestDetailCache),
    );
  } catch {
    // Best-effort cache snapshot only.
  }
};

const removePersistedPullRequestCache = (
  kind: 'list' | 'detail',
  cacheKey: string,
): void => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return;

  try {
    storage.removeItem(createPullRequestPersistedCacheKey(kind, cacheKey));
  } catch {
    // Best-effort cache cleanup only.
  }
};

const removePersistedPullRequestCachesForRepository = (
  repositoryRootPath?: string | null,
): void => {
  const storage = getPullRequestPersistentStorage();
  const normalizedRepositoryRootPath = normalizeFileSystemPath(repositoryRootPath);
  if (!storage || !normalizedRepositoryRootPath) return;

  const encodedRepositoryPrefix = encodeURIComponent(\`${'${normalizedRepositoryRootPath}|'}\`);
  const listPrefix = \`${'${PULL_REQUEST_PERSISTED_CACHE_PREFIX}${PULL_REQUEST_PERSISTED_CACHE_VERSION}.list.${encodedRepositoryPrefix}'}\`;
  const detailPrefix = \`${'${PULL_REQUEST_PERSISTED_CACHE_PREFIX}${PULL_REQUEST_PERSISTED_CACHE_VERSION}.detail.${encodedRepositoryPrefix}'}\`;
  const keysToRemove: string[] = [];

  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && (key.startsWith(listPrefix) || key.startsWith(detailPrefix))) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => storage.removeItem(key));
  } catch {
    // Best-effort cache cleanup only.
  }
};

`,
  `type TPersistedPullRequestListCache =`,
);

insertAfter(
  'add PR persistent cache hydration helpers',
  `  const invalidatePullRequestListCache = (): void => {
    pullRequestListCache.value = {};
    pullRequestListFetchedAt.value = {};
    pendingPullRequestListRequests.clear();
  };

`,
  `  const hydratePullRequestListCache = (cacheKey: string): void => {
    if (pullRequestListCache.value[cacheKey]) return;

    const persisted = readPersistedPullRequestList(cacheKey);
    if (!persisted) return;

    pullRequestListCache.value = {
      ...pullRequestListCache.value,
      [cacheKey]: persisted.payload,
    };
    pullRequestListFetchedAt.value = {
      ...pullRequestListFetchedAt.value,
      [cacheKey]: persisted.fetchedAt,
    };
  };

  const hydratePullRequestDetailCache = (cacheKey: string): void => {
    if (pullRequestDetailCache.value[cacheKey]) return;

    const persisted = readPersistedPullRequestDetail(cacheKey);
    if (!persisted) return;

    pullRequestDetailCache.value = {
      ...pullRequestDetailCache.value,
      [cacheKey]: persisted.payload,
    };
    pullRequestDetailFetchedAt.value = {
      ...pullRequestDetailFetchedAt.value,
      [cacheKey]: persisted.fetchedAt,
    };
    pullRequestDetailCacheOrder.value = [
      cacheKey,
      ...pullRequestDetailCacheOrder.value.filter((key) => key !== cacheKey),
    ];
  };

`,
  `const hydratePullRequestListCache =`,
);

const oldRememberDetail = `  const rememberPullRequestDetail = (
    cacheKey: string,
    payload: IGitPullRequestDetailPayload,
  ): void => {
    const nextCache = {
      ...pullRequestDetailCache.value,
      [cacheKey]: payload,
    };
    const nextOrder = [
      cacheKey,
      ...pullRequestDetailCacheOrder.value.filter((key) => key !== cacheKey),
    ];
    while (nextOrder.length > PULL_REQUEST_DETAIL_CACHE_LIMIT) {
      const evicted = nextOrder.pop();
      if (evicted) delete nextCache[evicted];
    }
    pullRequestDetailCache.value = nextCache;
    pullRequestDetailCacheOrder.value = nextOrder;
  };`;

const newRememberDetail = `  const rememberPullRequestDetail = (
    cacheKey: string,
    payload: IGitPullRequestDetailPayload,
  ): void => {
    const fetchedAt = Date.now();
    const nextCache = {
      ...pullRequestDetailCache.value,
      [cacheKey]: payload,
    };
    const nextFetchedAt = {
      ...pullRequestDetailFetchedAt.value,
      [cacheKey]: fetchedAt,
    };
    const nextOrder = [
      cacheKey,
      ...pullRequestDetailCacheOrder.value.filter((key) => key !== cacheKey),
    ];
    while (nextOrder.length > PULL_REQUEST_DETAIL_CACHE_LIMIT) {
      const evicted = nextOrder.pop();
      if (evicted) {
        delete nextCache[evicted];
        delete nextFetchedAt[evicted];
        removePersistedPullRequestCache('detail', evicted);
      }
    }
    pullRequestDetailCache.value = nextCache;
    pullRequestDetailFetchedAt.value = nextFetchedAt;
    pullRequestDetailCacheOrder.value = nextOrder;
    writePersistedPullRequestDetail(cacheKey, payload, fetchedAt);
  };`;

if (!text.includes(`writePersistedPullRequestDetail(cacheKey, payload, fetchedAt);`)) {
  replaceExact(
    'persist PR detail cache and record fetchedAt in rememberPullRequestDetail',
    oldRememberDetail,
    newRememberDetail,
  );
} else {
  console.log(`skipped ${file}: PR detail fetchedAt persistence already applied`);
}

const oldListCacheRead = `    const repositoryRootPath = requireRepositoryRootPath();
    const cacheKey = createPullRequestCacheKey(repositoryRootPath, selectedState);
    const cached = pullRequestListCache.value[cacheKey];`;

const newListCacheRead = `    const repositoryRootPath = requireRepositoryRootPath();
    const cacheKey = createPullRequestCacheKey(repositoryRootPath, selectedState);
    hydratePullRequestListCache(cacheKey);
    const cached = pullRequestListCache.value[cacheKey];`;

if (!text.includes(`hydratePullRequestListCache(cacheKey);
    const cached = pullRequestListCache.value[cacheKey];`)) {
  replaceExact('hydrate persisted PR list cache before reading memory cache', oldListCacheRead, newListCacheRead);
} else {
  console.log(`skipped ${file}: PR list hydration already applied`);
}

const oldDetailCacheRead = `    const repositoryRootPath = requireRepositoryRootPath();
    const cacheKey = createPullRequestDetailCacheKey(repositoryRootPath, number);
    const pending = pendingPullRequestDetailRequests.get(cacheKey);`;

const newDetailCacheRead = `    const repositoryRootPath = requireRepositoryRootPath();
    const cacheKey = createPullRequestDetailCacheKey(repositoryRootPath, number);
    hydratePullRequestDetailCache(cacheKey);
    const pending = pendingPullRequestDetailRequests.get(cacheKey);`;

if (!text.includes(`hydratePullRequestDetailCache(cacheKey);
    const pending = pendingPullRequestDetailRequests.get(cacheKey);`)) {
  replaceExact('hydrate persisted PR detail cache before reading memory cache', oldDetailCacheRead, newDetailCacheRead);
} else {
  console.log(`skipped ${file}: PR detail hydration already applied`);
}

const oldMutationFetchedAt = `      nextFetchedAt[cacheKey] = now;
    }

    pullRequestListCache.value = nextCache;`;

const newMutationFetchedAt = `      nextFetchedAt[cacheKey] = now;
      writePersistedPullRequestList(cacheKey, nextCache[cacheKey], now);
    }

    pullRequestListCache.value = nextCache;`;

if (!text.includes(`writePersistedPullRequestList(cacheKey, nextCache[cacheKey], now);`)) {
  replaceExact('persist mutation-updated PR list cache entries', oldMutationFetchedAt, newMutationFetchedAt);
} else {
  console.log(`skipped ${file}: mutation PR list persistence already applied`);
}

const nonStructuralFetchedAtBlock = `        pullRequestListFetchedAt.value = {
          ...pullRequestListFetchedAt.value,
          [cacheKey]: Date.now(),
        };`;

const nonStructuralFetchedAtReplacement = `        const fetchedAt = Date.now();
        pullRequestListFetchedAt.value = {
          ...pullRequestListFetchedAt.value,
          [cacheKey]: fetchedAt,
        };
        writePersistedPullRequestList(cacheKey, payload, fetchedAt);`;

const structuralFetchedAtReplacement = `        const fetchedAt = Date.now();
        pullRequestListFetchedAt.value = {
          ...pullRequestListFetchedAt.value,
          [cacheKey]: fetchedAt,
        };
        writePersistedPullRequestList(cacheKey, nextPayload, fetchedAt);`;

if (!text.includes(`writePersistedPullRequestList(cacheKey, payload, fetchedAt);`) && !text.includes(`writePersistedPullRequestList(cacheKey, nextPayload, fetchedAt);`)) {
  if (text.includes(`const previousCachedPullRequests = pullRequestListCache.value[cacheKey];`)) {
    replaceExact(
      'persist fetched structurally-reused PR list payloads',
      nonStructuralFetchedAtBlock,
      structuralFetchedAtReplacement,
    );
  } else {
    replaceExact(
      'persist fetched PR list payloads',
      nonStructuralFetchedAtBlock,
      nonStructuralFetchedAtReplacement,
    );
  }
} else {
  console.log(`skipped ${file}: fetched PR list persistence already applied`);
}

const oldSetRemoteReset = `      pullRequestSupport.value = payload;
      resetPullRequests();
      return pullRequestSupport.value;`;

const newSetRemoteReset = `      pullRequestSupport.value = payload;
      removePersistedPullRequestCachesForRepository(status.value.repositoryRootPath);
      resetPullRequests();
      return pullRequestSupport.value;`;

if (!text.includes(`removePersistedPullRequestCachesForRepository(status.value.repositoryRootPath);`)) {
  replaceExact('clear persisted PR snapshots when remote changes', oldSetRemoteReset, newSetRemoteReset);
} else {
  console.log(`skipped ${file}: remote-change persisted PR cache cleanup already applied`);
}

writeFileSync(filePath, text.replace(/\n/g, eol), 'utf8');

console.log('done');
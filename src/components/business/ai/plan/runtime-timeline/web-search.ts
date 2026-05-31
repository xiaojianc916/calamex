import {
  WEB_SEARCH_SOURCE_HOST_KEYS,
  WEB_SEARCH_SOURCE_URL_KEYS,
  WEB_SEARCH_TOOL_NAMES,
} from './constants';
import { parsePreviewJson, parsePreviewRecord } from './preview';
import { isNonEmptyString } from './text';
import type { IWebSearchSourceChip } from './types';

export const resolveWebSearchQuery = (value: string | undefined): string | null => {
  const record = parsePreviewRecord(value);
  const candidate = record?.query;

  return isNonEmptyString(candidate) ? candidate.trim() : null;
};

export const getHostname = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url.trim();
  }
};

export const normalizeWebSearchHost = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/^www\./u, '');

export const getDisplayWebSearchUrl = (url: string): string => {
  const host = normalizeWebSearchHost(getHostname(url));

  return host || url.trim();
};

export const collectUrlsFromText = (value: string): string[] => {
  const matches = value.match(/https?:\/\/[^\s"'<>）)]+/giu);

  return matches?.map((url) => url.trim()).filter(Boolean) ?? [];
};

const pushWebSearchSource = (
  sources: IWebSearchSourceChip[],
  seen: Set<string>,
  rawUrl: string,
): void => {
  const url = rawUrl.trim();
  const host = normalizeWebSearchHost(getHostname(url));

  if (!url || !host || seen.has(url)) {
    return;
  }

  if (seen.has(host)) {
    return;
  }

  seen.add(url);
  seen.add(host);
  sources.push({
    url,
    host,
    displayUrl: getDisplayWebSearchUrl(url),
  });
};

const pushWebSearchHostSource = (
  sources: IWebSearchSourceChip[],
  seen: Set<string>,
  rawHost: string,
): void => {
  const host = normalizeWebSearchHost(rawHost);

  if (!host || host.includes('/') || host.includes(':') || seen.has(host)) {
    return;
  }

  seen.add(host);
  sources.push({
    url: host,
    host,
    displayUrl: host,
  });
};

const collectWebSearchSourcesFromValue = (
  value: unknown,
  sources: IWebSearchSourceChip[],
  seen: Set<string>,
  depth = 0,
): void => {
  if (depth > 5 || sources.length >= 6 || value == null) {
    return;
  }

  if (isNonEmptyString(value)) {
    for (const url of collectUrlsFromText(value)) {
      pushWebSearchSource(sources, seen, url);

      if (sources.length >= 6) {
        return;
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectWebSearchSourcesFromValue(item, sources, seen, depth + 1);

      if (sources.length >= 6) {
        return;
      }
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;

  for (const key of WEB_SEARCH_SOURCE_URL_KEYS) {
    const candidate = record[key];

    if (isNonEmptyString(candidate)) {
      pushWebSearchSource(sources, seen, candidate);

      if (sources.length >= 6) {
        return;
      }
    }
  }

  for (const key of WEB_SEARCH_SOURCE_HOST_KEYS) {
    const candidate = record[key];

    if (isNonEmptyString(candidate)) {
      pushWebSearchHostSource(sources, seen, candidate);
    } else if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (isNonEmptyString(item)) {
          pushWebSearchHostSource(sources, seen, item);
        }

        if (sources.length >= 6) {
          return;
        }
      }
    }

    if (sources.length >= 6) {
      return;
    }
  }

  for (const nestedValue of Object.values(record)) {
    collectWebSearchSourcesFromValue(nestedValue, sources, seen, depth + 1);

    if (sources.length >= 6) {
      return;
    }
  }
};

export const resolveWebSearchSources = (value: string | undefined): IWebSearchSourceChip[] => {
  const parsed = parsePreviewJson(value);
  const seen = new Set<string>();
  const sources: IWebSearchSourceChip[] = [];

  collectWebSearchSourcesFromValue(parsed ?? value, sources, seen);

  return sources;
};

export const mergeWebSearchSources = (
  ...groups: readonly (readonly IWebSearchSourceChip[] | undefined)[]
): IWebSearchSourceChip[] | undefined => {
  const seen = new Set<string>();
  const merged: IWebSearchSourceChip[] = [];

  for (const group of groups) {
    if (!group?.length) {
      continue;
    }

    for (const source of group) {
      pushWebSearchSource(merged, seen, source.url);

      if (merged.length >= 6) {
        return merged;
      }
    }
  }

  return merged.length ? merged : undefined;
};

export const isWebSearchToolName = (toolName: string | undefined): boolean =>
  Boolean(
    toolName &&
      (WEB_SEARCH_TOOL_NAMES.has(toolName) ||
        /^tavily(?:-|_)/iu.test(toolName) ||
        /(?:^|[_-])tavily(?:[_-]|$)/iu.test(toolName)),
  );

// Origin 由片段拼接而成，避免传输/构建层将完整字面 URL 改写为占位符。
// 运行时输出严格等于 http 协议的 favicon.localhost 地址。
const FAVICON_ORIGIN = ['http:', '', 'favicon.localhost'].join('/');

export const getFaviconSource = (host: string): string =>
  `${FAVICON_ORIGIN}/${encodeURIComponent(host)}`;

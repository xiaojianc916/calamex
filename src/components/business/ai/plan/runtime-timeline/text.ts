import { PREVIEW_TAG_LIMIT } from './constants';

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const clipTag = (value: string, limit = PREVIEW_TAG_LIMIT): string => {
  const normalized = value.replace(/\s+/gu, ' ').trim();

  if (!normalized) {
    return '';
  }

  const chars = Array.from(normalized);

  if (chars.length <= limit) {
    return normalized;
  }

  return `${chars.slice(0, limit).join('')}...`;
};

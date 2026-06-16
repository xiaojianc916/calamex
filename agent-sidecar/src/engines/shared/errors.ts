import { toRecord } from './utils.js';

export const normalizeMastraError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  const message = toRecord(error)?.message;
  return typeof message === 'string' && message.trim().length > 0
    ? message
    : String(error);
};

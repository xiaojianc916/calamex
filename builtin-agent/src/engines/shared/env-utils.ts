/**
 * Environment variable boolean-string helpers shared across builtin-agent engines.
 */

import { toNonEmptyString } from './utils.js';

export const isTruthyEnv = (value: string | undefined | null): boolean => {
    const normalized = toNonEmptyString(value)?.toLowerCase();
    return (
        normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on'
    );
};

export const isFalsyEnv = (value: string | undefined | null): boolean => {
    const normalized = toNonEmptyString(value)?.toLowerCase();
    return (
        normalized === '0' ||
        normalized === 'false' ||
        normalized === 'no' ||
        normalized === 'off'
    );
};

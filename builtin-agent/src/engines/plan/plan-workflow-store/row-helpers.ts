import type { Row } from '@libsql/client';

// -----------------------------------------------------------------------------
// Row / JSON primitive helpers
// -----------------------------------------------------------------------------

export const toNonEmptyString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

export const rowString = (row: Row, key: string): string => {
    const value = row[key];
    if (typeof value !== 'string') {
        throw new Error(`计划 workflow 字段 ${key} 不是字符串。`);
    }
    return value;
};

export const rowNullableString = (row: Row, key: string): string | null => {
    const value = row[key];
    if (value === null) return null;
    if (typeof value !== 'string') {
        throw new Error(`计划 workflow 字段 ${key} 不是字符串或 null。`);
    }
    return value;
};

export const rowInteger = (row: Row, key: string, { min }: { min: number }): number => {
    const value = row[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= min) {
        return value;
    }
    if (typeof value === 'bigint' && value >= BigInt(min) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(value);
    }
    throw new Error(`计划 workflow 字段 ${key} 不是 >= ${min} 的整数。`);
};

export const parseJsonValue = (value: string): unknown => JSON.parse(value) as unknown;

export const toRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

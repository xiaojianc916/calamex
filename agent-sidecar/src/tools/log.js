import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { PinoLogger } from '@mastra/loggers';
import { FileTransport } from '@mastra/loggers/file';
import { z } from 'zod';
const LOG_LEVEL_VALUES = ['debug', 'info', 'warn', 'error'];
const DEFAULT_PAGE = 1;
const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 200;
const DEFAULT_LOGGER_NAME = 'mastra-sidecar';
const DEFAULT_LOGGER_LEVEL = 'info';
const LOG_TRANSPORT_ID = 'file';
const dateStringSchema = z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'Must be a valid ISO 8601 datetime string (e.g. 2026-05-09T23:59:59Z).',
});
const logLevelSchema = z
    .enum(LOG_LEVEL_VALUES)
    .optional()
    .describe('Minimum log level to filter by.');
const paginationFields = {
    page: z.number().int().min(1).optional()
        .describe(`Page number (1-based). Defaults to ${DEFAULT_PAGE}.`),
    per_page: z.number().int().min(1).max(MAX_PER_PAGE).optional()
        .describe(`Results per page. Defaults to ${DEFAULT_PER_PAGE}, max ${MAX_PER_PAGE}.`),
};
const dateRangeFields = {
    from_date: dateStringSchema.optional()
        .describe('ISO 8601 start date, e.g. 2026-05-01T00:00:00Z.'),
    to_date: dateStringSchema.optional()
        .describe('ISO 8601 end date, e.g. 2026-05-09T23:59:59Z.'),
};
const listLogsInputSchema = z
    .object({
    run_id: z.string().min(1).optional()
        .describe('Optional run ID. If provided, only logs from that run are returned.'),
    log_level: logLevelSchema,
    ...dateRangeFields,
    ...paginationFields,
})
    .superRefine((value, ctx) => {
    if (value.from_date
        && value.to_date
        && Date.parse(value.from_date) > Date.parse(value.to_date)) {
        ctx.addIssue({
            code: 'custom',
            message: 'from_date must be earlier than or equal to to_date.',
            path: ['from_date'],
        });
    }
});
const logEntrySchema = z.looseObject({
    level: z.string(),
    msg: z.string(),
    time: z.string().optional(),
    runId: z.string().optional(),
    destinationPath: z.string().optional(),
    type: z.string().optional(),
});
const listLogsOutputSchema = z.object({
    logs: z.array(logEntrySchema),
    total: z.number(),
    page: z.number(),
    per_page: z.number(),
    has_more: z.boolean(),
});
const isObjectRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const toLogEntry = (raw) => {
    const source = isObjectRecord(raw) ? raw : {};
    const normalized = {
        ...source,
        time: source.time instanceof Date
            ? source.time.toISOString()
            : source.time,
    };
    const parsed = logEntrySchema.safeParse(normalized);
    if (parsed.success) {
        return parsed.data;
    }
    // Fallback：保证 level 和 msg 至少存在为 string，passthrough 字段一并带回
    return logEntrySchema.parse({
        ...normalized,
        level: typeof source.level === 'string' ? source.level : String(source.level ?? 'info'),
        msg: typeof source.msg === 'string' ? source.msg : String(source.msg ?? ''),
    });
};
export const createMastraLoggerRef = () => ({ current: null });
export const ensureMastraLogFile = (logFilePath) => {
    const logDir = dirname(logFilePath);
    if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
    }
    if (!existsSync(logFilePath)) {
        closeSync(openSync(logFilePath, 'a'));
    }
    return logFilePath;
};
export const createMastraFileLogger = (logFilePath, options = {}) => new PinoLogger({
    name: options.name ?? DEFAULT_LOGGER_NAME,
    level: options.level ?? DEFAULT_LOGGER_LEVEL,
    transports: {
        file: new FileTransport({ path: ensureMastraLogFile(logFilePath) }),
    },
    overrideDefaultTransports: false,
});
const buildEmptyResult = (page, perPage) => ({
    logs: [],
    total: 0,
    page: page ?? DEFAULT_PAGE,
    per_page: perPage ?? DEFAULT_PER_PAGE,
    has_more: false,
});
const listLogsToolDescription = [
    'List structured logs written by the Mastra sidecar logger.',
    '',
    'Filtering:',
    '  - run_id: scope to a single agent run',
    '  - log_level: trace | debug | info | warn | error | fatal',
    '  - from_date / to_date: ISO 8601 datetime strings',
    '',
    `Pagination: page (default ${DEFAULT_PAGE}), per_page (default ${DEFAULT_PER_PAGE}, max ${MAX_PER_PAGE}).`,
    '',
    'Use this to inspect recent agent activity, diagnose failures, trace execution steps within a run, or audit tool calls.',
].join('\n');
export const createMastraLogTools = (loggerRef) => ({
    mastra_list_logs: createTool({
        id: 'mastra_list_logs',
        description: listLogsToolDescription,
        inputSchema: listLogsInputSchema,
        outputSchema: listLogsOutputSchema,
        execute: async (inputData) => {
            const { run_id, log_level, from_date, to_date, page, per_page } = listLogsInputSchema.parse(inputData);
            const logger = loggerRef.current;
            if (!logger) {
                return buildEmptyResult(page, per_page);
            }
            const resolvedPage = page ?? DEFAULT_PAGE;
            const resolvedPerPage = per_page ?? DEFAULT_PER_PAGE;
            const baseFilters = {
                ...(log_level ? { logLevel: log_level } : {}),
                ...(from_date ? { fromDate: new Date(from_date) } : {}),
                ...(to_date ? { toDate: new Date(to_date) } : {}),
                page: resolvedPage,
                perPage: resolvedPerPage,
            };
            const result = run_id
                ? await logger.listLogsByRunId({
                    transportId: LOG_TRANSPORT_ID,
                    runId: run_id,
                    ...baseFilters,
                })
                : await logger.listLogs(LOG_TRANSPORT_ID, baseFilters);
            return {
                logs: result.logs.map(toLogEntry),
                total: result.total,
                page: result.page,
                per_page: result.perPage,
                has_more: result.hasMore,
            };
        },
    }),
});

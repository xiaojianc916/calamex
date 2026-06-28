import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

import { PinoLogger } from '@mastra/loggers';
import { FileTransport } from '@mastra/loggers/file';

export const LOG_LEVEL_VALUES = ['debug', 'info', 'warn', 'error'] as const;
export type TLogLevel = (typeof LOG_LEVEL_VALUES)[number];

const DEFAULT_LOGGER_NAME = 'mastra-sidecar';
const DEFAULT_LOGGER_LEVEL: TLogLevel = 'info';

export interface IMastraLogToolsRef {
    current: PinoLogger | null;
}

export const createMastraLoggerRef = (): IMastraLogToolsRef => ({ current: null });

export const ensureMastraLogFile = (logFilePath: string): string => {
    const logDir = dirname(logFilePath);
    if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
    }
    if (!existsSync(logFilePath)) {
        closeSync(openSync(logFilePath, 'a'));
    }
    return logFilePath;
};

export interface ICreateMastraFileLoggerOptions {
    name?: string;
    level?: TLogLevel;
}

export const createMastraFileLogger = (
    logFilePath: string,
    options: ICreateMastraFileLoggerOptions = {},
): PinoLogger => new PinoLogger({
    name: options.name ?? DEFAULT_LOGGER_NAME,
    level: options.level ?? DEFAULT_LOGGER_LEVEL,
    transports: {
        file: new FileTransport({ path: ensureMastraLogFile(logFilePath) }),
    },
    overrideDefaultTransports: false,
});

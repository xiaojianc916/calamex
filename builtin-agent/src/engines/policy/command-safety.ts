export type TTerminalCommandSafetyStatus = 'safe' | 'unsafe' | 'unsupported';

export interface ITerminalCommandSafetyResult {
    status: TTerminalCommandSafetyStatus;
    reason?: string;
    commands: string[];
}

const SHELL_INTERPOLATION_PATTERNS: readonly RegExp[] = [
    /`[^`]*`/u,
    /\$\(/u,
    /<\(/u,
    />\(/u,
    /\$\{[^}]+\}/u,
    /\$[A-Za-z_][A-Za-z0-9_]*/u,
];

const RM_FLAG_PATTERN = /^-(?=[A-Za-z]*[rR])(?=[A-Za-z]*[fF])[A-Za-z]+$/u;
const RM_LONG_RECURSIVE_FLAGS = new Set(['--recursive']);
const RM_LONG_FORCE_FLAGS = new Set(['--force']);
const MAX_NESTED_SHELL_ANALYSIS_DEPTH = 4;

const stripMatchingQuotes = (value: string): string => {
    if (value.length < 2) {
        return value;
    }
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '\'' && last === '\'') || (first === '"' && last === '"')) {
        return value.slice(1, -1);
    }
    return value;
};

const normalizeShellToken = (token: string): string =>
    stripMatchingQuotes(token.trim()).replace(/\\([^\n])/gu, '$1');

const hasBalancedQuotes = (command: string): boolean => {
    let quote: '\'' | '"' | null = null;
    let escaped = false;
    for (const char of command) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === '\'' || char === '"') {
            quote = char;
        }
    }
    return quote === null && !escaped;
};

export const splitShellCommands = (command: string): string[] | null => {
    if (!hasBalancedQuotes(command)) {
        return null;
    }

    const commands: string[] = [];
    let quote: '\'' | '"' | null = null;
    let escaped = false;
    let start = 0;

    const push = (end: number): void => {
        const part = command.slice(start, end).trim();
        if (part) {
            commands.push(part);
        }
    };

    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        const next = command[index + 1];

        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === '\'' || char === '"') {
            quote = char;
            continue;
        }

        if (char === '&' && next === '&') {
            push(index);
            index += 1;
            start = index + 1;
            continue;
        }
        if (char === '|' && next === '|') {
            push(index);
            index += 1;
            start = index + 1;
            continue;
        }
        if (char === ';' || char === '|' || char === '&' || char === '\n') {
            push(index);
            start = index + 1;
        }
    }

    push(command.length);
    return commands;
};

export const splitShellWords = (command: string): string[] | null => {
    if (!hasBalancedQuotes(command)) {
        return null;
    }

    const words: string[] = [];
    let quote: '\'' | '"' | null = null;
    let escaped = false;
    let current = '';

    const push = (): void => {
        if (current.trim()) {
            words.push(normalizeShellToken(current));
        }
        current = '';
    };

    for (const char of command) {
        if (escaped) {
            current += `\\${char}`;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            current += char;
            if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === '\'' || char === '"') {
            quote = char;
            current += char;
            continue;
        }
        if (/\s/u.test(char)) {
            push();
            continue;
        }
        current += char;
    }

    if (escaped) {
        return null;
    }
    push();
    return words;
};

export const normalizePosixPathLexically = (rawPath: string): string => {
    const value = rawPath.replace(/\\/gu, '/').replace(/\/+/gu, '/');
    const prefix = value.startsWith('/') ? '/' : '';
    const parts: string[] = [];
    for (const part of value.split('/')) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            if (parts.length > 0 && parts[parts.length - 1] !== '..') {
                parts.pop();
            } else if (!prefix) {
                parts.push('..');
            }
            continue;
        }
        parts.push(part);
    }
    const joined = parts.join('/');
    if (prefix) {
        return joined ? `/${joined}` : '/';
    }
    return joined || '.';
};

const normalizeHomePath = (path: string): string => {
    if (path === '$HOME' || path === '${HOME}') {
        return '$HOME';
    }
    for (const prefix of ['$HOME/', '${HOME}/']) {
        if (path.startsWith(prefix)) {
            const normalizedSuffix = normalizePosixPathLexically(`/${path.slice(prefix.length)}`);
            return normalizedSuffix === '/' ? '$HOME' : `$HOME${normalizedSuffix}`;
        }
    }
    return path;
};

const isDangerousRmTarget = (rawTarget: string): boolean => {
    const target = normalizeHomePath(normalizeShellToken(rawTarget));
    const withoutGlob = target.endsWith('/*') ? target.slice(0, -2) : target;
    const normalized = withoutGlob.startsWith('$HOME')
        ? normalizeHomePath(withoutGlob)
        : normalizePosixPathLexically(withoutGlob);

    return normalized === '/'
        || normalized === '~'
        || normalized === '$HOME'
        || normalized === '.'
        || normalized === '..';
};

const analyzeRmCommand = (words: readonly string[]): ITerminalCommandSafetyResult | null => {
    if (words.length === 0 || words[0]?.toLowerCase() !== 'rm') {
        return null;
    }

    let recursive = false;
    let force = false;
    const targets: string[] = [];
    let pastDoubleDash = false;

    for (const word of words.slice(1)) {
        if (!pastDoubleDash && word === '--') {
            pastDoubleDash = true;
            continue;
        }
        if (!pastDoubleDash && RM_FLAG_PATTERN.test(word)) {
            recursive = true;
            force = true;
            continue;
        }
        if (!pastDoubleDash && RM_LONG_RECURSIVE_FLAGS.has(word)) {
            recursive = true;
            continue;
        }
        if (!pastDoubleDash && RM_LONG_FORCE_FLAGS.has(word)) {
            force = true;
            continue;
        }
        if (!pastDoubleDash && word.startsWith('-')) {
            continue;
        }
        targets.push(word);
    }

    if (targets.some(isDangerousRmTarget)) {
        return {
            status: 'unsafe',
            reason: recursive || force
                ? 'blocked catastrophic recursive deletion target'
                : 'blocked deletion of protected filesystem target',
            commands: [words.join(' ')],
        };
    }

    return null;
};

export const commandContainsShellInterpolation = (command: string): boolean =>
    SHELL_INTERPOLATION_PATTERNS.some((pattern) => pattern.test(command));

const collectNestedShellFragments = (command: string): string[] => {
    const fragments: string[] = [];
    for (const pattern of [/\$\(([^()]*)\)/gu, /`([^`]*)`/gu, /[<>]\(([^()]*)\)/gu]) {
        for (const match of command.matchAll(pattern)) {
            const fragment = match[1]?.trim();
            if (fragment) {
                fragments.push(fragment);
            }
        }
    }
    return fragments;
};

const analyzeTerminalCommandSafetyInner = (
    command: string,
    depth: number,
): ITerminalCommandSafetyResult => {
    const commands = splitShellCommands(command);
    if (!commands) {
        return {
            status: 'unsupported',
            reason: 'terminal command could not be parsed safely',
            commands: [command],
        };
    }

    for (const item of commands) {
        const words = splitShellWords(item);
        if (!words) {
            return {
                status: 'unsupported',
                reason: 'terminal command words could not be parsed safely',
                commands,
            };
        }
        const rmDecision = analyzeRmCommand(words);
        if (rmDecision?.status === 'unsafe') {
            return {
                ...rmDecision,
                commands,
            };
        }
    }

    if (depth < MAX_NESTED_SHELL_ANALYSIS_DEPTH) {
        for (const fragment of collectNestedShellFragments(command)) {
            const nested = analyzeTerminalCommandSafetyInner(fragment, depth + 1);
            if (nested.status === 'unsafe') {
                return {
                    ...nested,
                    commands: [...commands, ...nested.commands],
                };
            }
        }
    }

    if (commandContainsShellInterpolation(command)) {
        return {
            status: 'unsupported',
            reason: 'terminal command uses shell interpolation or substitution',
            commands,
        };
    }

    return {
        status: 'safe',
        commands,
    };
};

export const analyzeTerminalCommandSafety = (
    command: string,
): ITerminalCommandSafetyResult => analyzeTerminalCommandSafetyInner(command, 0);

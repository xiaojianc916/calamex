import { randomUUID } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ModelRouterEmbeddingModel, type MastraModelConfig } from '@mastra/core/llm';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { z } from 'zod';

import type { IAgentRuntimeInput } from './runtime-input.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_MEMORY_LAST_MESSAGES = 6;
const MIN_MEMORY_LAST_MESSAGES = 2;
const MAX_MEMORY_LAST_MESSAGES = 12;
const DEFAULT_SEMANTIC_RECALL_TOP_K = 4;

const DEFAULT_APP_IDENTIFIER = 'com.xiaojianc.Calamex';
const DEFAULT_STORAGE_DIRECTORY = 'agent-sidecar';
const DEFAULT_STORAGE_FILENAME = 'mastra.db';

const RESOURCE_SCOPE_WORKSPACE_PREFIX = 'workspace:';
const RESOURCE_SCOPE_SESSION_PREFIX = 'agent-sidecar:session:';

const STORAGE_ID = 'agent-sidecar-memory-storage';
const VECTOR_ID = 'agent-sidecar-memory-vector';

const PROJECT_DIR_NAME = '.mastracode';
const PROJECT_JSON_NAME = 'project.json';

// RFC 4122 v1–v5 UUID, case-insensitive.
const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// -----------------------------------------------------------------------------
// Env var keys
//
// AGENT_SIDECAR_STORAGE_ROOT
//   Absolute path; overrides the platform-specific storage directory.
// AGENT_SIDECAR_LIBSQL_URL
//   Full libsql:// or file:// URL. If set, bypasses directory resolution.
// AGENT_SIDECAR_MEMORY_LAST_MESSAGES
//   Integer in [2, 12]. Out-of-range or non-integer values are clamped/ignored
//   with a console.warn.
// AGENT_SIDECAR_MEMORY_EMBEDDER_MODEL
//   Model identifier passed to ModelRouterEmbeddingModel. Required to enable
//   semantic recall.
// AGENT_SIDECAR_MEMORY_ENABLE_SEMANTIC_RECALL
//   Falsy ("0"/"false"/"no"/"off") explicitly disables semantic recall.
//   Otherwise semantic recall is enabled iff AGENT_SIDECAR_MEMORY_EMBEDDER_MODEL
//   is set.
// AGENT_SIDECAR_MEMORY_ENABLE_OBSERVATIONAL
//   Falsy ("0"/"false"/"no"/"off") explicitly disables observational memory.
//   Otherwise observational memory is enabled by default.
// AGENT_SIDECAR_MEMORY_ENABLE_OBSERVATIONAL_BUFFERING
//   Truthy to let Mastra buffer observation tokens. Defaults to false.
// -----------------------------------------------------------------------------

const MEMORY_LAST_MESSAGES_ENV = 'AGENT_SIDECAR_MEMORY_LAST_MESSAGES';
const ENABLE_SEMANTIC_RECALL_ENV = 'AGENT_SIDECAR_MEMORY_ENABLE_SEMANTIC_RECALL';
const ENABLE_OBSERVATIONAL_MEMORY_ENV = 'AGENT_SIDECAR_MEMORY_ENABLE_OBSERVATIONAL';
const ENABLE_OBSERVATIONAL_MEMORY_BUFFERING_ENV =
    'AGENT_SIDECAR_MEMORY_ENABLE_OBSERVATIONAL_BUFFERING';

// -----------------------------------------------------------------------------
// Working memory schema
//
// Array caps below are intentional truncation limits passed to Mastra so the
// LLM doesn't bloat working memory indefinitely. Tune cautiously: raising them
// increases prompt size on every turn.
// -----------------------------------------------------------------------------

const optionalTrimmedStringSchema = z.string().trim().min(1).optional();

export const mastraWorkingMemorySchema = z.object({
    currentTask: z
        .object({
            goal: optionalTrimmedStringSchema,
            phase: z.enum(['responding', 'planning', 'executing', 'reviewing']).optional(),
            status: z.enum(['active', 'blocked', 'completed']).optional(),
            lastStopReason: optionalTrimmedStringSchema,
        })
        .optional(),
    constraints: z.array(z.string().trim().min(1)).max(10).optional(),
    importantFacts: z.array(z.string().trim().min(1)).max(20).optional(),
    decisions: z.array(z.string().trim().min(1)).max(10).optional(),
    openQuestions: z.array(z.string().trim().min(1)).max(10).optional(),
});

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface IMastraMemoryScope {
    thread: string;
    resource: string;
}

export interface ICreateMastraMemoryScopeOptions {
    /**
     * Durable agent processors bind the workflow run to a session resource.
     * Use this when the same run may suspend/resume or execute workspace tools.
     */
    resourceScope?: 'workspace' | 'session';
}

/**
 * Structurally identical to IMastraMemoryScope. Kept as a distinct nominal
 * type for call sites that want to express "this is a memory reference passed
 * to a Mastra API" vs "this is the scope of a session". The helper below is a
 * passthrough.
 */
export interface IMastraMemoryReference {
    thread: string;
    resource: string;
}

// -----------------------------------------------------------------------------
// Env helpers
// -----------------------------------------------------------------------------

const toNonEmptyString = (value: string | undefined | null): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

const isTruthyEnv = (value: string | undefined | null): boolean => {
    const normalized = toNonEmptyString(value)?.toLowerCase();
    return (
        normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on'
    );
};

const isFalsyEnv = (value: string | undefined | null): boolean => {
    const normalized = toNonEmptyString(value)?.toLowerCase();
    return (
        normalized === '0' ||
        normalized === 'false' ||
        normalized === 'no' ||
        normalized === 'off'
    );
};

// -----------------------------------------------------------------------------
// Resolvers
// -----------------------------------------------------------------------------

export const resolveMemoryLastMessages = (
    env: NodeJS.ProcessEnv = process.env,
): number => {
    const configured = toNonEmptyString(env[MEMORY_LAST_MESSAGES_ENV]);
    if (!configured) return DEFAULT_MEMORY_LAST_MESSAGES;

    const parsed = Number.parseFloat(configured);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        console.warn(
            `[agent-sidecar] ${MEMORY_LAST_MESSAGES_ENV}="${configured}" is not a valid integer; falling back to ${DEFAULT_MEMORY_LAST_MESSAGES}.`,
        );
        return DEFAULT_MEMORY_LAST_MESSAGES;
    }

    const clamped = Math.min(
        MAX_MEMORY_LAST_MESSAGES,
        Math.max(MIN_MEMORY_LAST_MESSAGES, parsed),
    );
    if (clamped !== parsed) {
        console.warn(
            `[agent-sidecar] ${MEMORY_LAST_MESSAGES_ENV}=${parsed} out of [${MIN_MEMORY_LAST_MESSAGES}, ${MAX_MEMORY_LAST_MESSAGES}]; clamped to ${clamped}.`,
        );
    }
    return clamped;
};

const resolveSemanticRecallEmbedderModel = (
    env: NodeJS.ProcessEnv = process.env,
): string | null => toNonEmptyString(env.AGENT_SIDECAR_MEMORY_EMBEDDER_MODEL);

/**
 * Semantic recall is enabled when an embedder model is configured, unless
 * AGENT_SIDECAR_MEMORY_ENABLE_SEMANTIC_RECALL is explicitly falsy. Setting the
 * env truthy without an embedder model is still treated as disabled — we can't
 * recall without an embedder.
 */
export const resolveSemanticRecallEnabled = (
    env: NodeJS.ProcessEnv = process.env,
): boolean => {
    if (resolveSemanticRecallEmbedderModel(env) === null) return false;
    if (isFalsyEnv(env[ENABLE_SEMANTIC_RECALL_ENV])) return false;
    return true;
};

export const resolveObservationalMemoryEnabled = (
    env: NodeJS.ProcessEnv = process.env,
): boolean => !isFalsyEnv(env[ENABLE_OBSERVATIONAL_MEMORY_ENV]);

export const resolveObservationalMemoryBufferingEnabled = (
    env: NodeJS.ProcessEnv = process.env,
): boolean => isTruthyEnv(env[ENABLE_OBSERVATIONAL_MEMORY_BUFFERING_ENV]);

export interface IMastraObservationalMemoryModels {
    observer: MastraModelConfig;
    reflector: MastraModelConfig;
}

/**
 * Platform-aware default storage directory. Override with
 * AGENT_SIDECAR_STORAGE_ROOT (absolute path).
 *
 * - win32:  %APPDATA%\com.xiaojianc.Calamex\agent-sidecar
 * - darwin: ~/Library/Application Support/com.xiaojianc.Calamex/agent-sidecar
 * - linux:  $XDG_DATA_HOME/com.xiaojianc.Calamex/agent-sidecar
 *           (fallback ~/.local/share/com.xiaojianc.Calamex/agent-sidecar)
 * - other:  <cwd>/.agent-sidecar
 */
export const resolveMastraStorageDirectory = (
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): string => {
    const configuredRoot = toNonEmptyString(env.AGENT_SIDECAR_STORAGE_ROOT);
    if (configuredRoot) return resolve(configuredRoot);

    const platform = process.platform;

    if (platform === 'win32') {
        const appDataRoot =
            toNonEmptyString(env.APPDATA) ?? toNonEmptyString(env.LOCALAPPDATA);
        if (appDataRoot) {
            return resolve(appDataRoot, DEFAULT_APP_IDENTIFIER, DEFAULT_STORAGE_DIRECTORY);
        }
    } else if (platform === 'darwin') {
        const home = toNonEmptyString(env.HOME) ?? homedir();
        if (home) {
            return resolve(
                home,
                'Library',
                'Application Support',
                DEFAULT_APP_IDENTIFIER,
                DEFAULT_STORAGE_DIRECTORY,
            );
        }
    } else if (platform === 'linux') {
        const xdg = toNonEmptyString(env.XDG_DATA_HOME);
        if (xdg) {
            return resolve(xdg, DEFAULT_APP_IDENTIFIER, DEFAULT_STORAGE_DIRECTORY);
        }
        const home = toNonEmptyString(env.HOME) ?? homedir();
        if (home) {
            return resolve(
                home,
                '.local',
                'share',
                DEFAULT_APP_IDENTIFIER,
                DEFAULT_STORAGE_DIRECTORY,
            );
        }
    }

    return resolve(cwd, '.agent-sidecar');
};

/**
 * Resolve the libsql storage URL, ensuring the parent directory exists.
 * Side effect: creates the storage directory via mkdirSync.
 */
export const resolveMastraStorageUrl = (
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): string => {
    const configuredUrl = toNonEmptyString(env.AGENT_SIDECAR_LIBSQL_URL);
    if (configuredUrl) return configuredUrl;

    const storageDirectory = resolveMastraStorageDirectory(env, cwd);
    mkdirSync(storageDirectory, { recursive: true });
    return pathToFileURL(join(storageDirectory, DEFAULT_STORAGE_FILENAME)).href;
};

// -----------------------------------------------------------------------------
// Project UUID
// -----------------------------------------------------------------------------

const isValidUuid = (value: unknown): value is string =>
    typeof value === 'string' && UUID_REGEX.test(value);

/**
 * Resolve a stable per-workspace UUID, stored at
 * `<workspaceRootPath>/.mastracode/project.json`.
 *
 * Behavior:
 * - If the file exists and contains a valid UUID, return it.
 * - If the file exists but is unreadable / not JSON / missing a valid uuid,
 *   throw — we do NOT silently overwrite, because that would orphan all prior
 *   memory under the old UUID.
 * - If the file does not exist, generate a new UUID and write atomically
 *   (temp file + rename with `wx` flag). On rename collision, prefer the
 *   value written by the racing process if it's valid.
 * - If the atomic write fails entirely, warn and return the in-memory UUID;
 *   memory will be per-session until the underlying issue is fixed.
 */
export const resolveProjectUuid = (workspaceRootPath: string): string => {
    const mastraCodeDir = join(workspaceRootPath, PROJECT_DIR_NAME);
    const projectJsonPath = join(mastraCodeDir, PROJECT_JSON_NAME);

    if (existsSync(projectJsonPath)) {
        let content: string;
        try {
            content = readFileSync(projectJsonPath, 'utf8');
        } catch (error) {
            throw new Error(
                `[agent-sidecar] Failed to read ${projectJsonPath}: ${(error as Error).message}`,
            );
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            throw new Error(
                `[agent-sidecar] ${projectJsonPath} is not valid JSON (${(error as Error).message}). ` +
                `Refusing to overwrite; please repair or delete the file manually.`,
            );
        }

        const uuid = (parsed as { uuid?: unknown } | null)?.uuid;
        if (!isValidUuid(uuid)) {
            throw new Error(
                `[agent-sidecar] ${projectJsonPath} is missing a valid "uuid" field. ` +
                `Refusing to overwrite; please repair or delete the file manually.`,
            );
        }
        return uuid;
    }

    const newUuid = randomUUID();
    try {
        mkdirSync(mastraCodeDir, { recursive: true });

        const tempPath = `${projectJsonPath}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(
            tempPath,
            JSON.stringify({ uuid: newUuid, createdAt: new Date().toISOString() }, null, 2),
            { encoding: 'utf8', flag: 'wx' },
        );
        try {
            renameSync(tempPath, projectJsonPath);
        } catch (renameError) {
            // Another process may have raced us; prefer their value if valid.
            if (existsSync(projectJsonPath)) {
                try {
                    const raced = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as {
                        uuid?: unknown;
                    };
                    if (isValidUuid(raced?.uuid)) {
                        return raced.uuid;
                    }
                } catch {
                    // fall through to rethrow
                }
            }
            throw renameError;
        }
    } catch (error) {
        console.warn(
            `[agent-sidecar] Failed to persist project UUID at ${projectJsonPath}: ${(error as Error).message}. ` +
            `Memory will be per-session until this is fixed.`,
        );
    }
    return newUuid;
};

// -----------------------------------------------------------------------------
// Memory scope / reference
// -----------------------------------------------------------------------------

const resolveSemanticRecallEmbedder = (
    env: NodeJS.ProcessEnv = process.env,
): ModelRouterEmbeddingModel | null => {
    if (!resolveSemanticRecallEnabled(env)) return null;
    const model = resolveSemanticRecallEmbedderModel(env);
    return model ? new ModelRouterEmbeddingModel(model) : null;
};

/**
 * Compute the Mastra memory scope for a session.
 *
 * - `thread` defaults to `input.threadId`, falling back to `fallbackThreadId`.
 * - `resource` is `workspace:<uuid>` when a workspace path is present.
 * - Pass `{ resourceScope: 'session' }` for durable/suspendable runs, where
 *   Mastra processors require every input message to stay on a stable resource.
 *   Explicit UI threads use the thread id so later turns can replay history.
 * - Otherwise it falls back to `agent-sidecar:session:<fallbackThreadId>`,
 *   so unrelated no-workspace sessions don't share working memory.
 */
export const createMastraMemoryScope = (
    input: Pick<IAgentRuntimeInput, 'workspaceRootPath' | 'threadId'>,
    fallbackThreadId: string,
    options: ICreateMastraMemoryScopeOptions = {},
): IMastraMemoryScope => {
    const workspaceRootPath = toNonEmptyString(input.workspaceRootPath ?? null);
    const threadId = toNonEmptyString(input.threadId ?? null) ?? fallbackThreadId;
    const sessionResourceId = toNonEmptyString(input.threadId ?? null) ?? fallbackThreadId;

    if (!workspaceRootPath || options.resourceScope === 'session') {
        return {
            thread: threadId,
            resource: `${RESOURCE_SCOPE_SESSION_PREFIX}${sessionResourceId}`,
        };
    }

    const projectUuid = resolveProjectUuid(workspaceRootPath);
    return {
        thread: threadId,
        resource: `${RESOURCE_SCOPE_WORKSPACE_PREFIX}${projectUuid}`,
    };
};

export const createMastraMemoryReference = (
    scope: IMastraMemoryScope,
): IMastraMemoryReference => ({
    thread: scope.thread,
    resource: scope.resource,
});

// -----------------------------------------------------------------------------
// Memory factory
// -----------------------------------------------------------------------------

/**
 * Build the Mastra `Memory` instance used by the agent sidecar.
 * Configured via env vars — see the "Env var keys" block near the top of this
 * file for the full list.
 */
/**
 * Build the Mastra `Memory` instance used by the agent sidecar.
 * Configured via env vars — see the "Env var keys" block near the top of this
 * file for the full list.
 */
export const createMastraAgentMemory = (
    storageUrl: string,
    observationalMemoryModels: IMastraObservationalMemoryModels,
    env: NodeJS.ProcessEnv = process.env,
): Memory => {
    const embedder = resolveSemanticRecallEmbedder(env);
    const semanticRecallEnabled = embedder !== null;
    const observationalMemoryEnabled = resolveObservationalMemoryEnabled(env);
    const observationalMemoryBufferingEnabled =
        resolveObservationalMemoryBufferingEnabled(env);

    type MemoryCtorArgs = NonNullable<ConstructorParameters<typeof Memory>[0]>;
    type MemoryOpts = NonNullable<MemoryCtorArgs['options']>;

    const options: MemoryOpts = {
        lastMessages: resolveMemoryLastMessages(env),
        workingMemory: {
            enabled: true,
            scope: 'resource',
            schema: mastraWorkingMemorySchema,
        },
    };

    if (observationalMemoryEnabled) {
        // Mastra default = buffering ON. We only set `observation.bufferTokens`
        // when the user explicitly wants buffering OFF.
        options.observationalMemory = observationalMemoryBufferingEnabled
            ? {
                scope: 'thread',
                observation: {
                    model: observationalMemoryModels.observer,
                },
                reflection: {
                    model: observationalMemoryModels.reflector,
                },
            }
            : {
                scope: 'thread',
                observation: {
                    model: observationalMemoryModels.observer,
                    bufferTokens: false,
                },
                reflection: {
                    model: observationalMemoryModels.reflector,
                },
            };
    }

    if (semanticRecallEnabled) {
        options.semanticRecall = {
            topK: DEFAULT_SEMANTIC_RECALL_TOP_K,
            messageRange: { before: 1, after: 1 },
            scope: 'resource',
        };
    }

    const ctorArgs: MemoryCtorArgs = {
        storage: new LibSQLStore({
            id: STORAGE_ID,
            url: storageUrl,
        }),
        options,
    };

    if (semanticRecallEnabled && embedder) {
        ctorArgs.vector = new LibSQLVector({
            id: VECTOR_ID,
            url: storageUrl,
        });
        ctorArgs.embedder = embedder;
    }

    return new Memory(ctorArgs);
};

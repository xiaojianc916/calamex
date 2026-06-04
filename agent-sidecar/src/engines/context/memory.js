import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
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
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
const STORAGE_ROOT_ENV = 'AGENT_SIDECAR_STORAGE_ROOT';
const LIBSQL_URL_ENV = 'AGENT_SIDECAR_LIBSQL_URL';
const MEMORY_LAST_MESSAGES_ENV = 'AGENT_SIDECAR_MEMORY_LAST_MESSAGES';
const EMBEDDER_MODEL_ENV = 'AGENT_SIDECAR_MEMORY_EMBEDDER_MODEL';
const ENABLE_SEMANTIC_RECALL_ENV = 'AGENT_SIDECAR_MEMORY_ENABLE_SEMANTIC_RECALL';
const ENABLE_OBSERVATIONAL_MEMORY_ENV = 'AGENT_SIDECAR_MEMORY_ENABLE_OBSERVATIONAL';
const ENABLE_OBSERVATIONAL_MEMORY_BUFFERING_ENV = 'AGENT_SIDECAR_MEMORY_ENABLE_OBSERVATIONAL_BUFFERING';
// -----------------------------------------------------------------------------
// Working memory schema
//
// Array caps below are intentional truncation limits passed to Mastra so the
// LLM doesn't bloat working memory indefinitely. Tune cautiously: raising them
// increases prompt size on every turn.
// -----------------------------------------------------------------------------
const trimmedNonEmptyStringSchema = z.string().trim().min(1);
const optionalTrimmedStringSchema = trimmedNonEmptyStringSchema.optional();
export const mastraWorkingMemorySchema = z.object({
    currentTask: z
        .object({
        goal: optionalTrimmedStringSchema,
        phase: z.enum(['responding', 'planning', 'executing', 'reviewing']).optional(),
        status: z.enum(['active', 'blocked', 'completed']).optional(),
        lastStopReason: optionalTrimmedStringSchema,
    })
        .optional(),
    constraints: z.array(trimmedNonEmptyStringSchema).max(10).optional(),
    importantFacts: z.array(trimmedNonEmptyStringSchema).max(20).optional(),
    decisions: z.array(trimmedNonEmptyStringSchema).max(10).optional(),
    openQuestions: z.array(trimmedNonEmptyStringSchema).max(10).optional(),
});
// -----------------------------------------------------------------------------
// Env helpers
// -----------------------------------------------------------------------------
const toNonEmptyString = (value) => {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};
const isTruthyEnv = (value) => {
    const normalized = toNonEmptyString(value)?.toLowerCase();
    return (normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on');
};
const isFalsyEnv = (value) => {
    const normalized = toNonEmptyString(value)?.toLowerCase();
    return (normalized === '0' ||
        normalized === 'false' ||
        normalized === 'no' ||
        normalized === 'off');
};
// -----------------------------------------------------------------------------
// Resolvers
// -----------------------------------------------------------------------------
export const resolveMemoryLastMessages = (env = process.env) => {
    const configured = toNonEmptyString(env[MEMORY_LAST_MESSAGES_ENV]);
    if (!configured)
        return DEFAULT_MEMORY_LAST_MESSAGES;
    const parsed = Number.parseFloat(configured);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        console.warn(`[agent-sidecar] ${MEMORY_LAST_MESSAGES_ENV}="${configured}" is not a valid integer; falling back to ${DEFAULT_MEMORY_LAST_MESSAGES}.`);
        return DEFAULT_MEMORY_LAST_MESSAGES;
    }
    const clamped = Math.min(MAX_MEMORY_LAST_MESSAGES, Math.max(MIN_MEMORY_LAST_MESSAGES, parsed));
    if (clamped !== parsed) {
        console.warn(`[agent-sidecar] ${MEMORY_LAST_MESSAGES_ENV}=${parsed} out of [${MIN_MEMORY_LAST_MESSAGES}, ${MAX_MEMORY_LAST_MESSAGES}]; clamped to ${clamped}.`);
    }
    return clamped;
};
const resolveSemanticRecallEmbedderModel = (env = process.env) => toNonEmptyString(env[EMBEDDER_MODEL_ENV]);
/**
 * Semantic recall is enabled when an embedder model is configured, unless
 * AGENT_SIDECAR_MEMORY_ENABLE_SEMANTIC_RECALL is explicitly falsy. Setting the
 * env truthy without an embedder model is still treated as disabled — we can't
 * recall without an embedder.
 */
export const resolveSemanticRecallEnabled = (env = process.env) => {
    if (resolveSemanticRecallEmbedderModel(env) === null)
        return false;
    if (isFalsyEnv(env[ENABLE_SEMANTIC_RECALL_ENV]))
        return false;
    return true;
};
export const resolveObservationalMemoryEnabled = (env = process.env) => !isFalsyEnv(env[ENABLE_OBSERVATIONAL_MEMORY_ENV]);
export const resolveObservationalMemoryBufferingEnabled = (env = process.env) => isTruthyEnv(env[ENABLE_OBSERVATIONAL_MEMORY_BUFFERING_ENV]);
/**
 * Platform-aware default storage directory. Override with
 * AGENT_SIDECAR_STORAGE_ROOT (absolute path).
 *
 * - win32:  %APPDATA%\\com.xiaojianc.Calamex\\agent-sidecar
 * - darwin: ~/Library/Application Support/com.xiaojianc.Calamex/agent-sidecar
 * - linux:  $XDG_DATA_HOME/com.xiaojianc.Calamex/agent-sidecar
 *           (fallback ~/.local/share/com.xiaojianc.Calamex/agent-sidecar)
 * - other:  <cwd>/.agent-sidecar
 */
export const resolveMastraStorageDirectory = (env = process.env, cwd = process.cwd()) => {
    const configuredRoot = toNonEmptyString(env[STORAGE_ROOT_ENV]);
    if (configuredRoot)
        return resolve(configuredRoot);
    switch (process.platform) {
        case 'win32': {
            const appDataRoot = toNonEmptyString(env.APPDATA) ?? toNonEmptyString(env.LOCALAPPDATA);
            if (appDataRoot) {
                return resolve(appDataRoot, DEFAULT_APP_IDENTIFIER, DEFAULT_STORAGE_DIRECTORY);
            }
            break;
        }
        case 'darwin': {
            const home = toNonEmptyString(env.HOME) ?? homedir();
            if (home) {
                return resolve(home, 'Library', 'Application Support', DEFAULT_APP_IDENTIFIER, DEFAULT_STORAGE_DIRECTORY);
            }
            break;
        }
        case 'linux': {
            const xdg = toNonEmptyString(env.XDG_DATA_HOME);
            if (xdg) {
                return resolve(xdg, DEFAULT_APP_IDENTIFIER, DEFAULT_STORAGE_DIRECTORY);
            }
            const home = toNonEmptyString(env.HOME) ?? homedir();
            if (home) {
                return resolve(home, '.local', 'share', DEFAULT_APP_IDENTIFIER, DEFAULT_STORAGE_DIRECTORY);
            }
            break;
        }
        default:
            break;
    }
    return resolve(cwd, '.agent-sidecar');
};
/**
 * Resolve the libsql storage URL, ensuring the parent directory exists.
 * Side effect: creates the storage directory via mkdirSync.
 *
 * AGENT_SIDECAR_LIBSQL_URL takes precedence over AGENT_SIDECAR_STORAGE_ROOT.
 * If both are set, STORAGE_ROOT is ignored and we emit a console.warn so the
 * silent override is observable.
 */
export const resolveMastraStorageUrl = (env = process.env, cwd = process.cwd()) => {
    const configuredUrl = toNonEmptyString(env[LIBSQL_URL_ENV]);
    if (configuredUrl) {
        if (toNonEmptyString(env[STORAGE_ROOT_ENV])) {
            console.warn(`[agent-sidecar] Both ${LIBSQL_URL_ENV} and ${STORAGE_ROOT_ENV} are set; ` +
                `${LIBSQL_URL_ENV} takes precedence and ${STORAGE_ROOT_ENV} is ignored.`);
        }
        return configuredUrl;
    }
    const storageDirectory = resolveMastraStorageDirectory(env, cwd);
    mkdirSync(storageDirectory, { recursive: true });
    return pathToFileURL(join(storageDirectory, DEFAULT_STORAGE_FILENAME)).href;
};
// -----------------------------------------------------------------------------
// Project UUID
// -----------------------------------------------------------------------------
const isValidUuid = (value) => typeof value === 'string' && UUID_REGEX.test(value);
/**
 * Read or create a stable per-workspace UUID, stored at
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
 *
 * **Concurrency caveat**: POSIX `rename(2)` silently overwrites the destination,
 * so two processes racing the "file does not exist → write" branch can each
 * overwrite the other; the last writer wins. The rename-failure recovery branch
 * only catches the Windows scenario where rename-over-existing-file fails with
 * EPERM/EACCES. For desktop-sidecar use this is acceptable — the workspace is
 * typically owned by a single Aster IDE process. If multi-process init becomes
 * a real scenario, switch to an O_CREAT|O_EXCL lockfile pattern.
 *
 * NOTE: This is the uncached implementation. Callers should use
 * `resolveProjectUuid`, which memoizes results per workspace path.
 */
const readOrCreateProjectUuid = (workspaceRootPath) => {
    const mastraCodeDir = join(workspaceRootPath, PROJECT_DIR_NAME);
    const projectJsonPath = join(mastraCodeDir, PROJECT_JSON_NAME);
    if (existsSync(projectJsonPath)) {
        let content;
        try {
            content = readFileSync(projectJsonPath, 'utf8');
        }
        catch (error) {
            throw new Error(`[agent-sidecar] Failed to read ${projectJsonPath}: ${error.message}`);
        }
        let parsed;
        try {
            parsed = JSON.parse(content);
        }
        catch (error) {
            throw new Error(`[agent-sidecar] ${projectJsonPath} is not valid JSON (${error.message}). ` +
                `Refusing to overwrite; please repair or delete the file manually.`);
        }
        const uuid = parsed?.uuid;
        if (!isValidUuid(uuid)) {
            throw new Error(`[agent-sidecar] ${projectJsonPath} is missing a valid "uuid" field. ` +
                `Refusing to overwrite; please repair or delete the file manually.`);
        }
        return uuid;
    }
    const newUuid = randomUUID();
    try {
        mkdirSync(mastraCodeDir, { recursive: true });
        // Tempfile nonce: pid + ms + randomUUID() makes collision practically impossible
        // even under same-millisecond same-pid retry.
        const tempPath = `${projectJsonPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
        writeFileSync(tempPath, JSON.stringify({ uuid: newUuid, createdAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', flag: 'wx' });
        try {
            renameSync(tempPath, projectJsonPath);
        }
        catch (renameError) {
            // Windows: rename over existing file can fail with EPERM/EACCES.
            // If another process raced us and produced a valid UUID, defer to it.
            if (existsSync(projectJsonPath)) {
                try {
                    const raced = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
                    if (isValidUuid(raced?.uuid)) {
                        return raced.uuid;
                    }
                }
                catch {
                    // fall through to rethrow
                }
            }
            throw renameError;
        }
    }
    catch (error) {
        // Asymmetric with the read path above: read-failure throws (data corruption
        // needs human attention), but write-failure degrades to per-session UUID
        // (disk-full / EACCES is typically transient or environmental).
        console.warn(`[agent-sidecar] Failed to persist project UUID at ${projectJsonPath}: ${error.message}. ` +
            `Memory will be per-session until this is fixed.`);
    }
    return newUuid;
};
/**
 * Process-lifetime cache of resolved project UUIDs, keyed by workspace path.
 *
 * `createMastraMemoryScope` runs on every request and would otherwise hit the
 * filesystem (existsSync + readFileSync) each time. The project UUID is
 * immutable once created, so memoizing for the process lifetime is safe. It
 * also stabilizes the write-failure degraded path: instead of minting a fresh
 * random UUID on every call (fragmenting memory), a single per-process UUID is
 * reused until the process restarts.
 */
const projectUuidCache = new Map();
/**
 * Cached accessor for the stable per-workspace UUID. See
 * `readOrCreateProjectUuid` for the underlying read/create semantics.
 */
export const resolveProjectUuid = (workspaceRootPath) => {
    const cached = projectUuidCache.get(workspaceRootPath);
    if (cached !== undefined) {
        return cached;
    }
    const uuid = readOrCreateProjectUuid(workspaceRootPath);
    projectUuidCache.set(workspaceRootPath, uuid);
    return uuid;
};
// -----------------------------------------------------------------------------
// Memory scope / reference
// -----------------------------------------------------------------------------
const resolveSemanticRecallEmbedder = (env = process.env) => {
    if (!resolveSemanticRecallEnabled(env))
        return null;
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
 * - Otherwise it falls back to `agent-sidecar:session:<threadId>`,
 *   so unrelated no-workspace sessions don't share working memory.
 */
export const createMastraMemoryScope = (input, fallbackThreadId, options = {}) => {
    const workspaceRootPath = toNonEmptyString(input.workspaceRootPath ?? null);
    const threadId = toNonEmptyString(input.threadId ?? null) ?? fallbackThreadId;
    if (!workspaceRootPath || options.resourceScope === 'session') {
        // Session-scoped resource: each thread gets its own resource id,
        // preventing working-memory bleed across unrelated no-workspace runs.
        return {
            thread: threadId,
            resource: `${RESOURCE_SCOPE_SESSION_PREFIX}${threadId}`,
        };
    }
    const projectUuid = resolveProjectUuid(workspaceRootPath);
    return {
        thread: threadId,
        resource: `${RESOURCE_SCOPE_WORKSPACE_PREFIX}${projectUuid}`,
    };
};
/**
 * Passthrough by design — see jsdoc on IMastraMemoryReference.
 * Returns a shallow copy so callers can mutate one without affecting the other.
 */
export const createMastraMemoryReference = (scope) => ({ ...scope });
// -----------------------------------------------------------------------------
// Memory factory
// -----------------------------------------------------------------------------
/**
 * Build the Mastra `Memory` instance used by the agent sidecar.
 * Configured via env vars — see the "Env var keys" block near the top of this
 * file for the full list.
 */
export const createMastraAgentMemory = (storageUrl, observationalMemoryModels, env = process.env) => {
    const embedder = resolveSemanticRecallEmbedder(env);
    const semanticRecallEnabled = embedder !== null;
    const observationalMemoryEnabled = resolveObservationalMemoryEnabled(env);
    const observationalMemoryBufferingEnabled = resolveObservationalMemoryBufferingEnabled(env);
    const options = {
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
                // `activateAfterIdle: 'auto'` lets Mastra pick a provider-aware
                // prompt-cache TTL and force-activate buffered observations once a
                // thread has been idle long enough that the prompt cache would
                // expire — so the next uncached request sends compressed
                // observations instead of a large raw message window. Top-level
                // setting applies to observations. Only meaningful when async
                // buffering is on (this branch).
                activateAfterIdle: 'auto',
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
    const ctorArgs = {
        storage: new LibSQLStore({
            id: STORAGE_ID,
            url: storageUrl,
        }),
        options,
    };
    if (semanticRecallEnabled && embedder) {
        // LibSQLStore 与 LibSQLVector 共用同一个 sqlite 文件 —— 这是 mastra 推荐
        // 模式(单 db 内分 schema),节省 file handle。如果将来需要把 vector 索引
        // 隔离到独立文件,改这里。
        ctorArgs.vector = new LibSQLVector({
            id: VECTOR_ID,
            url: storageUrl,
        });
        ctorArgs.embedder = embedder;
    }
    return new Memory(ctorArgs);
};

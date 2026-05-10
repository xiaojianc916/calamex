import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { z } from 'zod';

import type { IAgentRuntimeInput } from './runtime-input.js';

const DEFAULT_MEMORY_LAST_MESSAGES = 12;
const DEFAULT_SEMANTIC_RECALL_TOP_K = 4;
const DEFAULT_MEMORY_RESOURCE_ID = 'agent-sidecar:global';
const DEFAULT_APP_IDENTIFIER = 'com.xiaojianc.Calamex';
const DEFAULT_STORAGE_DIRECTORY = 'agent-sidecar';
const DEFAULT_STORAGE_FILENAME = 'mastra.db';

const optionalTrimmedStringSchema = z.string().trim().min(1).optional();

export const mastraWorkingMemorySchema = z.object({
    currentTask: z.object({
        goal: optionalTrimmedStringSchema,
        phase: z.enum(['responding', 'planning', 'executing', 'reviewing']).optional(),
        status: z.enum(['active', 'blocked', 'completed']).optional(),
        lastStopReason: optionalTrimmedStringSchema,
    }).optional(),
    constraints: z.array(z.string().trim().min(1)).max(10).optional(),
    importantFacts: z.array(z.string().trim().min(1)).max(20).optional(),
    decisions: z.array(z.string().trim().min(1)).max(10).optional(),
    openQuestions: z.array(z.string().trim().min(1)).max(10).optional(),
});

export interface IMastraMemoryScope {
    thread: string;
    resource: string;
}

export interface IMastraMemoryReference {
    thread: string;
    resource: string;
}

const toNonEmptyString = (value: string | undefined | null): string | null => {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

const isTruthyEnv = (value: string | undefined | null): boolean => {
    const normalized = toNonEmptyString(value)?.toLowerCase();

    return normalized === '1'
        || normalized === 'true'
        || normalized === 'yes'
        || normalized === 'on';
};

const resolveSemanticRecallEmbedderModel = (
    env: NodeJS.ProcessEnv = process.env,
): string | null => {
    return toNonEmptyString(env.AGENT_SIDECAR_MEMORY_EMBEDDER_MODEL);
};

export const resolveMastraStorageDirectory = (
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
): string => {
    const configuredRoot = toNonEmptyString(env.AGENT_SIDECAR_STORAGE_ROOT);

    if (configuredRoot) {
        return resolve(configuredRoot);
    }

    const appDataRoot = toNonEmptyString(env.APPDATA) ?? toNonEmptyString(env.LOCALAPPDATA);

    if (appDataRoot) {
        return resolve(appDataRoot, DEFAULT_APP_IDENTIFIER, DEFAULT_STORAGE_DIRECTORY);
    }

    return resolve(cwd, '.agent-sidecar');
};

export const resolveMastraStorageUrl = (
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
): string => {
    const configuredUrl = toNonEmptyString(env.AGENT_SIDECAR_LIBSQL_URL);

    if (configuredUrl) {
        return configuredUrl;
    }

    const storageDirectory = resolveMastraStorageDirectory(env, cwd);
    mkdirSync(storageDirectory, { recursive: true });
    return pathToFileURL(join(storageDirectory, DEFAULT_STORAGE_FILENAME)).href;
};

export const resolveSemanticRecallEnabled = (
    env: NodeJS.ProcessEnv = process.env,
): boolean => {
    if (isTruthyEnv(env.AGENT_SIDECAR_MEMORY_ENABLE_SEMANTIC_RECALL)) {
        return resolveSemanticRecallEmbedderModel(env) !== null;
    }

    return resolveSemanticRecallEmbedderModel(env) !== null;
};

export const resolveProjectUuid = (workspaceRootPath: string): string => {
    const mastraCodeDir = join(workspaceRootPath, '.mastracode');
    const projectJsonPath = join(mastraCodeDir, 'project.json');

    if (existsSync(projectJsonPath)) {
        try {
            const content = readFileSync(projectJsonPath, 'utf8');
            const parsed = JSON.parse(content);
            const uuid = parsed.uuid as string | undefined;
            if (typeof uuid === 'string' && uuid.length > 0) {
                return uuid;
            }
        } catch {
            // Fall through to generate new UUID
        }
    }

    const newUuid = randomUUID();
    try {
        mkdirSync(mastraCodeDir, { recursive: true });
        writeFileSync(
            projectJsonPath,
            JSON.stringify({ uuid: newUuid, createdAt: new Date().toISOString() }, null, 2),
            'utf8',
        );
    } catch {
        // If write fails, still return the UUID (memory will be per-session)
    }
    return newUuid;
};

const resolveSemanticRecallEmbedder = (
    env: NodeJS.ProcessEnv = process.env,
): ModelRouterEmbeddingModel | null => {
    const embedderModel = resolveSemanticRecallEmbedderModel(env);

    if (!embedderModel || !resolveSemanticRecallEnabled(env)) {
        return null;
    }

    return new ModelRouterEmbeddingModel(embedderModel);
};

export const createMastraMemoryScope = (
    input: Pick<IAgentRuntimeInput, 'workspaceRootPath'>,
    sessionId: string,
): IMastraMemoryScope => {
    const workspaceRootPath = toNonEmptyString(input.workspaceRootPath ?? null);

    if (!workspaceRootPath) {
        return {
            thread: sessionId,
            resource: DEFAULT_MEMORY_RESOURCE_ID,
        };
    }

    const projectUuid = resolveProjectUuid(workspaceRootPath);

    return {
        thread: sessionId,
        resource: `workspace:${projectUuid}`,
    };
};

export const createMastraMemoryReference = (
    scope: IMastraMemoryScope,
): IMastraMemoryReference => ({
    thread: scope.thread,
    resource: scope.resource,
});

export const createMastraAgentMemory = (
    storageUrl: string,
    env: NodeJS.ProcessEnv = process.env,
): Memory => {
    const embedder = resolveSemanticRecallEmbedder(env);
    const semanticRecallEnabled = embedder !== null;

    return new Memory({
        storage: new LibSQLStore({
            id: 'agent-sidecar-memory-storage',
            url: storageUrl,
        }),
        ...(semanticRecallEnabled ? {
            vector: new LibSQLVector({
                id: 'agent-sidecar-memory-vector',
                url: storageUrl,
            }),
            embedder,
        } : {}),
        options: {
            lastMessages: DEFAULT_MEMORY_LAST_MESSAGES,
            workingMemory: {
                enabled: true,
                scope: 'resource',
                schema: mastraWorkingMemorySchema,
            },
            ...(semanticRecallEnabled ? {
                semanticRecall: {
                    topK: DEFAULT_SEMANTIC_RECALL_TOP_K,
                    messageRange: {
                        before: 1,
                        after: 1,
                    },
                    scope: 'resource' as const,
                },
            } : {}),
        },
    });
};

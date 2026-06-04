import { createRequire } from 'node:module';
import { MastraRuntime } from './rollback.js';
// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------
export const SUPPORTED_AGENT_RUNTIMES = ['mastra'];
export const DEFAULT_AGENT_RUNTIME = 'mastra';
/**
 * Sidecar 版本号。优先从 package.json 读取，保证与发布版本一致；
 * 读取失败时回退到占位值，不影响启动。
 */
const resolveSidecarVersion = () => {
    try {
        const requireFromHere = createRequire(import.meta.url);
        const pkg = requireFromHere('../../package.json');
        return typeof pkg.version === 'string' && pkg.version.trim().length > 0
            ? pkg.version
            : '0.0.0-unknown';
    }
    catch {
        return '0.0.0-unknown';
    }
};
export const SIDECAR_VERSION = resolveSidecarVersion();
const isSupportedRuntimeName = (value) => SUPPORTED_AGENT_RUNTIMES.includes(value);
export const resolveConfiguredRuntimeName = (env = process.env) => {
    const configured = env.AGENT_RUNTIME?.trim().toLowerCase();
    if (!configured) {
        return DEFAULT_AGENT_RUNTIME;
    }
    if (isSupportedRuntimeName(configured)) {
        return configured;
    }
    throw new Error(`Unsupported AGENT_RUNTIME: \"${configured}\". Expected one of: ${SUPPORTED_AGENT_RUNTIMES.join(', ')}.`);
};
export const createConfiguredRuntime = (options = {}) => {
    const runtime = options.runtime ?? resolveConfiguredRuntimeName(options.env ?? process.env);
    switch (runtime) {
        case 'mastra':
            return new MastraRuntime( /* options.runtimeOptions */);
        default: {
            // Exhaustive check: adding a new entry to SUPPORTED_AGENT_RUNTIMES
            // without a matching case here will fail the compile.
            const exhaustive = runtime;
            throw new Error(`Unhandled runtime: ${String(exhaustive)}`);
        }
    }
};

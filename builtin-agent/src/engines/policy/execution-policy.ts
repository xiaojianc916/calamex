export const AGENT_EXECUTION_MAX_STEPS_ENV = 'AGENT_EXECUTION_MAX_STEPS';
export const DEFAULT_AGENT_EXECUTION_MAX_STEPS = 10;
export const MIN_AGENT_EXECUTION_MAX_STEPS = 1;
export const MAX_AGENT_EXECUTION_MAX_STEPS = 50;

type TPolicyEnv = Record<string, string | undefined>;

const parseFiniteInteger = (value: string): number | null => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return null;
    }
    return Math.floor(parsed);
};

const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);

/**
 * Agent 工具循环上限属于运行时策略，而不是执行流程本身的业务逻辑。
 *
 * 参考 Zed 的做法：把影响 agent 行为的运行边界集中到显式策略层，并为环境变量
 * 覆盖设置保守上下限，避免一个配置错误把 agent 变成无限工具循环或完全不可用。
 */
export const resolveAgentExecutionMaxSteps = (
    env: TPolicyEnv = process.env,
): number => {
    const raw = env[AGENT_EXECUTION_MAX_STEPS_ENV]?.trim();
    if (!raw) {
        return DEFAULT_AGENT_EXECUTION_MAX_STEPS;
    }

    const parsed = parseFiniteInteger(raw);
    if (parsed === null) {
        return DEFAULT_AGENT_EXECUTION_MAX_STEPS;
    }

    return clamp(
        parsed,
        MIN_AGENT_EXECUTION_MAX_STEPS,
        MAX_AGENT_EXECUTION_MAX_STEPS,
    );
};

export interface IAgentExecutionPolicy {
    maxSteps: number;
}

export const resolveAgentExecutionPolicy = (
    env: TPolicyEnv = process.env,
): IAgentExecutionPolicy => ({
    maxSteps: resolveAgentExecutionMaxSteps(env),
});

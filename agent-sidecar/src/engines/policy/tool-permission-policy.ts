import {
    analyzeTerminalCommandSafety,
    normalizePosixPathLexically,
    splitShellCommands,
} from './command-safety.js';

export type TToolPermissionMode = 'allow' | 'confirm' | 'deny';
export type TToolPermissionDecisionKind = 'allow' | 'confirm' | 'deny';

export interface IToolPermissionDecision {
    kind: TToolPermissionDecisionKind;
    reason?: string;
}

export interface IToolPermissionPatternRule {
    pattern: string;
    caseSensitive?: boolean;
}

export interface IToolPermissionRules {
    defaultMode?: TToolPermissionMode;
    alwaysAllow?: IToolPermissionPatternRule[];
    alwaysConfirm?: IToolPermissionPatternRule[];
    alwaysDeny?: IToolPermissionPatternRule[];
}

export interface IToolPermissionPolicy {
    defaultMode: TToolPermissionMode;
    tools?: Record<string, IToolPermissionRules | undefined>;
}

export interface IDecideToolPermissionInput {
    toolName: string;
    inputs: string[];
    policy: IToolPermissionPolicy;
}

export const TERMINAL_TOOL_PERMISSION_NAME = 'terminal';

export const createMcpToolPermissionName = (serverName: string, toolName: string): string =>
    `mcp:${serverName}:${toolName}`;

const decision = (
    kind: TToolPermissionDecisionKind,
    reason?: string,
): IToolPermissionDecision => ({
    kind,
    ...(reason ? { reason } : {}),
});

const compileRule = (rule: IToolPermissionPatternRule): RegExp | null => {
    try {
        return new RegExp(rule.pattern, rule.caseSensitive ? 'u' : 'iu');
    } catch {
        return null;
    }
};

const hasInvalidRules = (rules: IToolPermissionRules | undefined): boolean => {
    if (!rules) {
        return false;
    }
    return [rules.alwaysAllow, rules.alwaysConfirm, rules.alwaysDeny]
        .flatMap((items) => items ?? [])
        .some((item) => compileRule(item) === null);
};

const matchesAny = (
    rules: readonly IToolPermissionPatternRule[] | undefined,
    input: string,
): boolean => (rules ?? []).some((rule) => compileRule(rule)?.test(input) ?? false);

const isUnconditionalAllowAll = (
    rules: IToolPermissionRules | undefined,
    globalDefault: TToolPermissionMode,
): boolean => {
    const effectiveDefault = rules?.defaultMode ?? globalDefault;
    return effectiveDefault === 'allow'
        && (rules?.alwaysDeny?.length ?? 0) === 0
        && (rules?.alwaysConfirm?.length ?? 0) === 0;
};

const expandInputsForTerminal = (
    inputs: readonly string[],
): { commands: string[]; parseFailed: boolean } => {
    const commands: string[] = [];
    let parseFailed = false;

    for (const input of inputs) {
        const parsed = splitShellCommands(input);
        if (!parsed) {
            parseFailed = true;
            commands.push(input);
            continue;
        }
        commands.push(...parsed);
    }

    return { commands, parseFailed };
};

const decideAgainstRules = (
    toolName: string,
    inputs: readonly string[],
    rules: IToolPermissionRules | undefined,
    globalDefault: TToolPermissionMode,
    allowEnabled: boolean,
): IToolPermissionDecision => {
    if (!rules) {
        return globalDefault === 'deny'
            ? decision('deny', 'blocked by global default: deny')
            : decision(globalDefault);
    }

    if (inputs.some((input) => matchesAny(rules.alwaysDeny, input))) {
        return decision('deny', `blocked by deny rule for ${toolName}`);
    }

    if (inputs.some((input) => matchesAny(rules.alwaysConfirm, input))) {
        return decision('confirm', `matched confirm rule for ${toolName}`);
    }

    if (
        allowEnabled
        && inputs.length > 0
        && inputs.every((input) => matchesAny(rules.alwaysAllow, input))
    ) {
        return decision('allow', `matched allow rule for ${toolName}`);
    }

    const effectiveDefault = rules.defaultMode ?? globalDefault;
    return effectiveDefault === 'deny'
        ? decision('deny', `${toolName} tool is disabled`)
        : decision(effectiveDefault);
};

export const decideToolPermission = ({
    toolName,
    inputs,
    policy,
}: IDecideToolPermissionInput): IToolPermissionDecision => {
    const rules = policy.tools?.[toolName];

    if (hasInvalidRules(rules)) {
        return decision('deny', `invalid permission pattern for ${toolName}`);
    }

    if (toolName === TERMINAL_TOOL_PERMISSION_NAME) {
        for (const input of inputs) {
            const safety = analyzeTerminalCommandSafety(input);
            if (safety.status === 'unsafe') {
                return decision('deny', safety.reason ?? 'blocked by built-in terminal safety rule');
            }
            if (
                safety.status === 'unsupported'
                && !isUnconditionalAllowAll(rules, policy.defaultMode)
            ) {
                return decision('deny', safety.reason ?? 'terminal command is not safe to approve automatically');
            }
        }

        const { commands, parseFailed } = expandInputsForTerminal(inputs);
        return decideAgainstRules(
            toolName,
            commands,
            rules,
            policy.defaultMode,
            !parseFailed,
        );
    }

    return decideAgainstRules(toolName, inputs, rules, policy.defaultMode, true);
};

const DECISION_RANK: Record<TToolPermissionDecisionKind, number> = {
    allow: 0,
    confirm: 1,
    deny: 2,
};

export const mostRestrictiveToolPermissionDecision = (
    first: IToolPermissionDecision,
    second: IToolPermissionDecision,
): IToolPermissionDecision => (
    DECISION_RANK[first.kind] >= DECISION_RANK[second.kind] ? first : second
);

export const decidePathToolPermission = (
    input: IDecideToolPermissionInput,
): IToolPermissionDecision => {
    const rawDecision = decideToolPermission(input);
    const normalizedInputs = input.inputs.map(normalizePosixPathLexically);
    const changed = input.inputs.some((value, index) => value !== normalizedInputs[index]);
    if (!changed) {
        return rawDecision;
    }
    const normalizedDecision = decideToolPermission({
        ...input,
        inputs: normalizedInputs,
    });
    return mostRestrictiveToolPermissionDecision(rawDecision, normalizedDecision);
};

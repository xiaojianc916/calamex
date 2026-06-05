import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import type { MastraBrowser } from '@mastra/core/browser';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { AnyWorkspace } from '@mastra/core/workspace';
import type { createMastraAgentMemory } from '../context/memory.js';

/**
 * 专职子 agent 的稳定 slug。作为 supervisor `agents` 记录的键，
 * 模型在委派时据此引用对应子 agent，必须稳定且语义清晰。
 */
export type TSubAgentSlug = 'planner' | 'coder' | 'reviewer' | 'researcher';

/**
 * 单个子 agent 的纯数据定义（不含模型 / 工具 / 记忆），
 * 便于单测、复用与人工审阅；真正的 `new Agent` 在 buildCodingSubAgents 中组装。
 */
export interface ISubAgentDefinition {
    /** supervisor `agents` 记录键。 */
    slug: TSubAgentSlug;
    /** Mastra Agent id（全局唯一，带 calamex-subagent 前缀）。 */
    id: string;
    /** 人类可读名称。 */
    name: string;
    /**
     * 供 supervisor 路由委派的能力描述。必须清晰、可区分，
     * 因为子 agent 是以「工具」形式暴露给主 agent 的，描述即选型依据。
     */
    description: string;
    /** 子 agent 的系统指令。 */
    instructions: string;
    /**
     * 是否需要仓库读写能力。true 时把共享的 MCP 工具 / workspace / browser
     * 透传给该子 agent（改码 / 审查 / 检索需要落到真实文件与命令）；
     * 规划 agent 为纯推理，不挂工具以降低误操作面。
     */
    needsTools: boolean;
}

/** 子 agent id 统一前缀，便于在日志 / observability 中识别归属。 */
export const SUBAGENT_ID_PREFIX = 'calamex-subagent';

/**
 * 四个专职子 agent 的纯数据定义。顺序即推荐协作顺序：
 * 规划 → 改码 → 审查；检索贯穿其间按需调用。
 *
 * 指令遵循 calamex 的编码原则：最小改动、复用既有实现、先想后做、
 * 列出假设与歧义、改前确认、改动可回退、合并前验证。
 */
export const buildCodingSubAgentDefinitions = (): readonly ISubAgentDefinition[] => [
    {
        slug: 'planner',
        id: `${SUBAGENT_ID_PREFIX}-planner`,
        name: '规划 Agent',
        description:
            '把模糊需求拆解为最小、可验证、可回退的改动步骤。任务开始、范围变化或方案有歧义时调用；它只产出计划，不直接改代码。',
        instructions: [
            '你是 calamex 编码任务的「规划」子 agent。',
            '职责：把用户需求拆解为最小、低风险、可逐步验证的改动计划。',
            '原则：',
            '- 先想后做：先列出关键假设与未确认的歧义，必要时建议主 agent 向用户澄清。',
            '- 最小改动：优先复用既有实现，避免过度设计；能小改不大改。',
            '- 可回退：每一步都应是独立、可单独 revert 的改动。',
            '- 可验证：为每一步给出明确的验证方式（测试 / typecheck / 手动验证）。',
            '输出：有序的步骤清单 + 每步涉及的文件与验证方式；不要直接编辑文件。',
        ].join('\n'),
        needsTools: false,
    },
    {
        slug: 'coder',
        id: `${SUBAGENT_ID_PREFIX}-coder`,
        name: '改码 Agent',
        description:
            '按既定计划在仓库中实现具体改动（编辑文件、写实现）。需要落到真实代码改动时调用。',
        instructions: [
            '你是 calamex 编码任务的「改码」子 agent。',
            '职责：按规划好的步骤实现具体代码改动。',
            '原则：',
            '- 严格遵循既定计划与最小改动；不擅自扩大范围。',
            '- 复用既有工具函数 / 模式，保持与周边代码风格一致。',
            '- 改动尽量自包含、可回退；不破坏现有功能与既有测试。',
            '- 涉及不可逆或高风险操作时，交回主 agent 走审批，不自行强推。',
            '输出：实际的文件改动，以及对改了什么、为什么的简短说明。',
        ].join('\n'),
        needsTools: true,
    },
    {
        slug: 'reviewer',
        id: `${SUBAGENT_ID_PREFIX}-reviewer`,
        name: '审查 Agent',
        description:
            '审查改动的正确性与质量，找 bug、回归与风险点。改码完成后、合并前调用。',
        instructions: [
            '你是 calamex 编码任务的「审查」子 agent。',
            '职责：审查既有改动，找出 bug、回归风险、边界问题与质量问题。',
            '原则：',
            '- 聚焦改动是否破坏其他功能、是否偏离计划、是否引入不可逆风险。',
            '- 检查是否有对应的验证（测试 / typecheck），不足则指出。',
            '- 给出可执行的修复建议，区分「必须修」与「可选优化」。',
            '输出：问题清单（按严重度）+ 修复建议；不直接改代码，交回主 agent 决策。',
        ].join('\n'),
        needsTools: true,
    },
    {
        slug: 'researcher',
        id: `${SUBAGENT_ID_PREFIX}-researcher`,
        name: '检索 Agent',
        description:
            '检索代码库与文档、查清依赖 / API / 既有实现。需要事实依据或定位既有代码时调用。',
        instructions: [
            '你是 calamex 编码任务的「检索」子 agent。',
            '职责：在代码库与文档中查清事实，为规划 / 改码 / 审查提供依据。',
            '原则：',
            '- 优先定位既有实现与可复用代码，避免重复造轮子。',
            '- 查清依赖版本、API 用法、约定与边界，给出来源（文件路径 / 文档）。',
            '- 只做检索与归纳，不修改代码。',
            '输出：带出处的事实与定位结果，以及对调用方问题的直接回答。',
        ].join('\n'),
        needsTools: true,
    },
];

/** buildCodingSubAgents 的入参：主 agent 的模型与（可选）共享资源。 */
export interface IBuildCodingSubAgentsOptions {
    /** 子 agent 使用的模型（通常与主 agent 同一个解析后的模型）。 */
    model: MastraModelConfig;
    /** 共享记忆；传入则子 agent 复用同一记忆配置。 */
    memory?: ReturnType<typeof createMastraAgentMemory>;
    /** 共享 MCP 工具；仅注入到 needsTools 的子 agent。 */
    tools?: ToolsInput;
    /** 共享 workspace；仅注入到 needsTools 的子 agent。 */
    workspace?: AnyWorkspace;
    /** 共享 browser；仅注入到 needsTools 的子 agent。 */
    browser?: MastraBrowser;
}

/**
 * 组装四个官方 Supervisor 子 agent，返回可直接作为父 Agent `agents` 字段的记录。
 * 每个子 agent 以「工具」形式被主 agent 委派；needsTools 决定是否给其挂仓库工具。
 */
export const buildCodingSubAgents = (
    options: IBuildCodingSubAgentsOptions,
): Record<string, Agent> => {
    const entries = buildCodingSubAgentDefinitions().map((definition) => {
        const wantsTools = definition.needsTools;
        const agent = new Agent({
            id: definition.id,
            name: definition.name,
            description: definition.description,
            instructions: definition.instructions,
            model: options.model,
            ...(options.memory ? { memory: options.memory } : {}),
            ...(wantsTools && options.tools ? { tools: options.tools } : {}),
            ...(wantsTools && options.workspace ? { workspace: options.workspace } : {}),
            ...(wantsTools && options.browser ? { browser: options.browser } : {}),
        });
        return [definition.slug, agent] as const;
    });

    return Object.fromEntries(entries);
};

/**
 * 读取 `AGENT_SUBAGENTS` 开关。默认关闭；'1' / 'true' / 'on' 开启官方 Supervisor 子 agent。
 * 与既有 `AGENT_ORCHESTRATION_WORKFLOW` 一致采用「默认关、可随时回退」的灰度策略。
 */
export const isSubAgentsEnabled = (
    env: NodeJS.ProcessEnv = process.env,
): boolean => {
    const raw = env.AGENT_SUBAGENTS?.trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'on';
};

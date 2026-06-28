import { truncateModelOutputText } from '../../../models/output-budget.js';
import type {
    IAgentContextReferenceInput,
    IAgentRuntimeInput,
} from '../../contracts/runtime-input.js';
import { selectCodeFence, toSafeInlineLabel } from '../render/escape.js';

const CONTEXT_REFERENCE_PREVIEW_MAX_CHARS = 1_200;
export const UNSPECIFIED_MODEL_LABEL = '未指定';
const UNKNOWN_PROVIDER_LABEL = '当前配置的 AI 服务平台';
const CURRENT_FILE_REFERENCE_KIND = 'current-file';
const SKILL_REFERENCE_KIND = 'skill';

// -----------------------------------------------------------------------------
// Provider inference (data-driven, first match wins)
// -----------------------------------------------------------------------------

const PROVIDER_RULES: ReadonlyArray<{
    readonly label: string;
    readonly test: (normalizedModelId: string) => boolean;
}> = [
    { label: 'DeepSeek', test: (id) => id.includes('deepseek') },
    { label: 'Anthropic', test: (id) => id.includes('claude') || id.startsWith('anthropic/') },
    {
        label: 'OpenAI',
        test: (id) => id.startsWith('openai/') || id.includes('gpt') || /^o\d/u.test(id),
    },
    { label: 'Google', test: (id) => id.includes('gemini') || id.startsWith('google/') },
    { label: '通义千问', test: (id) => id.includes('qwen') },
];

const inferModelProviderLabel = (modelId: string): string => {
    const normalized = modelId.trim().toLowerCase();
    if (!normalized) {
        return UNKNOWN_PROVIDER_LABEL;
    }
    for (const rule of PROVIDER_RULES) {
        if (rule.test(normalized)) {
            return rule.label;
        }
    }
    return UNKNOWN_PROVIDER_LABEL;
};

// -----------------------------------------------------------------------------
// Strongly-typed render context (≈ Zed SystemPromptTemplate + ProjectContext)
// -----------------------------------------------------------------------------

/**
 * 单条 UI 上下文引用在提示词中的展示视图。所有字段恒存在（无可选字段），
 * 以满足 Handlebars 严格模式：模板任一分支引用的字段都必须就位。
 */
export interface ISystemPromptContextReferenceView {
    readonly index: number;
    readonly isSkill: boolean;
    readonly label: string;
    readonly skillSlug: string;
    readonly kind: string;
    readonly pathLabel: string;
    readonly rangeLabel: string;
    readonly redactedLabel: string;
    readonly truncated: boolean;
    readonly fence: string;
    readonly previewText: string;
}

/**
 * 系统提示词的完整渲染上下文。布尔标志（hasContext / hasGoal 等）为预计算字段——
 * 对齐 Zed 在 ProjectContext 里预计算 has_rules / has_skills 的做法，因为
 * logic-less 模板无法自行判断集合是否为空。
 */
export interface ISystemPromptContext {
    readonly modelLabel: string;
    readonly providerLabel: string;
    readonly isPlanMode: boolean;
    readonly hasWorkspace: boolean;
    readonly workspaceRootPath: string;
    readonly hasContext: boolean;
    readonly contextReferences: readonly ISystemPromptContextReferenceView[];
    readonly hasGoal: boolean;
    readonly goal: string;
    readonly hasExtraSystemMessages: boolean;
    readonly extraSystemMessages: readonly string[];
}

// -----------------------------------------------------------------------------
// Assembly: IAgentRuntimeInput -> ISystemPromptContext
// -----------------------------------------------------------------------------

const toReferenceView = (
    reference: IAgentContextReferenceInput,
    index: number,
): ISystemPromptContextReferenceView => {
    const label = toSafeInlineLabel(reference.label);
    const redactedLabel = reference.redacted ? '是' : '否';

    // 技能调用渲染为"指令"，而非把 SKILL.md 正文塞进 prompt。
    // 工作区已自动加载全局技能，agent 可用 skill_read 按 slug 读取正文。
    if (reference.kind === SKILL_REFERENCE_KIND) {
        return {
            index: index + 1,
            isSkill: true,
            label,
            skillSlug: reference.path ? toSafeInlineLabel(reference.path) : '',
            kind: reference.kind,
            pathLabel: reference.path ?? '无',
            rangeLabel: '整段',
            redactedLabel,
            truncated: false,
            fence: '```',
            previewText: '',
        };
    }

    const truncation = truncateModelOutputText(
        reference.contentPreview,
        CONTEXT_REFERENCE_PREVIEW_MAX_CHARS,
    );

    return {
        index: index + 1,
        isSkill: false,
        label,
        skillSlug: '',
        kind: reference.kind,
        pathLabel: reference.path ?? '无',
        rangeLabel: reference.range
            ? `第 ${reference.range.startLine}–${reference.range.endLine} 行`
            : '整段',
        redactedLabel,
        truncated: truncation.truncated,
        fence: selectCodeFence(truncation.text),
        previewText: truncation.text,
    };
};

export const assembleSystemPromptContext = (
    input: IAgentRuntimeInput,
    modelId: string = UNSPECIFIED_MODEL_LABEL,
): ISystemPromptContext => {
    const modelLabel = modelId.trim() || UNSPECIFIED_MODEL_LABEL;

    const extraSystemMessages = input.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content.trim())
        .filter((content) => content.length > 0);

    const contextReferences = (input.context ?? [])
        .filter((reference) => reference.kind !== CURRENT_FILE_REFERENCE_KIND)
        .map(toReferenceView);

    const workspaceRootPath = input.workspaceRootPath?.trim() ?? '';
    const goal = input.goal.trim();

    return {
        modelLabel,
        providerLabel: inferModelProviderLabel(modelLabel),
        isPlanMode: input.mode === 'plan',
        hasWorkspace: workspaceRootPath.length > 0,
        workspaceRootPath,
        hasContext: contextReferences.length > 0,
        contextReferences,
        hasGoal: goal.length > 0,
        goal,
        hasExtraSystemMessages: extraSystemMessages.length > 0,
        extraSystemMessages,
    };
};

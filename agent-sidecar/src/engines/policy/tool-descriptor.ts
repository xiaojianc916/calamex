export type TAgentToolSource = 'workspace' | 'mcp' | 'browser' | 'internal';
export type TAgentToolKind =
    | 'read'
    | 'search'
    | 'edit'
    | 'write'
    | 'delete'
    | 'move'
    | 'execute'
    | 'network'
    | 'think'
    | 'other';

export type TAgentToolCapabilityRequirement =
    | 'tools'
    | 'streamingTools'
    | 'images'
    | 'network';

export interface IAgentModelToolCapabilities {
    supportsTools: boolean;
    supportsStreamingTools?: boolean;
    supportsImages?: boolean;
    supportsNetworkTools?: boolean;
}

export interface IAgentToolDescriptor {
    /** Stable tool name as exposed to the runtime/model policy layer. */
    name: string;
    source: TAgentToolSource;
    kind: TAgentToolKind;
    /** Whether this tool can mutate local or remote state. */
    mutatesState: boolean;
    /** Whether tool execution should require confirmation unless policy overrides it. */
    requiresApprovalByDefault: boolean;
    /** Whether tool input can be safely applied incrementally while the model streams it. */
    supportsStreamingInput: boolean;
    /** Optional capability the selected model/provider must support before this tool is exposed. */
    requiredCapability?: TAgentToolCapabilityRequirement;
}

export const createMcpToolDescriptorName = (serverName: string, toolName: string): string =>
    `mcp:${serverName}:${toolName}`;

export const createMcpToolDescriptor = (
    serverName: string,
    toolName: string,
    mutatesState: boolean,
): IAgentToolDescriptor => ({
    name: createMcpToolDescriptorName(serverName, toolName),
    source: 'mcp',
    kind: mutatesState ? 'other' : 'read',
    mutatesState,
    requiresApprovalByDefault: mutatesState,
    supportsStreamingInput: false,
    requiredCapability: 'tools',
});

/**
 * Calamex-side canonical descriptors, modelled after Zed's central built-in
 * tool registry: one stable name, one kind, one default permission posture.
 *
 * This intentionally does not copy Zed's tool list. It maps Calamex's current
 * Mastra workspace / sidecar concepts into a single policy surface so approval,
 * model capability filtering, UI rendering, and tool budget logic stop growing
 * separate ad-hoc classifications.
 */
export const CALAMEX_CORE_TOOL_DESCRIPTORS: readonly IAgentToolDescriptor[] = [
    {
        name: 'workspace.read_file',
        source: 'workspace',
        kind: 'read',
        mutatesState: false,
        requiresApprovalByDefault: false,
        supportsStreamingInput: false,
        requiredCapability: 'tools',
    },
    {
        name: 'workspace.list_files',
        source: 'workspace',
        kind: 'read',
        mutatesState: false,
        requiresApprovalByDefault: false,
        supportsStreamingInput: false,
        requiredCapability: 'tools',
    },
    {
        name: 'workspace.grep',
        source: 'workspace',
        kind: 'search',
        mutatesState: false,
        requiresApprovalByDefault: false,
        supportsStreamingInput: false,
        requiredCapability: 'tools',
    },
    {
        name: 'workspace.write_file',
        source: 'workspace',
        kind: 'write',
        mutatesState: true,
        requiresApprovalByDefault: true,
        supportsStreamingInput: true,
        requiredCapability: 'tools',
    },
    {
        name: 'workspace.edit_file',
        source: 'workspace',
        kind: 'edit',
        mutatesState: true,
        requiresApprovalByDefault: true,
        supportsStreamingInput: true,
        requiredCapability: 'tools',
    },
    {
        name: 'workspace.delete',
        source: 'workspace',
        kind: 'delete',
        mutatesState: true,
        requiresApprovalByDefault: true,
        supportsStreamingInput: false,
        requiredCapability: 'tools',
    },
    {
        name: 'workspace.mkdir',
        source: 'workspace',
        kind: 'write',
        mutatesState: true,
        requiresApprovalByDefault: true,
        supportsStreamingInput: false,
        requiredCapability: 'tools',
    },
    {
        name: 'workspace.execute_command',
        source: 'workspace',
        kind: 'execute',
        mutatesState: true,
        requiresApprovalByDefault: true,
        supportsStreamingInput: false,
        requiredCapability: 'tools',
    },
    {
        name: 'browser.navigate',
        source: 'browser',
        kind: 'network',
        mutatesState: false,
        requiresApprovalByDefault: true,
        supportsStreamingInput: false,
        requiredCapability: 'network',
    },
    {
        name: 'internal.update_plan',
        source: 'internal',
        kind: 'think',
        mutatesState: false,
        requiresApprovalByDefault: false,
        supportsStreamingInput: false,
        requiredCapability: 'tools',
    },
] as const;

export const assertUniqueToolDescriptors = (
    descriptors: readonly IAgentToolDescriptor[],
): void => {
    const seen = new Set<string>();
    for (const descriptor of descriptors) {
        if (seen.has(descriptor.name)) {
            throw new Error(`Duplicate agent tool descriptor: ${descriptor.name}`);
        }
        seen.add(descriptor.name);
    }
};

const hasRequiredCapability = (
    descriptor: IAgentToolDescriptor,
    capabilities: IAgentModelToolCapabilities,
): boolean => {
    switch (descriptor.requiredCapability) {
        case undefined:
            return true;
        case 'tools':
            return capabilities.supportsTools;
        case 'streamingTools':
            return capabilities.supportsTools && capabilities.supportsStreamingTools === true;
        case 'images':
            return capabilities.supportsImages === true;
        case 'network':
            return capabilities.supportsNetworkTools === true;
    }
};

export const filterToolDescriptorsForModel = (
    descriptors: readonly IAgentToolDescriptor[],
    capabilities: IAgentModelToolCapabilities,
): IAgentToolDescriptor[] => descriptors.filter((descriptor) =>
    hasRequiredCapability(descriptor, capabilities),
);

export const resolveDescriptorApprovalDefault = (
    descriptor: IAgentToolDescriptor,
): 'allow' | 'confirm' => (
    descriptor.requiresApprovalByDefault || descriptor.mutatesState ? 'confirm' : 'allow'
);

export const groupToolDescriptorsBySource = (
    descriptors: readonly IAgentToolDescriptor[],
): Record<TAgentToolSource, IAgentToolDescriptor[]> => {
    const grouped: Record<TAgentToolSource, IAgentToolDescriptor[]> = {
        workspace: [],
        mcp: [],
        browser: [],
        internal: [],
    };
    for (const descriptor of descriptors) {
        grouped[descriptor.source].push(descriptor);
    }
    return grouped;
};

assertUniqueToolDescriptors(CALAMEX_CORE_TOOL_DESCRIPTORS);

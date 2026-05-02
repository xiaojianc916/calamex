<script setup lang="ts">
import AiProviderIcon from '@/components/business/ai/AiProviderIcon.vue';
import { useAiAutoApply } from '@/composables/useAiAutoApply';
import type { TAiServicePlatformId } from '@/constants/ai-providers';
import {
    AI_SERVICE_PLATFORM_PRESETS,
    DEFAULT_LITELLM_BASE_URL,
    findAiProviderPreset,
    findAiServicePlatformByModel,
    findAiServicePlatformPreset,
    isAiServicePlatformModel,
} from '@/constants/ai-providers';
import type {
    IAiConfigPayload,
    IAiProviderProfileDetailPayload,
    IAiProviderProfilePayload,
    IAiProviderSettingsActionFeedback,
} from '@/types/ai';
import type { TAiEditAuthLevel } from '@/types/ai-edit';
import { tryWriteClipboardText } from '@/utils/clipboard';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

interface IAiAdvancedDraft {
    timeoutSeconds: number;
    proxyUrl: string;
    temperature: number;
    topP: number;
    maxTokens: number;
}

interface IPlatformSelectOption {
    value: TAiServicePlatformId;
    label: string;
}

interface IModelSelectOption {
    value: string;
    label: string;
}

const createDefaultAdvancedDraft = (): IAiAdvancedDraft => ({
    timeoutSeconds: 30,
    proxyUrl: '',
    temperature: 0.7,
    topP: 1,
    maxTokens: 1024,
});

const props = defineProps<{
    open: boolean;
    config: IAiConfigPayload;
    profiles: IAiProviderProfilePayload[];
    loadProfileDetail: (profileId: string) => Promise<IAiProviderProfileDetailPayload>;
}>();

const emit = defineEmits<{
    close: [];
    save: [config: IAiConfigPayload, apiKey: string, feedback: IAiProviderSettingsActionFeedback];
    saveCredentials: [apiKey: string, feedback: IAiProviderSettingsActionFeedback];
    testProvider: [config: IAiConfigPayload, apiKey: string, feedback: IAiProviderSettingsActionFeedback];
    switchProfile: [profileId: string, feedback: IAiProviderSettingsActionFeedback];
}>();

const nextConfig = defineModel<IAiConfigPayload>('draft', { required: true });
const apiKey = defineModel<string>('apiKey', { required: true });
const autoApply = useAiAutoApply();

const statusMessage = ref('');
const statusTone = ref<'success' | 'error' | 'info'>('info');
const isTesting = ref(false);
const isSaving = ref(false);
const isPlatformOpen = ref(false);
const isModelOpen = ref(false);
const settingsView = ref<'form' | 'profiles' | 'detail'>('form');
const streamEnabled = ref(true);
const advancedDraft = ref<IAiAdvancedDraft>(createDefaultAdvancedDraft());
const profileDetail = ref<IAiProviderProfileDetailPayload | null>(null);
const isProfileDetailLoading = ref(false);
const isApiKeyVisible = ref(false);
const activeServicePlatformId = ref<TAiServicePlatformId>(
    findAiServicePlatformByModel(nextConfig.value.selectedModel).id,
);

let statusTimer: number | null = null;

const platformOptions = computed<IPlatformSelectOption[]>(() =>
    AI_SERVICE_PLATFORM_PRESETS.map((preset) => ({
        value: preset.id,
        label: preset.label,
    })),
);

const activePreset = computed(() => findAiProviderPreset(nextConfig.value.providerType));
const activeServicePlatform = computed(() =>
    findAiServicePlatformPreset(activeServicePlatformId.value),
);

const modelOptions = computed<IModelSelectOption[]>(() =>
    activeServicePlatform.value.models.map((model) => ({
        value: model.id,
        label: model.label,
    })),
);

const selectedPlatformLabel = computed(() => {
    const matched = platformOptions.value.find((item) => item.value === activeServicePlatformId.value);
    return matched?.label ?? '请选择';
});

const selectedModelLabel = computed(() => {
    const currentModel = nextConfig.value.selectedModel?.trim();
    const matched = modelOptions.value.find((item) => item.value === currentModel);
    if (matched) {
        return matched.label;
    }
    return modelOptions.value[0]?.label ?? '选择模型';
});

const hasSavedCredentialsForProvider = computed(
    () => props.config.providerType === nextConfig.value.providerType && props.config.hasCredentials,
);

const requiresApiKey = computed(
    () => !hasSavedCredentialsForProvider.value,
);

const canTestProvider = computed(() => !isTesting.value);
const canSaveProvider = computed(() => !isSaving.value);
const autoApplyOptions = computed<
    Array<{ value: TAiEditAuthLevel; label: string; description: string }>
>(() => [
    {
        value: 'manual',
        label: '手动审批',
        description: '保留 patch 预览，逐次确认后再写盘。',
    },
    {
        value: 'per_task',
        label: '任务内自动应用',
        description: '当前对话线程内自动写盘，关闭任务后回到手动模式。',
    },
    {
        value: 'session',
        label: '会话内自动应用',
        description: '当前应用会话持续自动写盘，重启后恢复手动模式。',
    },
]);
const autoApplyModeLabel = computed(() => {
    switch (autoApply.authLevel.value) {
        case 'per_task':
            return 'Per-task';
        case 'session':
            return 'Session';
        default:
            return 'Manual';
    }
});
const autoApplyStatusLabel = computed(() => {
    switch (autoApply.authLevel.value) {
        case 'per_task':
            return autoApply.activeTaskId.value
                ? '当前对话线程已授权自动写盘。'
                : '当前暂无活跃任务，切回对话后会自动绑定 taskId。';
        case 'session':
            return '当前应用会话内允许 Agent 自动应用 patch。';
        default:
            return '当前仍为手动审批模式，Agent 写盘前必须显式确认。';
    }
});
const sortedProfiles = computed(() =>
    [...props.profiles].sort((left, right) => {
        const leftTime = Date.parse(left.lastUsedAt ?? left.updatedAt);
        const rightTime = Date.parse(right.lastUsedAt ?? right.updatedAt);
        return rightTime - leftTime;
    }),
);
const activeProfileId = computed(() => props.config.activeProfileId);
const hasProfiles = computed(() => sortedProfiles.value.length > 0);
const settingsTitle = computed(() => {
    switch (settingsView.value) {
        case 'profiles':
            return 'AI 配置记录';
        case 'detail':
            return '配置详情';
        default:
            return 'API 连接配置';
    }
});
const settingsSubtitle = computed(() => {
    switch (settingsView.value) {
        case 'profiles':
            return '快速切换已验证连接';
        case 'detail':
            return '只读查看，API Key 仅本地显示';
        default:
            return '连接成功后会自动保存为配置记录';
    }
});
const autoApplyUpdatedAtLabel = computed(() => {
    const parsed = Date.parse(autoApply.authState.value.updatedAt);
    if (!Number.isFinite(parsed)) {
        return '尚未记录授权变更';
    }

    return new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(new Date(parsed));
});
const autoApplyToneClass = computed(() => {
    switch (autoApply.authLevel.value) {
        case 'per_task':
            return 'is-task';
        case 'session':
            return 'is-session';
        default:
            return 'is-manual';
    }
});

const ensureLiteLlmConnectionDefaults = (): void => {
    nextConfig.value.providerType = 'litellm';
    if (!nextConfig.value.baseUrl?.trim()) {
        nextConfig.value.baseUrl = DEFAULT_LITELLM_BASE_URL;
    }
};

const syncDraftWithServicePlatform = (platformId: TAiServicePlatformId): void => {
    const platform = findAiServicePlatformPreset(platformId);
    activeServicePlatformId.value = platform.id;
    ensureLiteLlmConnectionDefaults();
    if (!isAiServicePlatformModel(platform.id, nextConfig.value.selectedModel)) {
        nextConfig.value.selectedModel = platform.defaultModel;
    }
};

const hideStatus = (): void => {
    if (statusTimer !== null) {
        window.clearTimeout(statusTimer);
        statusTimer = null;
    }
    statusMessage.value = '';
};

const showStatus = (
    message: string,
    tone: 'success' | 'error' | 'info' = 'info',
    autoHide = true,
): void => {
    if (statusTimer !== null) {
        window.clearTimeout(statusTimer);
        statusTimer = null;
    }
    statusMessage.value = message;
    statusTone.value = tone;
    if (!autoHide) {
        return;
    }
    statusTimer = window.setTimeout(() => {
        statusMessage.value = '';
        statusTimer = null;
    }, tone === 'success' ? 1800 : 2400);
};

const closeDropdowns = (): void => {
    isPlatformOpen.value = false;
    isModelOpen.value = false;
};

const showProfileSwitcher = (): void => {
    closeDropdowns();
    settingsView.value = 'profiles';
    profileDetail.value = null;
    isApiKeyVisible.value = false;
};

const showConnectionForm = (): void => {
    closeDropdowns();
    settingsView.value = 'form';
    profileDetail.value = null;
    isApiKeyVisible.value = false;
};

const handleHeaderNavigation = (): void => {
    if (settingsView.value === 'form') {
        showProfileSwitcher();
        return;
    }

    if (settingsView.value === 'detail') {
        showProfileSwitcher();
        return;
    }

    showConnectionForm();
};

const showProfileDetail = async (profile: IAiProviderProfilePayload): Promise<void> => {
    closeDropdowns();
    settingsView.value = 'detail';
    profileDetail.value = null;
    isApiKeyVisible.value = false;
    isProfileDetailLoading.value = true;

    try {
        profileDetail.value = await props.loadProfileDetail(profile.id);
    } catch (error) {
        showStatus(
            error instanceof Error && error.message.trim()
                ? error.message
                : '配置详情读取失败',
            'error',
        );
        settingsView.value = 'profiles';
    } finally {
        isProfileDetailLoading.value = false;
    }
};

const resetEphemeralState = (): void => {
    hideStatus();
    closeDropdowns();
    isTesting.value = false;
    isSaving.value = false;
    streamEnabled.value = true;
    advancedDraft.value = createDefaultAdvancedDraft();
};

const onDocumentClick = (): void => {
    closeDropdowns();
};

const onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
        closeDropdowns();
    }
};

const copyKey = async (): Promise<void> => {
    const value = apiKey.value.trim();
    if (!value) {
        showStatus('暂无可复制内容', 'error');
        return;
    }
    const copied = await tryWriteClipboardText(value);
    showStatus(
        copied ? '已复制到剪贴板' : '当前环境不支持剪贴板写入',
        copied ? 'success' : 'error',
    );
};

const toggleStream = (): void => {
    streamEnabled.value = !streamEnabled.value;
};

const updatePlatform = (platformId: TAiServicePlatformId): void => {
    if (activeServicePlatformId.value === platformId) {
        closeDropdowns();
        return;
    }
    syncDraftWithServicePlatform(platformId);
    closeDropdowns();
};

const updateModel = (model: string): void => {
    nextConfig.value.selectedModel = model;
    closeDropdowns();
};

const updateAutoApplyLevel = async (level: TAiEditAuthLevel): Promise<void> => {
    if (autoApply.authLevel.value === level) {
        return;
    }

    try {
        showStatus('正在更新 AED 授权…', 'info', false);
        await autoApply.setAuthLevel({ level });
        showStatus(`AED 授权已切换到 ${autoApplyModeLabel.value}`, 'success');
    } catch (error) {
        showStatus(
            error instanceof Error && error.message.trim()
                ? error.message
                : 'AED 授权更新失败',
            'error',
        );
    }
};

const createSwitchFeedback = (profile: IAiProviderProfilePayload): IAiProviderSettingsActionFeedback => ({
    onSuccess(message) {
        isSaving.value = false;
        showStatus(message ?? `已切换到 ${profile.name}`, 'success');
    },
    onError(message) {
        isSaving.value = false;
        showStatus(message, 'error');
    },
});

const switchProfile = (profile: IAiProviderProfilePayload): void => {
    if (profile.id === activeProfileId.value || isSaving.value) {
        return;
    }

    if (!profile.hasCredentials) {
        showStatus('该配置缺少 API Key，请重新连接保存', 'error');
        return;
    }

    isSaving.value = true;
    showStatus(`正在切换到 ${profile.name}…`, 'info', false);
    emit('switchProfile', profile.id, createSwitchFeedback(profile));
};

const createActionFeedback = (
    action: 'test' | 'save',
    successMessage: string,
): IAiProviderSettingsActionFeedback => ({
    onSuccess(message) {
        if (action === 'test') {
            isTesting.value = false;
        } else {
            isSaving.value = false;
        }
        showStatus(message ?? successMessage, 'success');
        if (action === 'save') {
            window.setTimeout(() => {
                emit('close');
            }, 1200);
        }
    },
    onError(message) {
        if (action === 'test') {
            isTesting.value = false;
        } else {
            isSaving.value = false;
        }
        showStatus(message, 'error');
    },
});

const validateForm = (): boolean => {
    if (requiresApiKey.value && !apiKey.value.trim()) {
        showStatus('请输入 API Key', 'error');
        return false;
    }
    if (!nextConfig.value.baseUrl?.trim()) {
        showStatus('请填写 Base URL', 'error');
        return false;
    }
    if (!nextConfig.value.selectedModel?.trim()) {
        showStatus('请选择模型', 'error');
        return false;
    }
    return true;
};

const testConnection = (): void => {
    hideStatus();
    if (!validateForm()) {
        return;
    }
    isTesting.value = true;
    showStatus('正在测试连接…', 'info', false);
    emit(
        'testProvider',
        nextConfig.value,
        apiKey.value.trim(),
        createActionFeedback('test', `连接成功 · 模型：${selectedModelLabel.value}`),
    );
};

const saveConfig = (): void => {
    hideStatus();
    if (!validateForm()) {
        return;
    }
    isSaving.value = true;
    showStatus('正在连接…', 'info', false);
    emit('save', nextConfig.value, apiKey.value.trim(), createActionFeedback('save', '连接成功'));
};

const getProfilePlatformLabel = (profile: IAiProviderProfilePayload): string =>
    findAiServicePlatformByModel(profile.selectedModel).label;

const getProfilePlatformId = (profile: IAiProviderProfilePayload): TAiServicePlatformId =>
    findAiServicePlatformByModel(profile.selectedModel).id;

const getProfileModelLabel = (profile: IAiProviderProfilePayload): string => {
    const model = profile.selectedModel?.trim();

    if (!model) {
        return '未选择模型';
    }

    const platform = findAiServicePlatformByModel(model);
    return platform.models.find((item) => item.id === model)?.label ?? model;
};

const getProfileEndpointLabel = (profile: IAiProviderProfilePayload): string =>
    profile.baseUrl?.trim() || DEFAULT_LITELLM_BASE_URL;

const getProfileTimeLabel = (profile: IAiProviderProfilePayload): string => {
    const timestamp = Date.parse(profile.lastUsedAt ?? profile.updatedAt);

    if (!Number.isFinite(timestamp)) {
        return '时间未知';
    }

    return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date(timestamp));
};

const getProfileFeatureLabel = (profile: IAiProviderProfilePayload): string => {
    const features = [
        profile.chatEnabled ? 'Chat' : null,
        profile.agentEnabled ? 'Agent' : null,
        profile.inlineCompletionEnabled ? 'Inline' : null,
    ].filter((item): item is string => Boolean(item));

    return features.length ? features.join(' / ') : '未启用';
};

const detailProfile = computed(() => profileDetail.value?.profile ?? null);
const detailApiKey = computed(() => profileDetail.value?.apiKey ?? '');
const maskedDetailApiKey = computed(() => {
    const value = detailApiKey.value;

    if (!value) {
        return '未保存';
    }

    if (isApiKeyVisible.value) {
        return value;
    }

    const characters = Array.from(value);
    if (characters.length <= 8) {
        return '••••••••';
    }

    return `${characters.slice(0, 4).join('')}••••••••${characters.slice(-4).join('')}`;
});

watch(
    () => nextConfig.value.providerType,
    () => {
        ensureLiteLlmConnectionDefaults();
    },
    { immediate: true },
);

watch(
    () => nextConfig.value.selectedModel,
    (selectedModel) => {
        const platform = findAiServicePlatformByModel(selectedModel);
        activeServicePlatformId.value = platform.id;
        if (!isAiServicePlatformModel(platform.id, selectedModel)) {
            nextConfig.value.selectedModel = platform.defaultModel;
        }
    },
    { immediate: true },
);

watch(
    () => props.open,
    (isOpen) => {
        if (!isOpen) {
            hideStatus();
            closeDropdowns();
            return;
        }
        resetEphemeralState();
        settingsView.value = 'form';
        profileDetail.value = null;
        isApiKeyVisible.value = false;
        syncDraftWithServicePlatform(findAiServicePlatformByModel(nextConfig.value.selectedModel).id);
        void autoApply.loadAuthState().catch(() => undefined);
    },
    { immediate: true },
);

onMounted(() => {
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onDocumentKeydown);
    void autoApply.loadAuthState().catch(() => undefined);
});

onBeforeUnmount(() => {
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onDocumentKeydown);
    hideStatus();
});
</script>

<template>
    <Teleport to="body">
        <div v-if="props.open" class="modal-shell" @click.self="emit('close')">
            <div class="modal">
                <div class="modal-header">
                    <div class="modal-title-group">
                        <h2>{{ settingsTitle }}</h2>
                        <span>{{ settingsSubtitle }}</span>
                    </div>
                    <button
                        type="button"
                        class="profile-icon-action"
                        :title="settingsView === 'form' ? '进入配置记录' : '返回'"
                        :aria-label="settingsView === 'form' ? '进入配置记录' : '返回'"
                        @click="handleHeaderNavigation"
                    >
                        <svg
                            v-if="settingsView === 'form'"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                        >
                            <rect x="4" y="5" width="16" height="4" rx="1.5" />
                            <rect x="4" y="11" width="16" height="4" rx="1.5" />
                            <rect x="4" y="17" width="16" height="2" rx="1" />
                        </svg>
                        <svg
                            v-else
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                        >
                            <path d="m15 18-6-6 6-6" />
                        </svg>
                    </button>
                </div>

                <div v-if="settingsView === 'form'" class="modal-body">
                    <div class="form-row">
                        <div class="form-item">
                            <label class="form-label">AI 服务平台</label>
                            <div class="lr-select" :class="{ open: isPlatformOpen }" data-key="platform">
                                <button type="button" class="lr-select-trigger" aria-haspopup="listbox"
                                    @click.stop="isPlatformOpen = !isPlatformOpen; isModelOpen = false">
                                    <AiProviderIcon
                                        class="lr-select-icon"
                                        :platform-id="activeServicePlatformId"
                                        :title="selectedPlatformLabel"
                                        decorative
                                    />
                                    <span class="lr-select-value">{{ selectedPlatformLabel }}</span>
                                    <svg class="lr-select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <polyline points="6 9 12 15 18 9" />
                                    </svg>
                                </button>
                                <div class="lr-select-menu" role="listbox" @click.stop>
                                    <div v-for="option in platformOptions" :key="option.value"
                                        :data-provider-id="option.value" class="lr-option"
                                        :class="{ selected: option.value === activeServicePlatformId }" role="option"
                                        @click="updatePlatform(option.value)">
                                        <AiProviderIcon
                                            class="lr-option-icon"
                                            :platform-id="option.value"
                                            :title="option.label"
                                            decorative
                                        />
                                        <span class="lr-option-main">{{ option.label }}</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="form-item">
                            <label class="form-label">模型名称</label>
                            <div class="lr-select" :class="{ open: isModelOpen }" data-key="model">
                                <button type="button" class="lr-select-trigger" aria-haspopup="listbox"
                                    @click.stop="isModelOpen = !isModelOpen; isPlatformOpen = false">
                                    <span class="lr-select-value">{{ selectedModelLabel }}</span>
                                    <svg class="lr-select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <polyline points="6 9 12 15 18 9" />
                                    </svg>
                                </button>
                                <div class="lr-select-menu" role="listbox" @click.stop>
                                    <div v-for="option in modelOptions" :key="option.value" class="lr-option"
                                        :class="{ selected: option.value === nextConfig.selectedModel }" role="option"
                                        @click="updateModel(option.value)">
                                        <span class="lr-option-main">{{ option.label }}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="form-item">
                        <label class="form-label">API Key</label>
                        <div class="key-wrapper">
                            <input v-model="apiKey" type="password" class="form-input"
                                :placeholder="activePreset.apiKeyHint || 'sk-xxxx'" />
                            <div class="key-actions">
                                <button class="key-btn" aria-label="复制" @click="copyKey">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                                        stroke-linecap="round" stroke-linejoin="round">
                                        <rect x="9" y="9" width="13" height="13" rx="2" />
                                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <div class="tip">仅本地存储，不上传</div>
                    </div>

                    <div class="form-item">
                        <label class="form-label">API Base URL</label>
                        <input v-model="nextConfig.baseUrl" class="form-input"
                            :readonly="!activePreset.isEndpointEditable" :placeholder="activePreset.baseUrl ?? ''" />
                    </div>

                    <div class="form-row">
                        <div class="form-item">
                            <label class="form-label">请求超时（秒）</label>
                            <input v-model.number="advancedDraft.timeoutSeconds" type="number" class="form-input"
                                min="5" max="120" />
                        </div>
                        <div class="form-item">
                            <label class="form-label">代理地址（可选）</label>
                            <input v-model="advancedDraft.proxyUrl" class="form-input"
                                placeholder="http://127.0.0.1:7890" />
                        </div>
                    </div>

                    <div class="slider-row">
                        <div class="slider-item">
                            <div class="slider-label"><span>温度</span><span class="slider-val">{{
                                advancedDraft.temperature.toFixed(1) }}</span></div>
                            <input v-model.number="advancedDraft.temperature" type="range" min="0" max="2" step="0.1" />
                        </div>
                        <div class="slider-item">
                            <div class="slider-label"><span>Top P</span><span class="slider-val">{{
                                advancedDraft.topP.toFixed(1) }}</span></div>
                            <input v-model.number="advancedDraft.topP" type="range" min="0" max="1" step="0.1" />
                        </div>
                    </div>

                    <div class="form-row">
                        <div class="form-item" style="flex: 0 0 200px;">
                            <label class="form-label">最大输出 Tokens</label>
                            <input v-model.number="advancedDraft.maxTokens" type="number" class="form-input" min="256"
                                max="128000" />
                        </div>
                        <div class="form-item" style="flex: 1;">
                            <label class="form-label">流式输出</label>
                            <div class="switch-inline">
                                <div class="switch" :class="{ active: streamEnabled }" @click="toggleStream"></div>
                                <span class="switch-text">{{ streamEnabled ? '已开启' : '已关闭' }}</span>
                            </div>
                        </div>
                    </div>

                    <section class="aed-section" aria-label="AED 授权设置">
                        <div class="aed-section__header">
                            <div>
                                <span class="aed-section__eyebrow">Agent Edit</span>
                                <strong>自动应用授权</strong>
                            </div>
                            <span class="aed-section__badge" :class="autoApplyToneClass">{{ autoApplyModeLabel }}</span>
                        </div>
                        <p class="aed-section__copy">控制 Agent patch 是保持手动审批，还是在当前任务 / 当前会话内直接自动应用。</p>

                        <div class="aed-auth-grid">
                            <button v-for="option in autoApplyOptions" :key="option.value" type="button"
                                class="aed-auth-card" :class="{
                                    'is-selected': option.value === autoApply.authLevel.value,
                                    'is-manual': option.value === 'manual',
                                    'is-task': option.value === 'per_task',
                                    'is-session': option.value === 'session',
                                }" @click="updateAutoApplyLevel(option.value)">
                                <span class="aed-auth-card__title">{{ option.label }}</span>
                                <span class="aed-auth-card__description">{{ option.description }}</span>
                            </button>
                        </div>

                        <div class="aed-section__meta">
                            <span>{{ autoApplyStatusLabel }}</span>
                            <span>最近变更：{{ autoApplyUpdatedAtLabel }}</span>
                        </div>
                    </section>
                </div>

                <div v-else-if="settingsView === 'profiles'" class="modal-body profile-switcher">
                    <div v-if="hasProfiles" class="profile-list" aria-label="AI 配置记录列表">
                        <article
                            v-for="profile in sortedProfiles"
                            :key="profile.id"
                            class="profile-card"
                            :class="{ 'is-active': profile.id === activeProfileId }"
                        >
                            <span class="profile-drag" aria-hidden="true">
                                <span></span>
                                <span></span>
                                <span></span>
                            </span>
                            <AiProviderIcon
                                class="profile-provider-icon"
                                :platform-id="getProfilePlatformId(profile)"
                                :title="getProfilePlatformLabel(profile)"
                                decorative
                            />
                            <div class="profile-main">
                                <div class="profile-title-row">
                                    <strong>{{ profile.name }}</strong>
                                    <span v-if="profile.id === activeProfileId" class="profile-active-badge">当前</span>
                                </div>
                                <span class="profile-url">{{ getProfileEndpointLabel(profile) }}</span>
                                <dl class="profile-details">
                                    <div>
                                        <dt>平台</dt>
                                        <dd>{{ getProfilePlatformLabel(profile) }}</dd>
                                    </div>
                                    <div>
                                        <dt>模型</dt>
                                        <dd>{{ getProfileModelLabel(profile) }}</dd>
                                    </div>
                                    <div>
                                        <dt>凭证</dt>
                                        <dd>{{ profile.hasCredentials ? '已保存' : '缺失' }}</dd>
                                    </div>
                                    <div>
                                        <dt>最近使用</dt>
                                        <dd>{{ getProfileTimeLabel(profile) }}</dd>
                                    </div>
                                </dl>
                            </div>
                            <div class="profile-actions">
                                <button
                                    type="button"
                                    class="profile-action-button"
                                    title="查看配置"
                                    aria-label="查看配置"
                                    @click="showProfileDetail(profile)"
                                >
                                    <svg
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        aria-hidden="true"
                                    >
                                        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
                                        <circle cx="12" cy="12" r="3" />
                                    </svg>
                                </button>
                                <button
                                    type="button"
                                    class="profile-action-button"
                                    :disabled="profile.id === activeProfileId || isSaving"
                                    title="快速切换"
                                    aria-label="快速切换"
                                    @click="switchProfile(profile)"
                                >
                                    <svg
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        aria-hidden="true"
                                    >
                                        <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
                                    </svg>
                                </button>
                            </div>
                        </article>
                    </div>
                    <div v-else class="profile-empty">
                        <strong>还没有可切换的配置</strong>
                        <span>完成一次“开始连接”后，成功的 API 配置会自动出现在这里。</span>
                        <button type="button" class="btn btn-test" @click="showConnectionForm">去连接</button>
                    </div>
                </div>

                <div v-else class="modal-body profile-detail">
                    <div v-if="isProfileDetailLoading" class="profile-empty">
                        <strong>正在读取配置详情</strong>
                        <span>API Key 只会在本地只读展示。</span>
                    </div>
                    <section v-else-if="detailProfile" class="profile-detail-card">
                        <div class="profile-detail-head">
                            <AiProviderIcon
                                class="profile-detail-icon"
                                :platform-id="getProfilePlatformId(detailProfile)"
                                :title="getProfilePlatformLabel(detailProfile)"
                                decorative
                            />
                            <div>
                                <strong>{{ detailProfile.name }}</strong>
                                <span>{{ getProfilePlatformLabel(detailProfile) }} · {{ getProfileModelLabel(detailProfile) }}</span>
                            </div>
                        </div>

                        <dl class="profile-readonly-list">
                            <div>
                                <dt>API Base URL</dt>
                                <dd>{{ getProfileEndpointLabel(detailProfile) }}</dd>
                            </div>
                            <div>
                                <dt>模型</dt>
                                <dd>{{ getProfileModelLabel(detailProfile) }}</dd>
                            </div>
                            <div>
                                <dt>能力</dt>
                                <dd>{{ getProfileFeatureLabel(detailProfile) }}</dd>
                            </div>
                            <div>
                                <dt>最近使用</dt>
                                <dd>{{ getProfileTimeLabel(detailProfile) }}</dd>
                            </div>
                            <div class="is-secret">
                                <dt>API Key</dt>
                                <dd>
                                    <code :class="{ 'is-visible': isApiKeyVisible }">{{ maskedDetailApiKey }}</code>
                                    <button
                                        type="button"
                                        class="profile-action-button"
                                        :disabled="!detailApiKey"
                                        :title="isApiKeyVisible ? '隐藏 API Key' : '查看 API Key'"
                                        :aria-label="isApiKeyVisible ? '隐藏 API Key' : '查看 API Key'"
                                        @click="isApiKeyVisible = !isApiKeyVisible"
                                    >
                                        <svg
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            aria-hidden="true"
                                        >
                                            <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
                                            <circle cx="12" cy="12" r="3" />
                                        </svg>
                                    </button>
                                </dd>
                            </div>
                        </dl>
                    </section>
                </div>

                <div v-if="settingsView === 'form'" class="modal-footer">
                    <button class="btn btn-test" :disabled="!canTestProvider" @click="testConnection">
                        {{ isTesting ? '正在测试' : '测试连接' }}
                    </button>
                    <button class="btn btn-save" :disabled="!canSaveProvider" @click="saveConfig">
                        {{ isSaving ? '正在连接' : '开始连接' }}
                    </button>
                </div>
            </div>

            <div v-if="statusMessage" class="status" :class="[`status-${statusTone}`, 'show']">
                <span class="status-icon">
                    <svg v-if="statusTone === 'success'" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <svg v-else-if="statusTone === 'error'" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span v-else class="status-pulse" aria-hidden="true" />
                </span>
                <span class="status-text">{{ statusMessage }}</span>
            </div>
        </div>
    </Teleport>
</template>

<style scoped>
.modal-shell {
    --bg-app: #08090a;
    --bg-elevated: #1b1b1f;
    --bg-overlay: #1b1b1f;
    --bg-input: #1c1d20;
    --bg-input-hover: #202125;
    --bg-hover: #1f2023;
    --bg-active: #26272b;

    --border-subtle: #1f2023;
    --border: #26272b;
    --border-strong: #2e2f33;

    --fg-primary: #f7f8f8;
    --fg-secondary: #b4b5bc;
    --fg-tertiary: #8a8f98;
    --fg-muted: #6c6f7b;

    --accent: #5e6ad2;
    --accent-hover: #6e79da;
    --accent-soft: rgba(94, 106, 210, 0.12);
    --accent-ring: rgba(94, 106, 210, 0.32);

    --success: #4cb782;
    --danger: #eb5757;

    --r-sm: 5px;
    --r-md: 6px;
    --r-lg: 8px;

    --shadow-modal:
        0 0 0 1px rgba(255, 255, 255, 0.04),
        0 10px 20px rgba(0, 0, 0, 0.18);

    --ease: cubic-bezier(0.4, 0, 0.2, 1);
}

* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

.modal-shell {
    position: fixed;
    inset: 0;
    background: transparent;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 24px;
    z-index: 9999;
    pointer-events: auto;
    animation: fadeIn 0.14s var(--ease);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-feature-settings: 'cv11', 'ss01', 'ss03';
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

@keyframes fadeIn {
    from {
        opacity: 0;
    }

    to {
        opacity: 1;
    }
}

.modal {
    background: var(--bg-elevated);
    width: clamp(560px, 62vw, 720px);
    max-width: calc(100vw - 48px);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-modal);
    overflow: hidden;
    pointer-events: auto;
    animation: pop 0.16s var(--ease);
    color: var(--fg-primary);
}

@keyframes pop {
    from {
        opacity: 0;
        transform: translateY(4px) scale(0.985);
    }

    to {
        opacity: 1;
        transform: translateY(0) scale(1);
    }
}

.modal-header {
    height: 48px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
}

.modal-title-group {
    display: grid;
    gap: 3px;
    min-width: 0;
}

.modal-header h2 {
    font-size: 13px;
    font-weight: 500;
    color: var(--fg-primary);
    letter-spacing: -0.01em;
}

.modal-title-group span {
    color: var(--fg-muted);
    font-size: 11px;
    line-height: 14px;
}

.profile-icon-action {
    display: grid;
    width: 30px;
    height: 30px;
    place-items: center;
    flex: 0 0 auto;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--bg-input);
    color: var(--fg-secondary);
    transition: background 0.12s var(--ease), border-color 0.12s var(--ease), color 0.12s var(--ease), transform 0.12s var(--ease);
}

.profile-icon-action:hover {
    border-color: var(--border-strong);
    background: var(--bg-hover);
    color: var(--fg-primary);
}

.profile-icon-action:active {
    transform: scale(0.97);
}

.profile-icon-action svg {
    width: 15px;
    height: 15px;
}

.modal-body {
    padding: 16px;
    max-height: 72vh;
    overflow-y: auto;
}

.modal-body::-webkit-scrollbar {
    width: 8px;
}

.modal-body::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 4px;
}

.modal-body::-webkit-scrollbar-thumb:hover {
    background: var(--border-strong);
}

.form-item {
    margin-bottom: 14px;
}

.form-label {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    font-weight: 500;
    color: var(--fg-secondary);
    letter-spacing: -0.005em;
}

.form-input,
.form-select {
    width: 100%;
    height: 32px;
    padding: 0 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-subtle);
    border-radius: var(--r-md);
    font-size: 13px;
    color: var(--fg-primary);
    font-family: inherit;
    transition: border-color 0.12s var(--ease), background 0.12s var(--ease), box-shadow 0.12s var(--ease);
}

.form-input:hover,
.form-select:hover {
    background: var(--bg-input-hover);
    border-color: var(--border);
}

.form-input:focus,
.form-select:focus {
    outline: none;
    border-color: var(--accent);
    background: var(--bg-input-hover);
    box-shadow: 0 0 0 3px var(--accent-ring);
}

.form-input::placeholder {
    color: var(--fg-muted);
}

input[type='number']::-webkit-outer-spin-button,
input[type='number']::-webkit-inner-spin-button {
    -webkit-appearance: none;
    appearance: none;
    margin: 0;
}

input[type='number'] {
    -moz-appearance: textfield;
    appearance: textfield;
}

.form-row {
    display: flex;
    gap: 10px;
}

.form-row .form-item {
    flex: 1;
    margin-bottom: 14px;
}

.lr-select {
    position: relative;
    width: 100%;
}

.lr-select-trigger {
    width: 100%;
    height: 32px;
    padding: 0 8px 0 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-subtle);
    border-radius: var(--r-md);
    font-size: 13px;
    font-family: inherit;
    color: var(--fg-primary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    text-align: left;
    letter-spacing: -0.005em;
    transition: border-color 0.12s var(--ease), background 0.12s var(--ease), box-shadow 0.12s var(--ease);
}

.lr-select-trigger:hover {
    background: var(--bg-input-hover);
    border-color: var(--border);
}

.lr-select.open .lr-select-trigger {
    border-color: var(--accent);
    background: var(--bg-input-hover);
    box-shadow: 0 0 0 3px var(--accent-ring);
}

.lr-select-value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.lr-select-icon {
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
}

.lr-select-chevron {
    width: 12px;
    height: 12px;
    color: var(--fg-tertiary);
    transition: transform 0.15s var(--ease), color 0.15s var(--ease);
    flex-shrink: 0;
}

.lr-select.open .lr-select-chevron {
    transform: rotate(180deg);
    color: var(--fg-secondary);
}

.lr-select-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: var(--bg-overlay);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 4px;
    box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.03),
        0 12px 28px rgba(0, 0, 0, 0.4),
        0 4px 8px rgba(0, 0, 0, 0.24);
    z-index: 100;
    max-height: 248px;
    overflow-y: auto;
    display: none;
    transform-origin: top center;
}

.lr-select.open .lr-select-menu {
    display: block;
    animation: menuPop 0.14s var(--ease);
}

@keyframes menuPop {
    from {
        opacity: 0;
        transform: translateY(-4px) scale(0.98);
    }

    to {
        opacity: 1;
        transform: translateY(0) scale(1);
    }
}

.lr-option {
    min-height: 28px;
    padding: 0 10px 0 26px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--fg-secondary);
    border-radius: var(--r-sm);
    cursor: pointer;
    position: relative;
    transition: background 0.1s var(--ease), color 0.1s var(--ease);
    letter-spacing: -0.005em;
    user-select: none;
}

.lr-option-icon {
    width: 15px;
    height: 15px;
    flex: 0 0 auto;
}

.lr-option-main {
    flex: 1;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.lr-option-main {
    color: inherit;
}

.lr-option:hover {
    background: var(--bg-hover);
    color: var(--fg-primary);
}

.lr-option.selected {
    color: var(--fg-primary);
    background: var(--accent-soft);
}

.lr-option.selected::before {
    content: '';
    position: absolute;
    left: 8px;
    top: 50%;
    width: 11px;
    height: 11px;
    transform: translateY(-50%);
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235E6AD2' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='20 6 9 17 4 12'/></svg>");
    background-size: contain;
    background-repeat: no-repeat;
}

.lr-select-menu::-webkit-scrollbar {
    width: 8px;
}

.lr-select-menu::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 4px;
}

.lr-select-menu::-webkit-scrollbar-thumb:hover {
    background: var(--border-strong);
}

.tip {
    font-size: 11.5px;
    color: var(--fg-muted);
    margin-top: 6px;
    letter-spacing: -0.005em;
}

.key-wrapper {
    position: relative;
    display: flex;
    align-items: center;
}

.key-wrapper input {
    padding-right: 36px;
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px;
}

.key-actions {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    gap: 1px;
}

.key-btn {
    width: 24px;
    height: 24px;
    background: transparent;
    border: none;
    border-radius: var(--r-sm);
    color: var(--fg-tertiary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s var(--ease), color 0.12s var(--ease);
}

.key-btn:hover {
    background: var(--bg-active);
    color: var(--fg-primary);
}

.key-btn svg {
    width: 14px;
    height: 14px;
}

.switch-inline {
    height: 32px;
    display: flex;
    align-items: center;
    gap: 10px;
}

.switch-text {
    font-size: 12.5px;
    color: var(--fg-tertiary);
    font-variant-numeric: tabular-nums;
}

.switch {
    position: relative;
    width: 28px;
    height: 16px;
    background: var(--bg-active);
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.15s var(--ease);
    box-shadow: inset 0 0 0 1px var(--border);
}

.switch::after {
    content: '';
    position: absolute;
    width: 12px;
    height: 12px;
    left: 2px;
    top: 2px;
    background: #fff;
    border-radius: 50%;
    transition: left 0.15s var(--ease);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.switch.active {
    background: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
}

.switch.active::after {
    left: 14px;
}

.slider-row {
    display: flex;
    gap: 14px;
    margin-bottom: 14px;
}

.aed-section {
    display: grid;
    gap: 12px;
    margin-top: 4px;
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0));
    padding: 14px;
}

.aed-section__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
}

.aed-section__header strong {
    display: block;
    color: var(--fg-primary);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.01em;
}

.aed-section__eyebrow {
    display: inline-flex;
    margin-bottom: 6px;
    color: var(--fg-muted);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
}

.aed-section__badge {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    border: 1px solid var(--border);
    padding: 4px 9px;
    color: var(--fg-secondary);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
}

.aed-section__badge.is-task {
    border-color: rgba(86, 168, 255, 0.35);
    background: rgba(86, 168, 255, 0.12);
    color: #dcecff;
}

.aed-section__badge.is-session {
    border-color: rgba(245, 158, 11, 0.42);
    background: rgba(245, 158, 11, 0.14);
    color: #fff1cf;
}

.aed-section__copy,
.aed-section__meta {
    color: var(--fg-secondary);
    font-size: 12px;
    line-height: 1.6;
}

.aed-section__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    color: var(--fg-tertiary);
}

.profile-switcher {
    min-height: 320px;
}

.profile-list {
    display: grid;
    gap: 8px;
}

.profile-card {
    display: grid;
    grid-template-columns: 12px 30px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    min-height: 68px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-input) 84%, transparent);
    padding: 8px 10px;
    transition: background 0.14s var(--ease), border-color 0.14s var(--ease), transform 0.14s var(--ease);
}

.profile-card:hover {
    border-color: var(--border-strong);
    background: var(--bg-input-hover);
}

.profile-card.is-active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--bg-input));
}

.profile-drag {
    display: grid;
    grid-template-columns: repeat(2, 3px);
    gap: 2px;
    color: var(--fg-muted);
}

.profile-drag span {
    width: 3px;
    height: 3px;
    border-radius: 999px;
    background: currentColor;
}

.profile-provider-icon {
    display: grid;
    width: 30px;
    height: 30px;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-elevated);
    padding: 6px;
    font-size: 17px;
}

.profile-main {
    display: grid;
    min-width: 0;
    gap: 3px;
}

.profile-title-row {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 8px;
}

.profile-title-row strong {
    overflow: hidden;
    color: var(--fg-primary);
    font-size: 13px;
    font-weight: 650;
    letter-spacing: -0.02em;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.profile-active-badge {
    flex: 0 0 auto;
    border: 1px solid var(--accent-ring);
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--fg-primary);
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
    padding: 0 7px;
}

.profile-url {
    overflow: hidden;
    color: var(--accent-hover);
    font-size: 11.5px;
    line-height: 16px;
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.profile-details {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 5px;
}

.profile-details div {
    min-width: 0;
}

.profile-details dt {
    color: var(--fg-muted);
    font-size: 10px;
    line-height: 12px;
}

.profile-details dd {
    overflow: hidden;
    color: var(--fg-secondary);
    font-size: 10.5px;
    line-height: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.profile-actions {
    display: flex;
    align-items: center;
    gap: 6px;
}

.profile-action-button {
    display: grid;
    width: 28px;
    height: 28px;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--bg-elevated);
    color: var(--fg-primary);
    transition: background 0.12s var(--ease), border-color 0.12s var(--ease), transform 0.12s var(--ease), opacity 0.12s var(--ease);
}

.profile-action-button:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--bg-hover);
}

.profile-action-button:active:not(:disabled) {
    transform: scale(0.97);
}

.profile-action-button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
}

.profile-action-button svg {
    width: 14px;
    height: 14px;
}

.profile-detail {
    min-height: 320px;
}

.profile-detail-card {
    display: grid;
    gap: 14px;
}

.profile-detail-head {
    display: flex;
    align-items: center;
    gap: 12px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--bg-input);
    padding: 12px;
}

.profile-detail-icon {
    width: 38px;
    height: 38px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-elevated);
    padding: 9px;
}

.profile-detail-head strong {
    display: block;
    color: var(--fg-primary);
    font-size: 14px;
    font-weight: 650;
}

.profile-detail-head span {
    color: var(--fg-tertiary);
    font-size: 12px;
    line-height: 18px;
}

.profile-readonly-list {
    display: grid;
    gap: 8px;
}

.profile-readonly-list > div {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    align-items: center;
    min-height: 34px;
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    background: color-mix(in srgb, var(--bg-input) 72%, transparent);
    padding: 8px 10px;
}

.profile-readonly-list dt {
    color: var(--fg-muted);
    font-size: 11px;
}

.profile-readonly-list dd {
    min-width: 0;
    overflow: hidden;
    color: var(--fg-secondary);
    font-size: 12px;
    line-height: 18px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.profile-readonly-list .is-secret dd {
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: visible;
    white-space: normal;
}

.profile-readonly-list code {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--fg-primary);
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.profile-readonly-list code.is-visible {
    overflow-wrap: anywhere;
    text-overflow: clip;
    white-space: normal;
}

.profile-empty {
    display: grid;
    min-height: 320px;
    place-items: center;
    align-content: center;
    gap: 10px;
    border: 1px dashed var(--border);
    border-radius: 16px;
    color: var(--fg-tertiary);
    text-align: center;
}

.profile-empty strong {
    color: var(--fg-primary);
    font-size: 14px;
    font-weight: 600;
}

.profile-empty span {
    max-width: 320px;
    font-size: 12px;
    line-height: 1.6;
}

.aed-auth-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
}

.aed-auth-card {
    display: grid;
    gap: 6px;
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    background: var(--bg-input);
    padding: 12px;
    text-align: left;
    transition: border-color 0.12s var(--ease), background 0.12s var(--ease), transform 0.12s var(--ease);
}

.aed-auth-card:hover {
    background: var(--bg-input-hover);
    border-color: var(--border);
}

.aed-auth-card:active {
    transform: scale(0.985);
}

.aed-auth-card.is-selected {
    box-shadow: 0 0 0 1px var(--accent-ring);
}

.aed-auth-card.is-task.is-selected {
    border-color: rgba(86, 168, 255, 0.42);
    background: rgba(86, 168, 255, 0.12);
}

.aed-auth-card.is-session.is-selected {
    border-color: rgba(245, 158, 11, 0.42);
    background: rgba(245, 158, 11, 0.14);
}

.aed-auth-card__title {
    color: var(--fg-primary);
    font-size: 12.5px;
    font-weight: 600;
}

.aed-auth-card__description {
    color: var(--fg-tertiary);
    font-size: 11.5px;
    line-height: 1.5;
}

.slider-item {
    flex: 1;
}

.slider-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--fg-secondary);
    margin-bottom: 8px;
    display: flex;
    justify-content: space-between;
}

.slider-val {
    color: var(--fg-primary);
    font-variant-numeric: tabular-nums;
    font-weight: 500;
}

input[type='range'] {
    width: 100%;
    height: 4px;
    background: var(--bg-active);
    border-radius: 2px;
    outline: none;
    -webkit-appearance: none;
    appearance: none;
    cursor: pointer;
}

input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    background: var(--fg-primary);
    border: 2px solid var(--bg-elevated);
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 0 0 1px var(--border-strong), 0 1px 2px rgba(0, 0, 0, 0.4);
    transition: transform 0.12s var(--ease);
}

input[type='range']::-webkit-slider-thumb:hover {
    transform: scale(1.15);
}

input[type='range']::-moz-range-thumb {
    width: 12px;
    height: 12px;
    background: var(--fg-primary);
    border: 2px solid var(--bg-elevated);
    border-radius: 50%;
    cursor: pointer;
}

.modal-footer {
    height: 52px;
    padding: 0 16px;
    border-top: 1px solid var(--border-subtle);
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    background: var(--bg-elevated);
}

@media (max-width: 720px) {
    .aed-auth-grid {
        grid-template-columns: 1fr;
    }

    .profile-card {
        grid-template-columns: 12px 30px minmax(0, 1fr);
    }

    .profile-actions {
        grid-column: 3;
        justify-self: start;
    }

    .profile-details {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .profile-readonly-list > div {
        grid-template-columns: 1fr;
        gap: 4px;
    }

    .aed-section__header {
        flex-direction: column;
    }
}

.btn {
    height: 28px;
    padding: 0 11px;
    border: 1px solid transparent;
    border-radius: var(--r-md);
    font-size: 12.5px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: background 0.12s var(--ease), border-color 0.12s var(--ease), color 0.12s var(--ease);
    letter-spacing: -0.005em;
}

.btn-test {
    background: transparent;
    color: var(--fg-primary);
    border-color: var(--border);
}

.btn-test:hover {
    background: var(--bg-hover);
    border-color: var(--border-strong);
}

.btn-save {
    background: var(--accent);
    color: #fff;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}

.btn-save:hover {
    background: var(--accent-hover);
}

.btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
}

.status {
    position: fixed;
    top: 20px;
    left: 50%;
    height: 32px;
    padding: 0 12px;
    border-radius: var(--r-md);
    font-size: 12.5px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--fg-secondary);
    letter-spacing: -0.005em;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 10000;
    opacity: 0;
    pointer-events: none;
    transform: translate(-50%, -6px);
    transition: opacity 0.14s var(--ease), transform 0.14s var(--ease);
    white-space: nowrap;
    max-width: calc(100vw - 40px);
}

.status.show {
    opacity: 1;
    transform: translate(-50%, 0);
}

.status-icon {
    width: 12px;
    height: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

.status-icon svg {
    width: 12px;
    height: 12px;
    stroke-width: 2.4;
}

.status-success .status-icon {
    color: var(--success);
}

.status-error .status-icon {
    color: var(--danger);
}

.status-info .status-icon {
    color: var(--accent);
}

.status-pulse {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: currentColor;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);
}

@media (max-width: 640px) {
    .modal {
        width: calc(100vw - 16px);
        max-width: 100%;
    }

    .modal-body {
        padding: 14px;
    }

    .form-row,
    .slider-row {
        flex-direction: column;
        gap: 0;
    }

    .form-item[style],
    .form-item {
        flex: 1 1 auto !important;
    }
}
</style>

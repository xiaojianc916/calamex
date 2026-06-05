<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AiProviderIcon from '@/components/business/ai/provider/AiProviderIcon.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AI_SERVICE_PLATFORM_PRESETS,
  findAiServicePlatformByModel,
  findAiServicePlatformPreset,
  type IAiServicePlatformPreset,
  type TAiServicePlatformId,
} from '@/constants/ai/providers';
import { cloneAiConfigPayload } from '@/services/ipc/ai-config.service';
import type { IAiConfigPayload, IAiProviderSettingsActionFeedback, TAiModelRole } from '@/types/ai';

const props = defineProps<{
  open: boolean;
  config: IAiConfigPayload;
  draft: IAiConfigPayload;
  apiKey: string;
  tavilyApiKey: string;
}>();

const emit = defineEmits<{
  close: [];
  'update:draft': [value: IAiConfigPayload];
  'update:apiKey': [value: string];
  'update:tavilyApiKey': [value: string];
  save: [
    config: IAiConfigPayload,
    apiKey: string,
    role: TAiModelRole,
    feedback: IAiProviderSettingsActionFeedback,
  ];
  testProvider: [
    config: IAiConfigPayload,
    apiKey: string,
    role: TAiModelRole,
    feedback: IAiProviderSettingsActionFeedback,
  ];
  saveTavilyKey: [apiKey: string, feedback: IAiProviderSettingsActionFeedback];
}>();

type TPane = 'list' | 'form';
type TFeedbackTone = 'info' | 'success' | 'error';
type TActionState = 'idle' | 'saving' | 'testing';

interface IProviderViewModel {
  preset: IAiServicePlatformPreset;
  hasCredentials: boolean;
  alias: string;
  keyPreview: string;
  isNarratorProvider: boolean;
}

const pane = ref<TPane>('list');
const searchText = ref('');
const selectedProviderId = ref<TAiServicePlatformId>(
  findAiServicePlatformByModel(props.config.selectedModel).id,
);
const selectedSmallModelId = ref('');
const credentialAlias = ref('默认');
const aliasError = ref('');
const providerKeyError = ref('');
const tavilyKeyError = ref('');
const feedbackText = ref('');
const feedbackTone = ref<TFeedbackTone>('info');
const actionState = ref<TActionState>('idle');
const isKeyVisible = ref(false);
const isProviderMenuOpen = ref(false);
const isSmallModelMenuOpen = ref(false);

const credentialsByProvider = computed(() => {
  const entries = props.config.credentials ?? [];
  return new Map(entries.map((entry) => [entry.providerId, entry]));
});

const mainProviderId = computed(() => findAiServicePlatformByModel(props.config.selectedModel).id);
const narratorProviderId = computed(
  () => findAiServicePlatformByModel(props.config.narrator.selectedModel).id,
);
const selectedProvider = computed(() => findAiServicePlatformPreset(selectedProviderId.value));
const selectedProviderHasCredentials = computed(
  () => credentialsByProvider.value.get(selectedProviderId.value)?.hasCredentials === true,
);
const selectedProviderModels = computed(() => selectedProvider.value.models);
const selectedSmallModel = computed(() => {
  const matched = selectedProviderModels.value.find(
    (model) => model.id === selectedSmallModelId.value,
  );
  return (
    matched ??
    selectedProviderModels.value[0] ?? {
      id: selectedProvider.value.defaultModel,
      label: selectedProvider.value.defaultModel,
    }
  );
});

const providerKey = computed({
  get: () => props.apiKey,
  set: (value: string) => {
    providerKeyError.value = '';
    emit('update:apiKey', value);
  },
});

const tavilyKey = computed({
  get: () => props.tavilyApiKey,
  set: (value: string) => {
    tavilyKeyError.value = '';
    emit('update:tavilyApiKey', value);
  },
});

// 名称输入时即时清除校验错误，和 API Key / Tavily Key 的清除行为保持一致。
watch(credentialAlias, () => {
  if (aliasError.value) {
    aliasError.value = '';
  }
});

const providerRows = computed<IProviderViewModel[]>(() =>
  AI_SERVICE_PLATFORM_PRESETS.filter(
    (preset) => credentialsByProvider.value.get(preset.id)?.hasCredentials === true,
  ).map((preset) => {
    const credential = credentialsByProvider.value.get(preset.id);
    return {
      preset,
      hasCredentials: true,
      alias: credential?.alias?.trim() || '厂商 API Key',
      keyPreview: credential?.keyPreview?.trim() || '已加密保存',
      isNarratorProvider: preset.id === narratorProviderId.value,
    };
  }),
);

const filteredProviderRows = computed(() => {
  const keyword = searchText.value.trim().toLocaleLowerCase();
  if (!keyword) {
    return providerRows.value;
  }
  return providerRows.value.filter((row) => {
    const haystack = [
      row.preset.id,
      row.preset.label,
      ...row.preset.models.map((model) => model.label),
    ]
      .join(' ')
      .toLocaleLowerCase();
    return haystack.includes(keyword);
  });
});

const isSaving = computed(() => actionState.value === 'saving');
const isTesting = computed(() => actionState.value === 'testing');
const canSaveProviderKey = computed(() => {
  const hasKey = selectedProviderHasCredentials.value || providerKey.value.trim().length > 0;
  return credentialAlias.value.trim().length > 0 && hasKey && !isSaving.value;
});
const canTestSelectedProvider = computed(() => {
  const hasKey = selectedProviderHasCredentials.value || providerKey.value.trim().length > 0;
  return hasKey && !isTesting.value;
});

const resolveSmallModelForProvider = (providerId: TAiServicePlatformId): string => {
  const provider = findAiServicePlatformPreset(providerId);
  const narratorModelId = props.config.narrator.selectedModel;
  if (
    providerId === narratorProviderId.value &&
    provider.models.some((model) => model.id === narratorModelId)
  ) {
    return narratorModelId ?? provider.defaultModel;
  }
  return provider.defaultModel;
};

const showStatus = (message: string, tone: TFeedbackTone): void => {
  feedbackText.value = message;
  feedbackTone.value = tone;
};

const createFeedback = (
  done: () => void,
  fallbackSuccess: string,
): IAiProviderSettingsActionFeedback => ({
  onSuccess(message?: string) {
    done();
    showStatus(message ?? fallbackSuccess, 'success');
  },
  onError(message: string) {
    done();
    showStatus(message, 'error');
  },
});

const openList = (): void => {
  pane.value = 'list';
  aliasError.value = '';
  providerKeyError.value = '';
  tavilyKeyError.value = '';
  isProviderMenuOpen.value = false;
  isSmallModelMenuOpen.value = false;
};

const openForm = (providerId?: TAiServicePlatformId): void => {
  selectedProviderId.value = providerId ?? mainProviderId.value;
  const credential = credentialsByProvider.value.get(selectedProviderId.value);
  credentialAlias.value = credential?.alias?.trim() || '默认';
  selectedSmallModelId.value = resolveSmallModelForProvider(selectedProviderId.value);
  providerKey.value = '';
  aliasError.value = '';
  providerKeyError.value = '';
  tavilyKeyError.value = '';
  feedbackText.value = '';
  isKeyVisible.value = false;
  isProviderMenuOpen.value = false;
  isSmallModelMenuOpen.value = false;
  pane.value = 'form';
};

const handleProviderChange = (providerId: string): void => {
  selectedProviderId.value = providerId as TAiServicePlatformId;
  const credential = credentialsByProvider.value.get(selectedProviderId.value);
  credentialAlias.value = credential?.alias?.trim() || '默认';
  selectedSmallModelId.value = findAiServicePlatformPreset(selectedProviderId.value).defaultModel;
  aliasError.value = '';
  providerKeyError.value = '';
  feedbackText.value = '';
  isProviderMenuOpen.value = false;
  isSmallModelMenuOpen.value = false;
};

const toggleProviderMenu = (): void => {
  isProviderMenuOpen.value = !isProviderMenuOpen.value;
  if (isProviderMenuOpen.value) {
    isSmallModelMenuOpen.value = false;
  }
};

const toggleSmallModelMenu = (): void => {
  isSmallModelMenuOpen.value = !isSmallModelMenuOpen.value;
  if (isSmallModelMenuOpen.value) {
    isProviderMenuOpen.value = false;
  }
};

const handleSmallModelChange = (modelId: string): void => {
  const matched = selectedProviderModels.value.find((model) => model.id === modelId);
  selectedSmallModelId.value = matched?.id ?? selectedProvider.value.defaultModel;
  isSmallModelMenuOpen.value = false;
};

const saveProviderSettings = (): void => {
  const normalizedApiKey = providerKey.value.trim();
  const normalizedAlias = credentialAlias.value.trim();
  if (!normalizedAlias) {
    aliasError.value = '请填写名称。';
    return;
  }
  if (!selectedProviderHasCredentials.value && !normalizedApiKey) {
    providerKeyError.value = '请填写 API Key。';
    return;
  }

  actionState.value = 'saving';
  showStatus(`正在保存 ${selectedProvider.value.label} 设置...`, 'info');
  // 原子保存:只 emit 一次 `save`。父层 @save 走 connectProvider(ai_connect_provider),
  // 在单次 IPC 内同时写入凭证(apiKey 作为第 2 个参数带出)与小模型配置,保证两者
  // 要么一起成功要么一起失败。不要再额外 emit `saveCredentials`:那会让凭证写两遍,
  // 并产生两套互相竞争、可能互相覆盖的 feedback / actionState,破坏保存的原子性。
  emit(
    'save',
    createRoleConfig(selectedProvider.value, 'narrator', selectedSmallModel.value.id),
    normalizedApiKey,
    'narrator',
    createFeedback(() => {
      actionState.value = 'idle';
      providerKey.value = '';
    }, `${selectedProvider.value.label} 小模型已保存`),
  );
};

const testSelectedProvider = (): void => {
  if (!selectedProviderHasCredentials.value && !providerKey.value.trim()) {
    providerKeyError.value = '请先保存或填写当前厂商的 API Key。';
    return;
  }

  actionState.value = 'testing';
  // 与 saveProviderSettings 对齐:测试用的角色 / 模型 / baseUrl 必须和「保存时会写入的」
  // 完全一致(都走 narrator 小模型 + 当前所选小模型),否则「测试通过」不能代表「保存后可用」。
  const role: TAiModelRole = 'narrator';
  const draft = createRoleConfig(selectedProvider.value, role, selectedSmallModel.value.id);
  showStatus(`正在测试 ${selectedProvider.value.label}...`, 'info');
  emit(
    'testProvider',
    draft,
    providerKey.value.trim(),
    role,
    createFeedback(() => {
      actionState.value = 'idle';
    }, `${selectedProvider.value.label} 连接可用`),
  );
};

const createRoleConfig = (
  provider: IAiServicePlatformPreset,
  role: TAiModelRole,
  modelId = provider.defaultModel,
): IAiConfigPayload => {
  const draft = cloneAiConfigPayload(props.draft);
  if (role === 'narrator') {
    draft.narrator.providerType = draft.providerType;
    draft.narrator.selectedModel = modelId;
    draft.narrator.baseUrl = provider.baseUrl || null;
    return draft;
  }

  draft.selectedModel = modelId;
  draft.baseUrl = provider.baseUrl || null;
  return draft;
};

const setProviderAsRoleDefault = (provider: IAiServicePlatformPreset, role: TAiModelRole): void => {
  actionState.value = 'saving';
  const roleLabel = role === 'narrator' ? '小模型' : '主模型';
  showStatus(`正在设置 ${provider.label} 为${roleLabel}...`, 'info');
  emit(
    'save',
    createRoleConfig(provider, role),
    '',
    role,
    createFeedback(() => {
      actionState.value = 'idle';
    }, `${provider.label} 已设为${roleLabel}`),
  );
};

const saveTavily = (): void => {
  const normalizedApiKey = tavilyKey.value.trim();
  if (!normalizedApiKey) {
    tavilyKeyError.value = '请输入 Tavily API Key。';
    return;
  }

  actionState.value = 'saving';
  showStatus('正在保存 Tavily API Key...', 'info');
  emit(
    'saveTavilyKey',
    normalizedApiKey,
    createFeedback(() => {
      actionState.value = 'idle';
    }, 'Tavily API Key 已保存'),
  );
};

const handleClose = (): void => {
  emit('close');
};

watch(
  () => props.open,
  (open) => {
    if (!open) {
      return;
    }

    pane.value = 'list';
    searchText.value = '';
    selectedProviderId.value = mainProviderId.value;
    selectedSmallModelId.value = resolveSmallModelForProvider(selectedProviderId.value);
    credentialAlias.value = '默认';
    aliasError.value = '';
    providerKeyError.value = '';
    tavilyKeyError.value = '';
    feedbackText.value = '';
    actionState.value = 'idle';
    isKeyVisible.value = false;
    isProviderMenuOpen.value = false;
    isSmallModelMenuOpen.value = false;
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ai-credential-shell" @click.self="handleClose">
      <section class="ai-credential-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-credential-title">
        <header class="ai-credential-head" :data-pane="pane">
          <Button v-if="pane === 'form'" class="ai-credential-icon-button" variant="ghost" size="icon-sm" type="button"
            aria-label="返回" @click="openList">
            <span aria-hidden="true" class="icon-[lucide--arrow-left]" />
          </Button>
          <h2 id="ai-credential-title" class="ai-credential-title">
             {{ pane === 'form' ? '编辑凭证' : 'AI 凭证' }} 
          </h2>
          <Button v-if="pane === 'list'" class="ai-credential-head-action" variant="outline" size="sm" type="button"
            @click="openForm()">
            <span aria-hidden="true" class="icon-[lucide--plus]" />
            添加
          </Button>
        </header>

        <section v-if="pane === 'list'" class="ai-credential-pane" aria-label="AI 凭证列表">
          <div class="ai-credential-search">
            <span class="icon-[lucide--search] ai-credential-search__icon" aria-hidden="true" />
            <Input v-model="searchText" class="ai-credential-search__input" placeholder="搜索厂商或模型"
              aria-label="搜索厂商或模型" />
          </div>

          <div class="ai-credential-body">
            <div v-if="filteredProviderRows.length" class="ai-credential-groups">
              <section v-for="row in filteredProviderRows" :key="row.preset.id" class="ai-credential-group">
                <header class="ai-credential-group__head">
                  <AiProviderIcon class="ai-credential-provider-icon" :platform-id="row.preset.id" decorative />
                  <span class="ai-credential-group__name">{{ row.preset.label }}</span>
                </header>
                <div class="ai-credential-row">
                  <div class="ai-credential-row__main">
                    <div class="ai-credential-row__name">
                      <span>{{ row.alias }}</span>
                      <span v-if="row.isNarratorProvider" class="ai-credential-default-mark" aria-label="默认小模型厂商">
                        <AiProviderIcon class="ai-credential-default-mark__icon" :platform-id="row.preset.id"
                          decorative />
                      </span>
                    </div>
                    <div class="ai-credential-row__key">
                       {{ row.preset.id }} / {{ row.keyPreview }} 
                    </div>
                  </div>
                  <div class="ai-credential-row__acts">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger as-child>
                          <Button class="ai-credential-icon-button" variant="ghost" size="icon-sm" type="button"
                            :disabled="isSaving" :aria-label="`设为小模型：${row.preset.label}`"
                            @click="setProviderAsRoleDefault(row.preset, 'narrator')">
                            <span aria-hidden="true" class="icon-[lucide--gauge]" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>设为小模型</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger as-child>
                          <Button class="ai-credential-icon-button" variant="ghost" size="icon-sm" type="button"
                            :aria-label="row.hasCredentials ? `编辑 ${row.preset.label} 凭证` : `添加 ${row.preset.label} 凭证`"
                            @click="openForm(row.preset.id)">
                            <span v-if="row.hasCredentials" aria-hidden="true" class="icon-[lucide--pencil]" />
                            <span v-else aria-hidden="true" class="icon-[lucide--plus]" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{{ row.hasCredentials ? '编辑' : '添加' }}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>
              </section>
            </div>
            <div v-else class="ai-credential-empty">
              <div class="ai-credential-empty__title">
                 {{ providerRows.length ? '没有匹配的凭证' : '还没有 AI 凭证' }} 
              </div>
              <div class="ai-credential-empty__desc">
                 {{ providerRows.length ? '换个关键词再试试' : '点击右上角添加厂商 Key' }} 
              </div>
            </div>
          </div>
          <div v-if="feedbackText" class="ai-credential-list-status" :class="`is-${feedbackTone}`">
            <span v-if="feedbackTone === 'success'" aria-hidden="true" class="icon-[lucide--check]" />
            <span v-else-if="feedbackTone === 'error'" aria-hidden="true" class="icon-[lucide--x]" />
            <span v-else aria-hidden="true" class="icon-[lucide--triangle-alert]" />
            <span>{{ feedbackText }}</span>
          </div>
        </section>

        <section v-else class="ai-credential-pane" aria-label="编辑 AI 凭证">
          <form class="ai-credential-body ai-credential-form" autocomplete="off" novalidate
            @submit.prevent="saveProviderSettings">
            <div class="ai-credential-field">
              <label class="ai-credential-label" for="ai-provider-select">厂商</label>
              <div class="ai-credential-combobox" :class="{ 'is-open': isProviderMenuOpen }">
                <Button id="ai-provider-select" class="ai-credential-combobox-trigger" variant="outline" type="button"
                  data-field="provider" aria-haspopup="listbox" :aria-expanded="isProviderMenuOpen"
                  @click="toggleProviderMenu">
                  <span class="ai-credential-combobox-value">
                    <AiProviderIcon class="ai-credential-select-icon" :platform-id="selectedProviderId" decorative />
                    <span>{{ selectedProvider.label }}</span>
                  </span>
                  <span class="ai-credential-combobox-chev" aria-hidden="true"></span>
                </Button>
                <div v-if="isProviderMenuOpen" class="ai-credential-combobox-menu" role="listbox">
                  <button v-for="provider in AI_SERVICE_PLATFORM_PRESETS" :key="provider.id" type="button"
                    class="ai-credential-combobox-option" :class="{ 'is-selected': provider.id === selectedProviderId }"
                    role="option" :aria-selected="provider.id === selectedProviderId"
                    @click="handleProviderChange(provider.id)">
                    <AiProviderIcon class="ai-credential-select-icon" :platform-id="provider.id" decorative />
                    <span>{{ provider.label }}</span>
                    <span aria-hidden="true" class="icon-[lucide--check]" />
                  </button>
                </div>
              </div>
            </div>

            <div class="ai-credential-field">
              <label class="ai-credential-label" for="ai-credential-alias">
                名称
                <span>同厂商唯一</span>
              </label>
              <Input id="ai-credential-alias" v-model="credentialAlias" class="ai-credential-input" placeholder="默认"
                :aria-invalid="aliasError ? 'true' : 'false'" />
              <p v-if="aliasError" class="ai-credential-field-msg is-error">{{ aliasError }}</p>
            </div>

            <div class="ai-credential-field">
              <label class="ai-credential-label" for="ai-provider-key">
                API Key
                <span>  {{ selectedProviderHasCredentials ? '留空则不修改已保存 Key' : '按厂商保存' }}  </span>
              </label>
              <div class="ai-credential-key-wrap">
                <Input id="ai-provider-key" v-model="providerKey" class="ai-credential-input ai-credential-key-input"
                  :type="isKeyVisible ? 'text' : 'password'" autocomplete="off" spellcheck="false"
                  :placeholder="selectedProviderHasCredentials ? '输入新 Key 后覆盖保存' : '粘贴厂商 API Key'"
                  :aria-invalid="providerKeyError ? 'true' : 'false'" />
                <Button class="ai-credential-key-toggle" variant="ghost" size="icon-sm" type="button"
                  :aria-label="isKeyVisible ? '隐藏 API Key' : '显示 API Key'" @click="isKeyVisible = !isKeyVisible">
                  <span v-if="isKeyVisible" aria-hidden="true" class="icon-[lucide--eye-off]" />
                  <span v-else aria-hidden="true" class="icon-[lucide--eye]" />
                </Button>
              </div>
              <p class="ai-credential-field-msg" :class="{ 'is-error': providerKeyError }">
                 {{ providerKeyError || '本地加密保存，不会上传。' }} 
              </p>
            </div>

            <div class="ai-credential-field">
              <label class="ai-credential-label" for="ai-small-model-select">
                小模型默认模型
                <span>随厂商切换</span>
              </label>
              <div class="ai-credential-combobox" :class="{ 'is-open': isSmallModelMenuOpen }">
                <Button id="ai-small-model-select" class="ai-credential-combobox-trigger" variant="outline"
                  type="button" data-small-model-select aria-haspopup="listbox" :aria-expanded="isSmallModelMenuOpen"
                  @click="toggleSmallModelMenu">
                  <span class="ai-credential-combobox-value">
                    <AiProviderIcon class="ai-credential-select-icon" :platform-id="selectedProviderId" decorative />
                    <span>{{ selectedSmallModel.label }}</span>
                  </span>
                  <span class="ai-credential-combobox-chev" aria-hidden="true"></span>
                </Button>
                <div v-if="isSmallModelMenuOpen" class="ai-credential-combobox-menu" role="listbox">
                  <button v-for="model in selectedProviderModels" :key="model.id" type="button"
                    class="ai-credential-combobox-option" :class="{ 'is-selected': model.id === selectedSmallModel.id }"
                    role="option" :aria-selected="model.id === selectedSmallModel.id"
                    @click="handleSmallModelChange(model.id)">
                    <AiProviderIcon class="ai-credential-select-icon" :platform-id="selectedProviderId" decorative />
                    <span>{{ model.label }}</span>
                    <span aria-hidden="true" class="icon-[lucide--check]" />
                  </button>
                </div>
              </div>
            </div>

            <details class="ai-credential-advanced">
              <summary>
                <span class="ai-credential-advanced__chev" aria-hidden="true"></span>
                高级
              </summary>
              <div class="ai-credential-field">
                <label class="ai-credential-label" for="ai-base-url">
                  Base URL
                  <span>由模型路由管理</span>
                </label>
                <Input id="ai-base-url" class="ai-credential-input" :model-value="selectedProvider.baseUrl"
                  placeholder="使用系统默认路由" disabled />
              </div>
              <div class="ai-credential-field">
                <label class="ai-credential-label" for="tavily-key">
                  信息源 API Key
                  <span>可选</span>
                </label>
                <div class="ai-credential-key-wrap">
                  <Input id="tavily-key" v-model="tavilyKey" class="ai-credential-input ai-credential-key-input"
                    data-tavily-input type="password" autocomplete="off" spellcheck="false" placeholder="Tavily API Key"
                    :aria-invalid="tavilyKeyError ? 'true' : 'false'" />
                  <Button class="ai-credential-inline-save" variant="ghost" size="sm" type="button" data-save-tavily
                    :disabled="isSaving" @click="saveTavily">
                    保存
                  </Button>
                </div>
                <p v-if="tavilyKeyError" class="ai-credential-field-msg is-error">{{ tavilyKeyError }}</p>
              </div>
            </details>
          </form>

          <footer class="ai-credential-foot">
            <Button class="ai-credential-test" variant="outline" size="sm" type="button"
              :disabled="!canTestSelectedProvider" @click="testSelectedProvider">
              <span aria-hidden="true" class="icon-[lucide--zap]" />
              测试
            </Button>
            <div v-if="feedbackText" class="ai-credential-status" :class="`is-${feedbackTone}`">
              <span v-if="feedbackTone === 'success'" aria-hidden="true" class="icon-[lucide--check]" />
              <span v-else-if="feedbackTone === 'error'" aria-hidden="true" class="icon-[lucide--x]" />
              <span v-else aria-hidden="true" class="icon-[lucide--triangle-alert]" />
              <span>{{ feedbackText }}</span>
            </div>
            <div class="ai-credential-spacer"></div>
            <Button variant="outline" size="sm" type="button" @click="openList">
              取消
            </Button>
            <Button size="sm" type="button" :disabled="!canSaveProviderKey" @click="saveProviderSettings">
               {{ isSaving ? '保存中' : '保存' }} 
            </Button>
          </footer>
        </section>
      </section>
    </div>
  </Teleport>
</template>

<style>
.ai-credential-shell {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal, 50);
  display: grid;
  place-items: center;
  padding: var(--spacing-6, 24px);
  background: rgb(15 23 42 / 38%);
}

.ai-credential-dialog {
  --ai-credential-bg: #fafafa;
  --ai-credential-surface: #fff;
  --ai-credential-surface-2: #f6f6f7;
  --ai-credential-line: #ececec;
  --ai-credential-line-strong: #d8d8da;
  --ai-credential-text: #18181b;
  --ai-credential-muted: #71717a;
  --ai-credential-subtle: #a1a1aa;
  --ai-credential-accent: #18181b;
  --ai-credential-accent-fg: #fff;
  --ai-credential-danger: #dc2626;
  --ai-credential-success: #15803d;

  width: min(420px, calc(100vw - 32px));
  height: min(560px, calc(100vh - 32px));
  display: flex;
  overflow: hidden;
  flex-direction: column;
  border: 1px solid var(--ai-credential-line);
  border-radius: var(--radius-xl, 12px);
  background: var(--ai-credential-surface);
  box-shadow: var(--shadow-lg);
  color: var(--ai-credential-text);
}

.ai-credential-dialog button:active {
  transform: none;
}

.ai-credential-head {
  display: flex;
  align-items: center;
  gap: var(--spacing-1-5, 6px);
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--ai-credential-line);
}

.ai-credential-title {
  flex: 1;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}

.ai-credential-head-action {
  height: 26px;
  gap: 4px;
  padding: 0 10px 0 8px;
  border-color: var(--ai-credential-line-strong);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--ai-credential-text);
  font-size: 12px;
}

.ai-credential-head-action svg,
.ai-credential-icon-button svg,
.ai-credential-test svg,
.ai-credential-status svg,
.ai-credential-list-status svg {
  width: 12px;
  height: 12px;
}

.ai-credential-pane {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.ai-credential-search {
  position: relative;
  padding: 12px 16px;
}

.ai-credential-search__icon {
  position: absolute;
  top: 50%;
  left: 26px;
  width: 13px;
  height: 13px;
  color: var(--ai-credential-subtle);
  pointer-events: none;
  transform: translateY(-50%);
}

.ai-credential-search__input {
  height: 32px;
  padding-left: 30px;
  border-color: var(--ai-credential-line);
  border-radius: var(--radius-md);
  background: var(--ai-credential-surface-2);
  font-size: 13px;
}

.ai-credential-body {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  scrollbar-width: none;
}

.ai-credential-body::-webkit-scrollbar,
.ai-credential-combobox-menu::-webkit-scrollbar {
  display: none;
}

.ai-credential-groups {
  display: grid;
  gap: 12px;
  padding: 4px 16px 16px;
}

.ai-credential-group {
  overflow: hidden;
  border: 1px solid var(--ai-credential-line);
  border-radius: 10px;
  background: var(--ai-credential-surface);
}

.ai-credential-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--ai-credential-line);
  background: var(--ai-credential-surface-2);
}

.ai-credential-provider-icon {
  width: 18px;
  height: 18px;
  padding: 1px;
}

.ai-credential-group__name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-size: 12.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-credential-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  column-gap: 10px;
  margin: 4px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  transition: background-color 150ms ease-out;
}

@media (hover: hover) and (pointer: fine) {
  .ai-credential-row:hover {
    background: var(--ai-credential-surface-2);
  }

  .ai-credential-row__acts {
    opacity: 0;
    transition: opacity 150ms ease-out;
  }

  .ai-credential-row:hover .ai-credential-row__acts,
  .ai-credential-row:focus-within .ai-credential-row__acts {
    opacity: 1;
  }
}

.ai-credential-row__main {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.ai-credential-row__name {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.ai-credential-default-mark {
  display: inline-flex;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  color: var(--ai-credential-success);
}

.ai-credential-default-mark__icon {
  width: 14px;
  height: 14px;
}

.ai-credential-row__key {
  overflow: hidden;
  color: var(--ai-credential-subtle);
  font: 11.5px/1.3 ui-monospace, Menlo, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-credential-default-mark__icon svg {
  width: 11px;
  height: 11px;
}

.ai-credential-row__acts {
  display: flex;
  gap: 8px;
}

.ai-credential-icon-button {
  width: 22px;
  height: 22px;
  color: var(--ai-credential-muted);
}

.ai-credential-icon-button:hover {
  color: var(--ai-credential-text);
}

.ai-credential-list-status {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  gap: 6px;
  padding: 0 16px 10px;
  color: var(--ai-credential-muted);
  font-size: 12px;
}

.ai-credential-list-status.is-success {
  color: var(--ai-credential-success);
}

.ai-credential-list-status.is-error {
  color: var(--ai-credential-danger);
}

.ai-credential-list-status span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-credential-empty {
  display: grid;
  height: 100%;
  place-items: center;
  align-content: center;
  gap: 4px;
  padding: 24px;
  color: var(--ai-credential-subtle);
  text-align: center;
}

.ai-credential-empty__title {
  font-size: 13px;
}

.ai-credential-empty__desc {
  color: var(--ai-credential-muted);
  font-size: 12px;
}

.ai-credential-form {
  display: grid;
  gap: 14px;
  padding: 16px;
}

.ai-credential-field {
  display: grid;
  gap: 6px;
}

.ai-credential-label {
  display: flex;
  justify-content: space-between;
  color: var(--ai-credential-muted);
  font-size: 12px;
}

.ai-credential-label span {
  color: var(--ai-credential-subtle);
}

.ai-credential-combobox {
  position: relative;
}

.ai-credential-combobox-trigger,
.ai-credential-input {
  width: 100%;
  height: 34px;
  border: 1px solid var(--ai-credential-line-strong);
  border-color: var(--ai-credential-line-strong);
  border-radius: var(--radius-md);
  background: var(--ai-credential-surface);
  color: var(--ai-credential-text);
  font-size: 13px;
}

.ai-credential-combobox-trigger {
  justify-content: space-between;
  padding: 0 10px;
  box-shadow: none;
}

.ai-credential-combobox-value {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.ai-credential-combobox-value span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-credential-combobox-chev {
  width: 8px;
  height: 8px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  color: var(--ai-credential-muted);
  transform: translateY(-2px) rotate(45deg);
}

.ai-credential-select-icon {
  width: 16px;
  height: 16px;
}

.ai-credential-combobox-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  left: 0;
  z-index: calc(var(--z-modal, 50) + 2);
  max-height: 240px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--ai-credential-line-strong);
  border-radius: var(--radius-lg);
  background: var(--ai-credential-surface);
  box-shadow: 0 8px 24px rgb(0 0 0 / 10%);
  color: var(--ai-credential-text);
  scrollbar-width: none;
}

.ai-credential-combobox-option {
  display: flex;
  width: 100%;
  height: 30px;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ai-credential-text);
  cursor: pointer;
  font-size: 13px;
  text-align: left;
}

.ai-credential-combobox-option:hover,
.ai-credential-combobox-option.is-selected {
  background: var(--ai-credential-surface-2);
}

.ai-credential-combobox-option span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-credential-combobox-option svg:last-child {
  width: 13px;
  height: 13px;
  opacity: 0;
}

.ai-credential-combobox-option.is-selected svg:last-child {
  opacity: 1;
}

.ai-credential-key-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.ai-credential-key-input {
  padding-right: 78px;
  font: 13px/1.4 ui-monospace, Menlo, monospace;
}

.ai-credential-key-toggle {
  position: absolute;
  top: 50%;
  right: 6px;
  width: 24px;
  height: 24px;
  color: var(--ai-credential-muted);
  transform: translateY(-50%);
}

.ai-credential-key-toggle svg {
  width: 14px;
  height: 14px;
}

.ai-credential-inline-save {
  position: absolute;
  top: 50%;
  right: 6px;
  height: 24px;
  padding: 0 8px;
  color: var(--ai-credential-muted);
  font-size: 12px;
  transform: translateY(-50%);
}

.ai-credential-field-msg {
  min-height: 16px;
  margin: 0;
  color: var(--ai-credential-subtle);
  font-size: 12px;
}

.ai-credential-field-msg.is-error {
  color: var(--ai-credential-danger);
}

.ai-credential-advanced {
  padding-top: 10px;
  border-top: 1px dashed var(--ai-credential-line);
}

.ai-credential-advanced summary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ai-credential-muted);
  cursor: pointer;
  font-size: 12px;
  list-style: none;
  user-select: none;
}

.ai-credential-advanced summary::-webkit-details-marker {
  display: none;
}

.ai-credential-advanced__chev {
  width: 6px;
  height: 6px;
  border-top: 1.5px solid currentColor;
  border-right: 1.5px solid currentColor;
  transform: rotate(45deg);
}

.ai-credential-advanced[open] .ai-credential-advanced__chev {
  transform: rotate(135deg);
}

.ai-credential-advanced .ai-credential-field {
  margin-top: 10px;
}

.ai-credential-usage {
  margin: 0;
  color: var(--ai-credential-muted);
  font-size: 12px;
}

.ai-credential-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-top: 1px solid var(--ai-credential-line);
}

.ai-credential-test {
  height: 32px;
  gap: 6px;
  border-color: transparent;
  border-radius: 6px;
  background: var(--ai-credential-surface-2);
  color: var(--ai-credential-muted);
  padding: 0 10px;
  font-size: 13px;
}

.ai-credential-test:hover:not(:disabled) {
  background: #eeeeef;
  color: var(--ai-credential-text);
}

.ai-credential-foot>button:not(.ai-credential-test) {
  height: 32px;
  border-color: transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--ai-credential-text);
  font-size: 13px;
  padding: 0 10px;
}

.ai-credential-foot>button:not(.ai-credential-test):hover:not(:disabled) {
  background: var(--ai-credential-surface-2);
}

.ai-credential-foot>button:not(.ai-credential-test):last-child {
  color: var(--ai-credential-muted);
}

.ai-credential-foot>button:not(.ai-credential-test):last-child:not(:disabled) {
  color: var(--ai-credential-text);
}

.ai-credential-status {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  color: var(--ai-credential-muted);
  font-size: 12px;
}

.ai-credential-status span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-credential-status.is-success {
  color: var(--ai-credential-success);
}

.ai-credential-status.is-error {
  color: var(--ai-credential-danger);
}

.ai-credential-spacer {
  flex: 1;
}
</style>

<script setup lang="ts">
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  Maximize2Icon,
  MousePointerClickIcon,
  PanelRightIcon,
  RefreshCcwIcon,
} from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import {
  WebPreview,
  WebPreviewBody,
  WebPreviewConsole,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
  type IWebPreviewConsoleLog,
} from '@/components/ai-elements/web-preview';

const MAX_CONSOLE_LOGS = 20;

const props = withDefaults(
  defineProps<{
    defaultUrl?: string;
  }>(),
  {
    defaultUrl: '',
  },
);

const emit = defineEmits<{
  'url-change': [url: string];
  'open-external': [url: string];
  'close-sidebar': [];
  select: [url: string];
}>();

const previewUrl = ref(props.defaultUrl);
const refreshKey = ref(0);
const isExpanded = ref(false);
const logs = ref<IWebPreviewConsoleLog[]>([
  {
    level: 'log',
    message: 'Page loaded successfully',
    timestamp: new Date(Date.now() - 10_000),
  },
  {
    level: 'warn',
    message: 'Deprecated API usage detected',
    timestamp: new Date(Date.now() - 5_000),
  },
  {
    level: 'error',
    message: 'Failed to load resource',
    timestamp: new Date(),
  },
]);

watch(
  () => props.defaultUrl,
  (nextUrl) => {
    if (nextUrl !== previewUrl.value) {
      previewUrl.value = nextUrl;
    }
  },
);

const showConsole = computed(() => !isExpanded.value);

const appendLog = (level: IWebPreviewConsoleLog['level'], message: string): void => {
  logs.value = [
    ...logs.value,
    {
      level,
      message,
      timestamp: new Date(),
    },
  ].slice(-MAX_CONSOLE_LOGS);
};

const handleUrlChange = (url: string): void => {
  previewUrl.value = url;
  appendLog('log', `URL changed to: ${url}`);
  emit('url-change', url);
};

const handleNavigationPlaceholder = (action: string): void => {
  appendLog('warn', `${action} is not wired yet`);
};

const handleRefresh = (): void => {
  refreshKey.value += 1;
  appendLog('log', 'Preview reloaded');
};

const handleSelect = (): void => {
  appendLog('log', 'Select mode requested');
  emit('select', previewUrl.value);
};

const handleOpenExternal = (): void => {
  appendLog('log', 'Open in new tab requested');
  emit('open-external', previewUrl.value);
};

const handleToggleExpanded = (): void => {
  isExpanded.value = !isExpanded.value;
  appendLog('log', isExpanded.value ? 'Preview expanded' : 'Preview restored');
};
</script>

<template>
  <section class="ai-web-preview-sidebar" data-testid="ai-web-preview-sidebar">
    <WebPreview class="ai-web-preview-sidebar__preview" :default-url="previewUrl" @url-change="handleUrlChange">
      <WebPreviewNavigation>
        <WebPreviewNavigationButton tooltip="Close sidebar" @click="emit('close-sidebar')">
          <PanelRightIcon class="size-4" />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton tooltip="Go back" @click="handleNavigationPlaceholder('Go back')">
          <ArrowLeftIcon class="size-4" />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton tooltip="Go forward" @click="handleNavigationPlaceholder('Go forward')">
          <ArrowRightIcon class="size-4" />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton tooltip="Reload" @click="handleRefresh">
          <RefreshCcwIcon class="size-4" />
        </WebPreviewNavigationButton>

        <WebPreviewUrl />

        <WebPreviewNavigationButton tooltip="Select" @click="handleSelect">
          <MousePointerClickIcon class="size-4" />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton tooltip="Open in new tab" @click="handleOpenExternal">
          <ExternalLinkIcon class="size-4" />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton
          :tooltip="isExpanded ? 'Restore' : 'Maximize'"
          @click="handleToggleExpanded"
        >
          <Maximize2Icon class="size-4" />
        </WebPreviewNavigationButton>
      </WebPreviewNavigation>

      <WebPreviewBody
        :key="refreshKey"
        class="ai-web-preview-sidebar__body"
        :src="previewUrl"
        title="AI Web preview"
      />

      <WebPreviewConsole v-if="showConsole" :logs="logs" />
    </WebPreview>
  </section>
</template>

<style scoped>
.ai-web-preview-sidebar {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  background: #ffffff;
}

.ai-web-preview-sidebar__preview {
  background: #ffffff;
}

.ai-web-preview-sidebar__body {
  min-height: 0;
  flex: 1;
}
</style>

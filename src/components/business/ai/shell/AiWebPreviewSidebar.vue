<script setup lang="ts">
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  MousePointerClickIcon,
  PanelRightIcon,
  RefreshCcwIcon,
} from '@lucide/vue';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  type IWebPreviewConsoleLog,
  WebPreview,
  WebPreviewBody,
  WebPreviewConsole,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
} from '@/components/ai-elements/web-preview';
import {
  backAgentWebview,
  forwardAgentWebview,
  onAgentWebviewConsole,
  onAgentWebviewNavigated,
  openExternalAgentWebview,
  reloadAgentWebview,
} from '@/services/ipc/agent-webview.service';

const MAX_CONSOLE_LOGS = 200;

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
const canGoBack = ref(false);
const canGoForward = ref(false);
const logs = ref<IWebPreviewConsoleLog[]>([]);

type UnlistenFn = () => void;
let unlistenNavigated: UnlistenFn | null = null;
let unlistenConsole: UnlistenFn | null = null;

watch(
  () => props.defaultUrl,
  (nextUrl) => {
    if (nextUrl !== previewUrl.value) {
      previewUrl.value = nextUrl;
    }
  },
);

const appendLog = (level: IWebPreviewConsoleLog['level'], message: string): void => {
  logs.value = [...logs.value, { level, message, timestamp: new Date() }].slice(-MAX_CONSOLE_LOGS);
};

// CDP 下发的 level 已规范为 log/warn/error；这里做一次防御性收敛。
const mapConsoleLevel = (level: string): IWebPreviewConsoleLog['level'] =>
  level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';

const handleUrlChange = (url: string): void => {
  previewUrl.value = url;
  emit('url-change', url);
};

const handleBack = (): void => {
  void backAgentWebview();
};

const handleForward = (): void => {
  void forwardAgentWebview();
};

const handleRefresh = (): void => {
  void reloadAgentWebview();
};

const handleSelect = (): void => {
  emit('select', previewUrl.value);
};

const handleOpenExternal = (): void => {
  const url = previewUrl.value;
  if (url) {
    void openExternalAgentWebview({ url });
  }
  emit('open-external', url);
};

onMounted(() => {
  void onAgentWebviewNavigated((payload) => {
    previewUrl.value = payload.url;
    canGoBack.value = payload.canGoBack;
    canGoForward.value = payload.canGoForward;
  })
    .then((unlisten) => {
      unlistenNavigated = unlisten;
    })
    .catch(() => {
      // 非桌面运行时(测试/纯前端)无 Tauri 事件总线，忽略订阅失败。
    });

  void onAgentWebviewConsole((payload) => {
    appendLog(mapConsoleLevel(payload.level), payload.message);
  })
    .then((unlisten) => {
      unlistenConsole = unlisten;
    })
    .catch(() => {
      // 同上。
    });
});

onBeforeUnmount(() => {
  unlistenNavigated?.();
  unlistenConsole?.();
});
</script>

<template>
  <section class="ai-web-preview-sidebar" data-testid="ai-web-preview-sidebar">
    <WebPreview class="ai-web-preview-sidebar__preview" :default-url="previewUrl" @url-change="handleUrlChange">
      <WebPreviewNavigation>
        <WebPreviewNavigationButton tooltip="Go back" :disabled="!canGoBack" @click="handleBack">
          <ArrowLeftIcon class="size-4" />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton tooltip="Go forward" :disabled="!canGoForward" @click="handleForward">
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
        <WebPreviewNavigationButton tooltip="Close sidebar" @click="emit('close-sidebar')">
          <PanelRightIcon class="size-4" />
        </WebPreviewNavigationButton>
      </WebPreviewNavigation>

      <WebPreviewBody
        class="ai-web-preview-sidebar__body"
        :src="previewUrl"
        title="AI Web preview"
      />

      <WebPreviewConsole :logs="logs" />
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

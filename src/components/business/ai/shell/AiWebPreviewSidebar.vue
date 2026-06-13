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

// CDP \u4e0b\u53d1\u7684 level \u5df2\u89c4\u8303\u4e3a log/warn/error\uff1b\u8fd9\u91cc\u505a\u4e00\u6b21\u9632\u5fa1\u6027\u6536\u655b\u3002
const mapConsoleLevel = (level: string): IWebPreviewConsoleLog['level'] =>
  level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';

// \u5bfc\u822a\u7c7b\u547d\u4ee4\u5931\u8d25(\u5982 CDP \u4ecd\u5728\u8fde\u63a5)\u65f6\u843d\u5230\u63a7\u5236\u53f0\u9762\u677f\uff0c\u800c\u4e0d\u662f\u5192\u6ce1\u6210\u5168\u5c40\u672a\u5904\u7406\u5f02\u5e38\u3002
const runNavAction = (action: () => Promise<void>): void => {
  action().catch((error: unknown) => {
    appendLog('error', error instanceof Error ? error.message : String(error));
  });
};

const handleUrlChange = (url: string): void => {
  previewUrl.value = url;
  emit('url-change', url);
};

const handleBack = (): void => {
  runNavAction(backAgentWebview);
};

const handleForward = (): void => {
  runNavAction(forwardAgentWebview);
};

const handleRefresh = (): void => {
  runNavAction(reloadAgentWebview);
};

const handleSelect = (): void => {
  emit('select', previewUrl.value);
};

const handleOpenExternal = (): void => {
  const url = previewUrl.value;
  if (url) {
    runNavAction(() => openExternalAgentWebview({ url }));
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
      // \u975e\u684c\u9762\u8fd0\u884c\u65f6(\u6d4b\u8bd5/\u7eaf\u524d\u7aef)\u65e0 Tauri \u4e8b\u4ef6\u603b\u7ebf\uff0c\u5ffd\u7565\u8ba2\u9605\u5931\u8d25\u3002
    });

  void onAgentWebviewConsole((payload) => {
    appendLog(mapConsoleLevel(payload.level), payload.message);
  })
    .then((unlisten) => {
      unlistenConsole = unlisten;
    })
    .catch(() => {
      // \u540c\u4e0a\u3002
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

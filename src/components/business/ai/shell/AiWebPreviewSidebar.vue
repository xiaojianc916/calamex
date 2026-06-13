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
import AiWebPreviewSelectBubble from '@/components/business/ai/shell/AiWebPreviewSelectBubble.vue';
import { useAiWebSelectionInbox } from '@/composables/ai/useAiWebSelectionInbox';
import {
  backAgentWebview,
  cancelSelectAgentWebview,
  forwardAgentWebview,
  onAgentWebviewConsole,
  onAgentWebviewElementPicked,
  onAgentWebviewNavigated,
  openExternalAgentWebview,
  reloadAgentWebview,
  startSelectAgentWebview,
  type TAgentWebviewElementPickedEvent,
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
}>();

const webSelectionInbox = useAiWebSelectionInbox();

const previewUrl = ref(props.defaultUrl);
const canGoBack = ref(false);
const canGoForward = ref(false);
const logs = ref<IWebPreviewConsoleLog[]>([]);
const pickedElement = ref<TAgentWebviewElementPickedEvent | null>(null);
const isSelecting = ref(false);

type UnlistenFn = () => void;
let unlistenNavigated: UnlistenFn | null = null;
let unlistenConsole: UnlistenFn | null = null;
let unlistenElementPicked: UnlistenFn | null = null;

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

// CDP console levels are already normalized to log/warn/error; defensive fallback only.
const mapConsoleLevel = (level: string): IWebPreviewConsoleLog['level'] =>
  level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';

// Navigation command failures (e.g. CDP still connecting) fall back to the console panel
// instead of bubbling up as an unhandled async rejection.
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

// Enter element-picking mode: the native CDP overlay highlights nodes, and the first
// inspected node comes back through onAgentWebviewElementPicked.
const handleSelect = (): void => {
  if (isSelecting.value || pickedElement.value) {
    return;
  }

  isSelecting.value = true;
  startSelectAgentWebview().catch((error: unknown) => {
    isSelecting.value = false;
    appendLog('error', error instanceof Error ? error.message : String(error));
  });
};

// Hand the picked element (plus the user's comment) to the AI assistant via the
// shared selection inbox; the assistant composable turns it into a chat message.
const handleSelectSubmit = (comment: string): void => {
  const picked = pickedElement.value;

  if (!picked) {
    return;
  }

  webSelectionInbox.submitSelection({
    url: picked.url,
    label: picked.label,
    outerHtml: picked.outerHtml,
    screenshotBase64: picked.screenshotBase64,
    comment,
  });
  pickedElement.value = null;
  isSelecting.value = false;
};

const handleSelectCancel = (): void => {
  pickedElement.value = null;
  isSelecting.value = false;
  cancelSelectAgentWebview().catch((error: unknown) => {
    appendLog('error', error instanceof Error ? error.message : String(error));
  });
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
      // No Tauri event bus outside the desktop runtime (tests/web); ignore.
    });

  void onAgentWebviewConsole((payload) => {
    appendLog(mapConsoleLevel(payload.level), payload.message);
  })
    .then((unlisten) => {
      unlistenConsole = unlisten;
    })
    .catch(() => {
      // Same as above.
    });

  void onAgentWebviewElementPicked((payload) => {
    pickedElement.value = payload;
    isSelecting.value = false;
  })
    .then((unlisten) => {
      unlistenElementPicked = unlisten;
    })
    .catch(() => {
      // Same as above.
    });
});

onBeforeUnmount(() => {
  unlistenNavigated?.();
  unlistenConsole?.();
  unlistenElementPicked?.();
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

        <WebPreviewNavigationButton tooltip="Select element" :disabled="isSelecting" @click="handleSelect">
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

    <AiWebPreviewSelectBubble
      v-if="pickedElement"
      class="ai-web-preview-sidebar__bubble"
      :label="pickedElement.label"
      :url="pickedElement.url"
      :outer-html="pickedElement.outerHtml"
      :screenshot-base64="pickedElement.screenshotBase64"
      @submit="handleSelectSubmit"
      @cancel="handleSelectCancel"
    />
  </section>
</template>

<style scoped>
.ai-web-preview-sidebar {
  display: flex;
  position: relative;
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

.ai-web-preview-sidebar__bubble {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 5;
}
</style>

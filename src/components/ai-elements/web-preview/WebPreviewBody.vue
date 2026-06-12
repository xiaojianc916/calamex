<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  AGENT_WEBVIEW_CDP_PORT,
  createAgentWebview,
  destroyAgentWebview,
  navigateAgentWebview,
  setAgentWebviewBounds,
  setAgentWebviewVisible,
} from '@/services/ipc/agent-webview.service';
import { WebPreviewKey } from './context';

const props = withDefaults(
  defineProps<{
    src?: string;
    title?: string;
  }>(),
  {
    src: undefined,
    title: 'Web preview',
  },
);

const preview = inject(WebPreviewKey, null);
const resolvedSrc = computed(() => props.src ?? preview?.currentUrl.value ?? '');

const hostRef = ref<HTMLDivElement | null>(null);

let frameId: number | null = null;
let created = false;
let creating = false;
let lastSrc = '';
let lastBoundsKey = '';

const measure = (): { x: number; y: number; width: number; height: number } | null => {
  const el = hostRef.value;
  if (!el) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
};

const pushBounds = async (): Promise<void> => {
  if (!created) {
    return;
  }
  const bounds = measure();
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return;
  }
  const key = `${bounds.x}|${bounds.y}|${bounds.width}|${bounds.height}`;
  if (key === lastBoundsKey) {
    return;
  }
  lastBoundsKey = key;
  try {
    await setAgentWebviewBounds(bounds);
  } catch {
    // 瞬时同步失败可忽略，下一帧按最新 rect 重试。
    lastBoundsKey = '';
  }
};

const tick = (): void => {
  if (!created) {
    frameId = null;
    return;
  }
  void pushBounds();
  frameId = requestAnimationFrame(tick);
};

const startLoop = (): void => {
  if (frameId === null) {
    frameId = requestAnimationFrame(tick);
  }
};

const stopLoop = (): void => {
  if (frameId !== null) {
    cancelAnimationFrame(frameId);
    frameId = null;
  }
};

const ensureCreated = async (): Promise<void> => {
  if (created || creating) {
    return;
  }
  const bounds = measure();
  if (!bounds) {
    return;
  }
  creating = true;
  try {
    const url = resolvedSrc.value;
    await createAgentWebview({ url, remoteDebuggingPort: AGENT_WEBVIEW_CDP_PORT, ...bounds });
    created = true;
    lastSrc = url;
    lastBoundsKey = `${bounds.x}|${bounds.y}|${bounds.width}|${bounds.height}`;
    startLoop();
  } catch {
    // 原生承载创建失败（如非桌面运行时）：保留空占位，不阻断 UI。
    created = false;
  } finally {
    creating = false;
  }
};

const teardown = async (): Promise<void> => {
  stopLoop();
  if (!created) {
    return;
  }
  created = false;
  lastBoundsKey = '';
  try {
    await destroyAgentWebview();
  } catch {
    // 卸载阶段的销毁失败可忽略。
  }
};

onMounted(() => {
  if (resolvedSrc.value) {
    void ensureCreated();
  }
});

watch(
  resolvedSrc,
  async (next) => {
    if (!next) {
      if (created) {
        stopLoop();
        try {
          await setAgentWebviewVisible({ visible: false });
        } catch {
          // ignore
        }
      }
      return;
    }
    if (!created) {
      await ensureCreated();
      return;
    }
    if (next !== lastSrc) {
      lastSrc = next;
      try {
        await navigateAgentWebview({ url: next });
      } catch {
        // ignore
      }
    }
    try {
      await setAgentWebviewVisible({ visible: true });
    } catch {
      // ignore
    }
    startLoop();
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  void teardown();
});
</script>

<template>
  <section class="ai-web-preview-body" data-slot="web-preview-body">
    <!-- 原生承载：占位元素仅用于测量布局；原生 webview 覆盖在它的屏幕坐标之上 -->
    <div ref="hostRef" class="ai-web-preview-body__host" :aria-label="props.title">
      <div v-if="!resolvedSrc" class="ai-web-preview-body__empty">
        输入地址后即可在这里预览页面
      </div>
    </div>
  </section>
</template>

<style scoped>
.ai-web-preview-body {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  background: #ffffff;
}

.ai-web-preview-body__host {
  position: relative;
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  background: #ffffff;
}

.ai-web-preview-body__empty {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 12px;
  padding: 24px;
  text-align: center;
}
</style>

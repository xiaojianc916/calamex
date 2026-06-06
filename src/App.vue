<script setup lang="ts">
import { onMounted, watch } from 'vue';
import AppDialogHost from '@/components/common/AppDialogHost.vue';
import BrowserContextMenuHost from '@/components/common/BrowserContextMenuHost.vue';
import FatalErrorScreen from '@/components/common/FatalErrorScreen.vue';
import { Toaster } from '@/components/ui/sonner';
import CopilotKitProvider from '@/copilotkit/CopilotKitProvider.vue';
import { useWindowResizeState } from '@/composables/useWindowResizeState';
import { applyWindowStage, setWindowBackground } from '@/services/ipc/window.service';
import { runtimeErrorState } from '@/utils/runtime-diagnostics';
import { markStartup, reportStartupTimings } from '@/utils/startup-profiler';
import 'vue-sonner/style.css';

interface ITauriInternals {
  invoke?: unknown;
}

const SHELL_WINDOW_BACKGROUND = { r: 246, g: 248, b: 250, a: 255 } as const;

let hasAppliedMainWindowStage = false;
let hasSyncedNativeWindowBackground = false;
let isApplyingMainWindowStage = false;

useWindowResizeState();

const canUseNativeWindowIpc = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  const internals = (window as Window & { __TAURI_INTERNALS__?: ITauriInternals })
    .__TAURI_INTERNALS__;
  return typeof internals?.invoke === 'function';
};

const syncNativeWindowBackground = async (): Promise<void> => {
  if (hasSyncedNativeWindowBackground || !canUseNativeWindowIpc()) {
    return;
  }

  try {
    await setWindowBackground(SHELL_WINDOW_BACKGROUND);
    hasSyncedNativeWindowBackground = true;
  } catch (error) {
    console.warn('同步原生窗口底色失败', error);
  }
};

const revealMainWindow = async (): Promise<void> => {
  if (hasAppliedMainWindowStage || isApplyingMainWindowStage) {
    return;
  }

  if (!canUseNativeWindowIpc()) {
    markStartup('window-stage-main-skipped');
    reportStartupTimings();
    return;
  }

  isApplyingMainWindowStage = true;
  markStartup('window-stage-main-start');
  try {
    await syncNativeWindowBackground();
    await applyWindowStage({ stage: 'main' });
    markStartup('window-stage-main-done');
    hasAppliedMainWindowStage = true;
  } catch (error) {
    markStartup('window-stage-main-failed');
    console.error('主窗口显示阶段应用失败', error);
  } finally {
    reportStartupTimings();
    isApplyingMainWindowStage = false;
  }
};

// 首帧绘制后尽早显示窗口：窗口默认 visible:false，用以根除「透明窗口先于 WebView2
// 首帧合成」造成的透明边框闪烁；同时让启动骨架屏第一时间可见，而无需等到工作台
// ready(workbench.initialize 完成)。双 requestAnimationFrame 确保首帧已绘制后再显示。
const scheduleInitialWindowReveal = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      void revealMainWindow();
    });
  });

  // 兜底：当 rAF 长时间不触发(例如窗口/标签页不可见)时，仍保证窗口最终会显示。
  window.setTimeout(() => {
    void revealMainWindow();
  }, 1200);
};

const handleWorkbenchReady = (): void => {
  markStartup('workbench-ready-event');
  void revealMainWindow();
};

watch(
  runtimeErrorState,
  (state) => {
    if (state) {
      void revealMainWindow();
    }
  },
  { flush: 'post' },
);

onMounted(() => {
  void syncNativeWindowBackground();
  scheduleInitialWindowReveal();
});
</script>

<template>
  <div class="app-root-stage">
    <AppDialogHost />
    <BrowserContextMenuHost />
    <Toaster
      position="top-right"
      close-button
      rich-colors
      :duration="6000"
      container-aria-label="应用通知"
    />
    <FatalErrorScreen
      v-if="runtimeErrorState"
      :title="runtimeErrorState.title"
      :message="runtimeErrorState.message"
      :detail="runtimeErrorState.detail"
      :code="runtimeErrorState.code"
      :trace-id="runtimeErrorState.traceId"
    />
    <CopilotKitProvider v-else>
      <router-view v-slot="{ Component: RouteComponent, route: routeRecord }">
        <component :is="RouteComponent" :key="routeRecord.fullPath" @ready="handleWorkbenchReady" />
      </router-view>
    </CopilotKitProvider>
  </div>
</template>

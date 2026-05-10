<script setup lang="ts">
import AppDialogHost from '@/components/common/AppDialogHost.vue';
import BrowserContextMenuHost from '@/components/common/BrowserContextMenuHost.vue';
import FatalErrorScreen from '@/components/common/FatalErrorScreen.vue';
import { Toaster } from '@/components/ui/sonner';
import { applyWindowStage } from '@/services/modules/window';
import { runtimeErrorState } from '@/utils/runtime-diagnostics';
import { markStartup, reportStartupTimings } from '@/utils/startup-profiler';
import { watch } from 'vue';
import 'vue-sonner/style.css';

interface ITauriInternals {
  invoke?: unknown;
}

let hasAppliedMainWindowStage = false;
let isApplyingMainWindowStage = false;

const canApplyNativeWindowStage = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  const internals = (window as Window & { __TAURI_INTERNALS__?: ITauriInternals })
    .__TAURI_INTERNALS__;
  return typeof internals?.invoke === 'function';
};

const revealMainWindow = async (): Promise<void> => {
  if (hasAppliedMainWindowStage || isApplyingMainWindowStage) {
    return;
  }

  if (!canApplyNativeWindowStage()) {
    markStartup('window-stage-main-skipped');
    reportStartupTimings();
    return;
  }

  isApplyingMainWindowStage = true;
  markStartup('window-stage-main-start');
  try {
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
    <router-view v-else v-slot="{ Component: RouteComponent, route: routeRecord }">
      <component :is="RouteComponent" :key="routeRecord.fullPath" @ready="handleWorkbenchReady" />
    </router-view>
  </div>
</template>

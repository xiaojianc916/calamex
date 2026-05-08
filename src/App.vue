<script setup lang="ts">
import AppDialogHost from '@/components/common/AppDialogHost.vue';
import BrowserContextMenuHost from '@/components/common/BrowserContextMenuHost.vue';
import { applyWindowStage } from '@/services/modules/window';
import { runtimeErrorState } from '@/utils/runtime-diagnostics';
import { markStartup, reportStartupTimings } from '@/utils/startup-profiler';
import { watch } from 'vue';

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
    <section v-if="runtimeErrorState" class="app-runtime-error" role="alert" aria-live="assertive">
      <div class="app-runtime-error__panel">
        <h1 class="app-runtime-error__title">{{ runtimeErrorState.title }}</h1>
        <p class="app-runtime-error__message">{{ runtimeErrorState.message }}</p>
        <pre class="app-runtime-error__detail">{{ runtimeErrorState.detail }}</pre>
      </div>
    </section>
    <router-view v-else v-slot="{ Component: RouteComponent, route: routeRecord }">
      <component :is="RouteComponent" :key="routeRecord.fullPath" @ready="handleWorkbenchReady" />
    </router-view>
  </div>
</template>

<style>
.app-runtime-error {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg-0);
}

.app-runtime-error__panel {
  width: min(780px, 100%);
  border: 1px solid rgba(255, 107, 122, 0.28);
  border-radius: 12px;
  background: var(--bg-1);
  padding: 20px 24px;
  box-shadow: 0 24px 72px rgba(0, 0, 0, 0.36);
}

.app-runtime-error__title {
  margin: 0 0 12px;
  color: #ff9aa5;
  font-size: 18px;
}

.app-runtime-error__message {
  margin: 0 0 12px;
  color: #e5e7eb;
  font-size: 14px;
}

.app-runtime-error__detail {
  margin: 0;
  color: #cbd5e1;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.7;
}
</style>

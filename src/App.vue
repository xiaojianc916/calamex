<template>
  <div data-testid="app-root-stage" class="app-root-stage" :class="{ 'is-splash-mode': isWindowSplashMode }">
    <AppDialogHost />
    <div v-if="isStartupVeilVisible" data-testid="startup-veil" class="startup-veil"
      :class="{ 'is-leaving': isStartupVeilLeaving }" />
    <div v-if="isContentMounted && workbenchComponent && !runtimeErrorState" data-testid="app-content-entry"
      class="app-content-entry" :class="{ 'is-visible': isAppContentVisible }">
      <component :is="workbenchComponent" @ready="handleWorkbenchReady" />
    </div>
    <SplashScreen v-if="isSplashVisible" :ready="isApplicationReady" :error="runtimeErrorState"
      @leave-start="handleSplashLeaveStart" @after-leave="handleSplashAfterLeave" />
  </div>
</template>

<script setup lang="ts">
import AppDialogHost from '@/components/common/AppDialogHost.vue';
import SplashScreen from '@/components/common/SplashScreen.vue';
import { runtimeErrorState, setRuntimeError } from '@/utils/runtime-diagnostics';
import type { Component } from 'vue';
import {
  computed,
  markRaw,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue';

const MAIN_WINDOW_SIZE = { width: 1500, height: 960 } as const;
const MAIN_WINDOW_MIN_SIZE = { width: 1220, height: 760 } as const;
const MAIN_CONTENT_REVEAL_DELAY_MS = 50;
const STARTUP_VEIL_FADE_DURATION_MS = 140;
const SPLASH_MODE_CLASS = 'splash-window-mode';

const isSplashMounted = ref(true);
const isContentMounted = ref(false);
const isAppContentVisible = ref(false);
const isStartupVeilVisible = ref(false);
const isStartupVeilLeaving = ref(false);
const isWorkbenchModuleReady = ref(false);
const isWorkbenchViewReady = ref(false);
const workbenchComponent = shallowRef<Component | null>(null);
const isWindowSplashMode = ref(true);
let isMainWindowPrepared = false;

let prepareMainWindowPromise: Promise<void> | null = null;
let revealDelayTimerId: number | null = null;
let startupVeilTimerId: number | null = null;
let revealFlowVersion = 0;

// ---------- Tauri window helpers ----------

const applyNativeWindowStage = async (stage: 'splash' | 'main'): Promise<boolean> => {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('apply_window_stage', { stage });
    return true;
  } catch (error) {
    console.warn(`切换窗口阶段失败：${stage}`, error);
    return false;
  }
};

const applyMainWindowFrameFallback = async (): Promise<void> => {
  const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
    import('@tauri-apps/api/window'),
    import('@tauri-apps/api/dpi'),
  ]);
  const appWindow = getCurrentWindow();
  await appWindow.setResizable(true);
  await appWindow.setSize(new LogicalSize(MAIN_WINDOW_SIZE.width, MAIN_WINDOW_SIZE.height));
  await appWindow.setMinSize(
    new LogicalSize(MAIN_WINDOW_MIN_SIZE.width, MAIN_WINDOW_MIN_SIZE.height),
  );
  await appWindow.center();
  await appWindow.setFocus();
};

const applyMainWindowFrame = async (): Promise<void> => {
  try {
    if (await applyNativeWindowStage('main')) {
      return;
    }
    // Rust 端 apply_window_stage 不可用时的纯前端回退（可能缺少装饰/置顶等副作用处理）
    await applyMainWindowFrameFallback();
  } catch (error) {
    console.warn('恢复主窗口尺寸失败', error);
  }
};

// ---------- Lifecycle flow ----------

const loadWorkbenchModule = async (): Promise<void> => {
  isWorkbenchModuleReady.value = false;
  isWorkbenchViewReady.value = false;
  workbenchComponent.value = null;
  try {
    const module = await import('@/views/ShellWorkbenchView.vue');
    workbenchComponent.value = markRaw(module.default);
    isContentMounted.value = true;
  } catch (error) {
    setRuntimeError('工作台模块加载失败', error);
  } finally {
    isWorkbenchModuleReady.value = true;
  }
};

const isApplicationReady = computed(
  () =>
    !runtimeErrorState.value &&
    isWorkbenchModuleReady.value &&
    isWorkbenchViewReady.value &&
    Boolean(workbenchComponent.value),
);

const isSplashVisible = computed(
  () => isSplashMounted.value || Boolean(runtimeErrorState.value),
);

const setDocumentSplashMode = (enabled: boolean): void => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const body = document.body;
  if (root) root.classList.toggle(SPLASH_MODE_CLASS, enabled);
  if (body) body.classList.toggle(SPLASH_MODE_CLASS, enabled);
};

const clearRevealDelayTimer = (): void => {
  if (revealDelayTimerId !== null) {
    window.clearTimeout(revealDelayTimerId);
    revealDelayTimerId = null;
  }
};

const clearStartupVeilTimer = (): void => {
  if (startupVeilTimerId !== null) {
    window.clearTimeout(startupVeilTimerId);
    startupVeilTimerId = null;
  }
};

const waitForMainRevealDelay = (): Promise<void> =>
  new Promise((resolve) => {
    clearRevealDelayTimer();
    revealDelayTimerId = window.setTimeout(() => {
      revealDelayTimerId = null;
      resolve();
    }, MAIN_CONTENT_REVEAL_DELAY_MS);
  });

const waitForStablePaint = (): Promise<void> =>
  new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });

const prepareMainWindow = async (): Promise<void> => {
  if (runtimeErrorState.value) {
    return;
  }
  if (isMainWindowPrepared) {
    return;
  }
  if (prepareMainWindowPromise) {
    await prepareMainWindowPromise;
    return;
  }

  const currentRevealFlowVersion = revealFlowVersion;

  prepareMainWindowPromise = (async () => {
    if (!isContentMounted.value && workbenchComponent.value) {
      isContentMounted.value = true;
      await nextTick();
    }

    if (runtimeErrorState.value || currentRevealFlowVersion !== revealFlowVersion) {
      return;
    }

    await nextTick();
    await waitForStablePaint();

    if (runtimeErrorState.value || currentRevealFlowVersion !== revealFlowVersion) {
      return;
    }

    isMainWindowPrepared = true;
  })().finally(() => {
    prepareMainWindowPromise = null;
  });

  await prepareMainWindowPromise;
};

const revealPreparedMainWindow = async (): Promise<void> => {
  if (runtimeErrorState.value) {
    return;
  }

  const currentRevealFlowVersion = revealFlowVersion;

  await prepareMainWindow();

  if (runtimeErrorState.value || currentRevealFlowVersion !== revealFlowVersion) {
    return;
  }

  isStartupVeilVisible.value = true;
  isStartupVeilLeaving.value = false;
  isWindowSplashMode.value = false;
  setDocumentSplashMode(false);

  await Promise.all([applyMainWindowFrame(), waitForMainRevealDelay()]);

  if (runtimeErrorState.value || currentRevealFlowVersion !== revealFlowVersion) {
    return;
  }

  await nextTick();
  await waitForStablePaint();

  if (runtimeErrorState.value || currentRevealFlowVersion !== revealFlowVersion) {
    return;
  }

  isAppContentVisible.value = true;

  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      isStartupVeilLeaving.value = true;
      clearStartupVeilTimer();
      startupVeilTimerId = window.setTimeout(() => {
        startupVeilTimerId = null;
        isStartupVeilVisible.value = false;
        isStartupVeilLeaving.value = false;
        resolve();
      }, STARTUP_VEIL_FADE_DURATION_MS);
    });
  });
};

// ---------- Event handlers ----------

const handleSplashLeaveStart = (): void => {
  void prepareMainWindow();
};

const handleSplashAfterLeave = async (): Promise<void> => {
  if (runtimeErrorState.value) {
    return;
  }

  await prepareMainWindow();
  isSplashMounted.value = false;
  await revealPreparedMainWindow();
};

const handleWorkbenchReady = (): void => {
  isWorkbenchViewReady.value = true;
};

// ---------- Watchers ----------

watch(isApplicationReady, (ready: boolean) => {
  if (!ready || runtimeErrorState.value || !isSplashMounted.value) {
    return;
  }

  void prepareMainWindow();
});

watch(runtimeErrorState, (error: unknown, previousError: unknown) => {
  if (error) {
    // 进入错误态：回到 splash，并丢弃当前加载流水线
    revealFlowVersion += 1;
    prepareMainWindowPromise = null;
    isMainWindowPrepared = false;
    clearRevealDelayTimer();
    clearStartupVeilTimer();
    isWindowSplashMode.value = true;
    setDocumentSplashMode(true);
    isSplashMounted.value = true;
    isContentMounted.value = false;
    isAppContentVisible.value = false;
    isStartupVeilVisible.value = false;
    isStartupVeilLeaving.value = false;
    isWorkbenchViewReady.value = false;
    return;
  }

  // 从错误态恢复：重新加载 workbench 模块
  if (previousError) {
    void loadWorkbenchModule();
  }
});

watch(isWindowSplashMode, (visible: boolean) => setDocumentSplashMode(visible), { immediate: true });

// ---------- Mount / Unmount ----------

onMounted(() => {
  void loadWorkbenchModule();
});

onBeforeUnmount(() => {
  clearRevealDelayTimer();
  clearStartupVeilTimer();
  setDocumentSplashMode(false);
});
</script>
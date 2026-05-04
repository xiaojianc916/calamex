<script setup lang="ts">
import startupWelcomeSvgRaw from '@/assets/svg/welcome-isometric.svg?raw';
import AppDialogHost from '@/components/common/AppDialogHost.vue';
import BrowserContextMenuHost from '@/components/common/BrowserContextMenuHost.vue';
import { getCurrentAppWindowLabel, WELCOME_WINDOW_LABEL } from '@/utils/app-window';
import { runtimeErrorState } from '@/utils/runtime-diagnostics';
import { WORKBENCH_READY_EVENT } from '@/utils/startup-ready';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const STARTUP_VEIL_FADE_DURATION_MS = 180;
const STARTUP_WELCOME_EPOCH_STORAGE_KEY = 'sh.startup.welcomeEpochMs';
const currentWindowLabel = getCurrentAppWindowLabel();

const isWelcomeWindow = computed(() => currentWindowLabel === WELCOME_WINDOW_LABEL);
const isStartupVeilVisible = ref(!isWelcomeWindow.value);
const isStartupVeilLeaving = ref(false);
const hasStartedStartupTransition = ref(false);
const hasFinalizedStartupTransition = ref(false);
const startupBridgeWrapRef = ref<HTMLElement | null>(null);

let startupVeilTimerId: number | null = null;

const getStartupBridgeSvgElement = (): SVGSVGElement | null => {
  const element = startupBridgeWrapRef.value?.querySelector('svg') ?? null;
  if (!element) {
    return null;
  }

  if (typeof SVGSVGElement !== 'undefined' && element instanceof SVGSVGElement) {
    return element;
  }

  return element as SVGSVGElement;
};

const pauseStartupBridgeAnimations = (): void => {
  getStartupBridgeSvgElement()?.pauseAnimations();
};

const syncStartupBridgeTimeline = (): void => {
  const svgElement = getStartupBridgeSvgElement();
  if (!svgElement) {
    return;
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    svgElement.pauseAnimations();
    return;
  }

  let elapsedSeconds = 0;
  try {
    const epochValue = window.localStorage.getItem(STARTUP_WELCOME_EPOCH_STORAGE_KEY);
    const epochMs = Number(epochValue);
    if (Number.isFinite(epochMs) && epochMs > 0) {
      elapsedSeconds = Math.max(0, (Date.now() - epochMs) / 1_000);
    }
  } catch {
    elapsedSeconds = 0;
  }

  if (elapsedSeconds > 0) {
    svgElement.setCurrentTime(elapsedSeconds);
  }
};

const primeStartupBridge = async (): Promise<void> => {
  if (isWelcomeWindow.value || !isStartupVeilVisible.value) {
    return;
  }

  await nextTick();
  syncStartupBridgeTimeline();
};

const clearStartupVeilTimer = (): void => {
  if (startupVeilTimerId !== null) {
    window.clearTimeout(startupVeilTimerId);
    startupVeilTimerId = null;
  }
};

const finalizeWelcomeWindowDisposal = async (): Promise<void> => {
  if (isWelcomeWindow.value || hasFinalizedStartupTransition.value) {
    return;
  }

  hasFinalizedStartupTransition.value = true;
};

const hideStartupVeil = (): void => {
  clearStartupVeilTimer();
  pauseStartupBridgeAnimations();
  isStartupVeilVisible.value = false;
  isStartupVeilLeaving.value = false;

  try {
    window.localStorage.removeItem(STARTUP_WELCOME_EPOCH_STORAGE_KEY);
  } catch {
    // ignore storage cleanup failures
  }

  void finalizeWelcomeWindowDisposal();
};

const startStartupVeilLeave = (): void => {
  if (!isStartupVeilVisible.value) {
    return;
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    hideStartupVeil();
    return;
  }

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      isStartupVeilLeaving.value = true;
      clearStartupVeilTimer();
      startupVeilTimerId = window.setTimeout(() => {
        hideStartupVeil();
      }, STARTUP_VEIL_FADE_DURATION_MS);
    });
  });
};

const revealMainWindow = async (): Promise<void> => {
  if (isWelcomeWindow.value || hasStartedStartupTransition.value) {
    return;
  }

  hasStartedStartupTransition.value = true;
  startStartupVeilLeave();
};

const handleWindowWorkbenchReady = (): void => {
  void revealMainWindow();
};

if (!isWelcomeWindow.value && typeof window !== 'undefined') {
  window.addEventListener(WORKBENCH_READY_EVENT, handleWindowWorkbenchReady);
}

watch(runtimeErrorState, (error) => {
  if (!error || isWelcomeWindow.value) {
    return;
  }

  void revealMainWindow();
});

onMounted(() => {
  void primeStartupBridge();
});

onBeforeUnmount(() => {
  if (!isWelcomeWindow.value && typeof window !== 'undefined') {
    window.removeEventListener(WORKBENCH_READY_EVENT, handleWindowWorkbenchReady);
  }

  clearStartupVeilTimer();
  pauseStartupBridgeAnimations();
});
</script>

<template>
  <div class="app-root-stage" :class="{ 'is-welcome-window': isWelcomeWindow }">
    <AppDialogHost v-if="!isWelcomeWindow" />
    <BrowserContextMenuHost v-if="!isWelcomeWindow" />
    <div
v-if="isStartupVeilVisible && !isWelcomeWindow" data-testid="startup-veil" class="startup-veil"
      :class="{ 'is-leaving': isStartupVeilLeaving }">
      <!-- eslint-disable vue/no-v-html -->
      <div ref="startupBridgeWrapRef" class="startup-veil__welcome-bridge" v-html="startupWelcomeSvgRaw" />
      <!-- eslint-enable vue/no-v-html -->
    </div>
    <section v-if="runtimeErrorState" class="app-runtime-error" role="alert" aria-live="assertive">
      <div class="app-runtime-error__panel">
        <h1 class="app-runtime-error__title">{{ runtimeErrorState.title }}</h1>
        <p class="app-runtime-error__message">{{ runtimeErrorState.message }}</p>
        <pre class="app-runtime-error__detail">{{ runtimeErrorState.detail }}</pre>
      </div>
    </section>
    <router-view v-else v-slot="{ Component: RouteComponent, route: routeRecord }">
      <component :is="RouteComponent" :key="routeRecord.fullPath" @ready="revealMainWindow" />
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

.startup-veil {
  position: fixed;
  inset: 0;
  z-index: 9998;
  pointer-events: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  opacity: 1;
  transition: opacity 180ms cubic-bezier(0.22, 1, 0.36, 1);
}

.startup-veil.is-leaving {
  opacity: 0;
}

.startup-veil__welcome-bridge {
  width: min(1024px, 100vw);
  height: min(680px, 100vh);
  max-width: 100vw;
  max-height: 100vh;
  contain: strict;
  will-change: opacity, transform;
}

.startup-veil__welcome-bridge svg {
  display: block;
  width: 100%;
  height: 100%;
  text-rendering: geometricPrecision;
}

.startup-veil__welcome-bridge text {
  text-rendering: geometricPrecision;
}

@media (prefers-reduced-motion: reduce) {
  .startup-veil {
    transition: none;
  }
}
</style>

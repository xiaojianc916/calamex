<script setup lang="ts">
import { defineAsyncComponent, onMounted, watch } from 'vue';
import AppDialogHost from '@/components/common/AppDialogHost.vue';
import BrowserContextMenuHost from '@/components/common/BrowserContextMenuHost.vue';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useWindowResizeState } from '@/composables/useWindowResizeState';
import { applyWindowStage, setWindowBackground } from '@/services/ipc/window.service';
import { runtimeErrorState } from '@/utils/platform/runtime-diagnostics';
import { markStartup, reportStartupTimings } from '@/utils/platform/startup-profiler';
import 'vue-sonner/style.css';

interface ITauriInternals {
  invoke?: unknown;
}

// 致命错误界面受 runtimeErrorState 控制,仅在出错时挂载;异步加载让它(及其 lucide
// 图标、ErrorDetails、Button 等依赖)退出首屏 chunk。出错本就罕见,异步加载的延迟可接受。
const FatalErrorScreen = defineAsyncComponent(
  () => import('@/components/common/FatalErrorScreen.vue'),
);

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
    await setWindowBackground({ r: 250, g: 250, b: 250, a: 255 });
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
// 首帧合成」造成的透明边框闪烁；双 requestAnimationFrame 确保首帧已绘制后再显示。
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
  <TooltipProvider :delay-duration="700" :disable-hoverable-content="true">
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
      <!--
        工作台(router-view)始终挂载,绝不再被错误态卸载。
        历史缺陷:此前用 v-if=runtimeErrorState / v-else=router-view 在出错时整棵替换工作台。
        一旦置错误态,Vue 会同步 scope.stop() 掉 RouterView + ShellWorkbenchView 整棵子树;
        由于拆卸发生在活树上、且会与异步 FatalErrorScreen 竞态/重入,可能拆到一半卡住:
        组件作用域已停(scope.active=false、render effect 失活),但 DOM 仍挂在屏幕上、
        isUnmounted 仍为 false、错误页也没真正挂出——形成一具「僵尸工作台」:响应式状态在变
        (activeSidebarView 已切换)但 DOM 永不重渲染,于是点击全部落在死 DOM 上(侧边栏不切换、
        编辑器空白、标题栏 GitHub 登录点不动),而窗口仍可拖动缩放、AI 面板(detached 子作用域)仍可点。
        修复:工作台永远挂载,错误页改为全屏覆盖层呈现,从根上消除该僵尸态(无论由哪条错误触发)。
      -->
      <router-view v-slot="{ Component: RouteComponent, route: routeRecord }">
        <component :is="RouteComponent" :key="routeRecord.fullPath" @ready="handleWorkbenchReady" />
      </router-view>
      <div
        v-if="runtimeErrorState"
        class="app-fatal-error-overlay"
        style="position: fixed; inset: 0; z-index: 2147483646; background: #fafafa"
      >
        <FatalErrorScreen
          :title="runtimeErrorState.title"
          :message="runtimeErrorState.message"
          :detail="runtimeErrorState.detail"
          :code="runtimeErrorState.code"
          :trace-id="runtimeErrorState.traceId"
        />
      </div>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue';
import AppDialogHost from '@/components/common/AppDialogHost.vue';
import BrowserContextMenuHost from '@/components/common/BrowserContextMenuHost.vue';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useWindowResizeState } from '@/composables/useWindowResizeState';
import { runtimeErrorState } from '@/utils/platform/runtime-diagnostics';
import { markStartup, reportStartupTimings } from '@/utils/platform/startup-profiler';
import 'vue-sonner/style.css';

// 致命错误界面受 runtimeErrorState 控制,仅在出错时挂载;异步加载让它(及其 lucide
// 图标、ErrorDetails、Button 等依赖)退出首屏 chunk。出错本就罕见,异步加载的延迟可接受。
const FatalErrorScreen = defineAsyncComponent(
  () => import('@/components/common/FatalErrorScreen.vue'),
);

useWindowResizeState();

// 窗口显示已彻底移出前端：窗口默认 visible:false，由 Rust 在 setup 阶段建窗后立即 show()
// （见 src-tauri/src/main.rs 的 native-reveal），真实壳 chrome 随 Vue 挂载作为第一个内容帧
// 无缝接管。此处不再做任何窗口 reveal 编排 / 原生底色同步 / rAF 兜底 —— 那套「隐藏态等前端
// reveal」正是旧首帧卡顿与白屏的根源。仅保留壳就绪埋点，用于度量真实 UI 首帧时点。
const handleWorkbenchReady = (): void => {
  markStartup('workbench-ready-event');
  reportStartupTimings();
};
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

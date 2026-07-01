#!/usr/bin/env node
// apply-r1-native-instant-window.mjs  (v3: #fafafa 不变 / 默认 light / 只删骨架 + Rust 即显)
//
// R1 最小地基重构：Rust 在 setup 阶段直接以现有 #fafafa 建窗即显 + 删除假骨架 + 删前端 reveal 编排。
// 不改颜色、不改默认主题、不动 manager.ts。CRLF/LF 自适应，可重复运行。
//
// 用法：  node apply-r1-native-instant-window.mjs
//   或：  node apply-r1-native-instant-window.mjs "D:\com.xiaojianc\my_desktop_app"

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();

const REQUIRED = ['index.html', 'src-tauri/src/main.rs', 'src/app/App.vue'];
for (const rel of REQUIRED) {
  if (!existsSync(join(ROOT, rel))) {
    console.error(`✗ 找不到 ${rel}；请在 calamex 仓库根目录运行，或传入仓库根路径。`);
    process.exit(1);
  }
}

// 以未改动的 main.rs 探测仓库换行风格，统一写回，避免 EOL 抖动。
const repoEol = readFileSync(join(ROOT, 'src-tauri/src/main.rs'), 'utf8').includes('\r\n')
  ? '\r\n'
  : '\n';
const toRepoEol = (s) => s.replace(/\r\n/g, '\n').replace(/\n/g, repoEol);
console.log(`换行风格：${repoEol === '\r\n' ? 'CRLF' : 'LF'}`);

let touched = 0;

function overwrite(rel, contentLf) {
  const abs = join(ROOT, rel);
  const content = toRepoEol(contentLf);
  if (readFileSync(abs, 'utf8') === content) {
    console.log(`  • [跳过] ${rel}：已是目标内容`);
    return;
  }
  writeFileSync(abs, content, 'utf8');
  touched++;
  console.log(`  ✓ [重写] ${rel}`);
}

function replaceOnce(text, { find, replace, label, marker }) {
  const count = text.split(find).length - 1;
  if (count === 1) return { text: text.replace(find, replace), applied: true };
  if (count === 0) {
    if (marker && text.includes(marker)) {
      console.log(`      · [跳过] ${label}：已是新版`);
      return { text, applied: false };
    }
    throw new Error(`✗ 未找到锚点「${label}」。文件可能已被改动，请核对版本。`);
  }
  throw new Error(`✗ 锚点「${label}」出现 ${count} 次，拒绝歧义替换。`);
}

function patch(rel, edits) {
  const abs = join(ROOT, rel);
  let text = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  let anyApplied = false;
  console.log(`  → ${rel}`);
  for (const edit of edits) {
    const { text: next, applied } = replaceOnce(text, edit);
    text = next;
    if (applied) {
      anyApplied = true;
      console.log(`      ✓ ${edit.label}`);
    }
  }
  if (anyApplied) {
    writeFileSync(abs, toRepoEol(text), 'utf8');
    touched++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) index.html —— 仅删除假骨架，其余（#fafafa、light、埋点）原样保留
// ─────────────────────────────────────────────────────────────────────────────
const NEW_INDEX_HTML = `<!doctype html>
<html lang="zh-CN" class="light" data-theme="light">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <title>Calamex</title>
  <style>
    /* 基础重置：窗口默认 visible:false，由 Rust 在 setup 阶段建窗后立即显示（见 main.rs）；
     * 此处铺与原生窗口一致的 #fafafa 底色与布局，杜绝首帧白屏。
     * 最终背景由 styles.css 统一接管。不画任何假骨架——真实 UI 由 Vue 壳挂载后作为首帧渲染。 */
    html,
    body,
    #app {
      position: fixed;
      inset: 0;
      min-height: 100vh;
      margin: 0;
      background-color: #fafafa;
      color: #1f2328;
      font-family:
        'Inter', 'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI',
        'Microsoft YaHei', sans-serif;
    }

    body {
      overflow: hidden;
    }
  </style>
  <script>
    (function () {
      // 仅保留启动埋点（HTML 主题预设段）
      try { performance.mark('calamex:startup:index-theme-start'); } catch (_) { }
      try { performance.mark('calamex:startup:index-theme-ready'); } catch (_) { }
    })();
  </script>
</head>

<body>
  <div id="app"></div>
  <script type="module" src="/src/app/main.ts"></script>
</body>

</html>
`;

// ─────────────────────────────────────────────────────────────────────────────
// 2) src/app/App.vue —— 删 reveal 编排 / 原生底色同步 / rAF 兜底，仅保留壳就绪埋点
// ─────────────────────────────────────────────────────────────────────────────
const NEW_APP_VUE = `<script setup lang="ts">
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
`;

// ─────────────────────────────────────────────────────────────────────────────
// 3) src-tauri/src/main.rs —— 删 2.5s 兜底轮询线程；改为 setup 内 #fafafa 建窗即显
// ─────────────────────────────────────────────────────────────────────────────
const RS_OLD_COMMENT = `    // 本工程窗口正是 visible:false 延迟显示（见下方 setup 内 fallback-reveal 注释，
    // 作者已记录 WebView2 在不可见窗口下挂起渲染/计时），最易触发该误判。`;

const RS_NEW_COMMENT = `    // 本工程窗口正是 visible:false、由 Rust 在 setup 内建窗后立即 show()（见下方 setup 内
    // native-reveal 注释，作者已记录 WebView2 在不可见窗口下挂起渲染/计时），最易触发该误判。`;

const RS_OLD_FALLBACK_BLOCK = `            // 兜底显示：窗口配置 visible:false，正常路径由前端 App.vue 挂载后调用
            // apply_window_stage 显示窗口。但若前端在隐藏态停滞（如 WebView2 在不可见
            // 窗口下挂起渲染/计时，导致 reveal 始终不执行），窗口会永远滞留系统托盘、
            // 从托盘强制打开则是白屏。此处兜底：约 2.5s 后若主窗口仍不可见，则由 Rust
            // 主动显示，打破“Rust 等前端、前端隐藏态又跑不动”的死锁。show 幂等，前端
            // 正常路径提前显示时此处自动跳过。
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    let Some(window) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) else {
                        return;
                    };
                    if window.is_visible().unwrap_or(false) {
                        return;
                    };
                    tracing::warn!(
                        scope = "startup",
                        event = "tauri.window.fallback-reveal",
                        "main window still hidden ~2500ms after setup; revealing from native side"
                    );
                    // 兜底前先把原生底色同步为应用底色(#fafafa)，尽量减小首帧纯白。
                    let _ =
                        window.set_background_color(Some(tauri::window::Color(250, 250, 250, 255)));
                    let _ = window.show();
                    let _ = window.set_focus();
                });
            }`;

const RS_NEW_REVEAL_BLOCK = `            // 原生秒显（对齐 VS Code / Zed / Electron backgroundColor 范式）：窗口配置
            // visible:false，由 Rust 在 setup 阶段直接把原生底色设为应用底色 #fafafa 后立即
            // show()——首帧即一块纯色原生窗口，不依赖前端跑到哪一步、也绝不画任何假骨架。真实
            // UI 壳由 Vue 挂载后作为第一个内容帧无缝接管。这样彻底移除了旧「Rust 等前端 reveal、
            // 前端隐藏态又跑不动」的死锁与 2.5s 兜底轮询。
            timed_step!("tauri.setup.window-revealed", app_started_at, {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ =
                        window.set_background_color(Some(tauri::window::Color(250, 250, 250, 255)));
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });`;

// ─────────────────────────────────────────────────────────────────────────────
// 执行
// ─────────────────────────────────────────────────────────────────────────────
console.log(`R1 · 原生 #fafafa 秒显 + 真实壳首帧（默认浅色，颜色不变）\n仓库根：${ROOT}\n`);

overwrite('index.html', NEW_INDEX_HTML);
overwrite('src/app/App.vue', NEW_APP_VUE);

patch('src-tauri/src/main.rs', [
  {
    label: '更新 occlusion 注释中的 reveal 引用',
    find: RS_OLD_COMMENT,
    replace: RS_NEW_COMMENT,
    marker: 'native-reveal 注释',
  },
  {
    label: '删除 2.5s 兜底轮询线程，改为 setup 内 #fafafa 建窗即显',
    find: RS_OLD_FALLBACK_BLOCK,
    replace: RS_NEW_REVEAL_BLOCK,
    marker: 'tauri.setup.window-revealed',
  },
]);

console.log(`\n完成。改动文件数：${touched}`);
console.log(
  `\n请自检：\n  pnpm typecheck && pnpm lint && pnpm test\n  cd src-tauri && cargo clippy --all-targets && cargo fmt --check\n\n验收：冷启动瞬间即出现 #fafafa 纯色原生窗口，无白屏、无假骨架；真实壳作为第一个内容帧接管。`,
);
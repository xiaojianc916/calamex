# ADR-0008：启用最小路由壳（vue-router active）

- **状态（Status）**: Accepted
- **登记日期**: 2026-06-03
- **责任人 / Code Owner**: @xiaojianc
- **关联规则**: R-18.2.1、R-18.2.3
- **关联文件**: `src/router/index.ts`、`src/main.ts`、`src/App.vue`、`src/App.spec.ts`、`src/router/README.md`、`scripts/check-router-disabled.ts`

## 背景（Context）

本 ADR 以**当前代码现状**为唯一依据。仓库中此前并不存在 `ADR-0006-router-dormant.md` 或 `ADR-20260423-welcome-smil-svg.md` 实体文件，代码里也没有所谓「欢迎页 / SMIL 动画」；那些只是守卫脚本里残留的旧计划命名，与现状不符，本 ADR 不予沿用。

经核对实际代码，vue-router 已是**常驻启用的最小路由壳**，且是 load-bearing：

- `src/App.vue` 通过单个 `<router-view v-slot>` 作为**唯一渲染入口**渲染当前路由组件。
- 主窗口显示握手依赖路由组件的 `@ready` 事件：`@ready` → `handleWorkbenchReady()` → `revealMainWindow()` → `applyWindowStage({ stage: 'main' })`。
- `src/main.ts` 在 `app.use(pinia)` 后 `app.use(router)`，并在 `app.mount('#app')` 前 `await router.isReady()`。
- `src/App.spec.ts` 有两条测试覆盖：①经 router-view 渲染当前路由与宿主组件；②首帧 `ready` 后调用 `applyWindowStage({ stage: 'main' })`。
- `vue-router` 是 `package.json` 的正式依赖，并在 `vite.config.ts` 中单独切入 `vendor-core` chunk。

因此「移除 / 休眠路由」会破坏渲染、窗口显示握手与既有测试，不可行。

## 决策（Decision）

正式确认 vue-router 为**最小路由壳**并保持 `src/router/index.ts` 头部 `@status: active`。当前实际路由表：

- `/` → 重定向到 `home`
- `/home` → `ShellWorkbenchView.vue`
- `/:pathMatch(.*)*` → 兜底重定向到 `home`
- 历史模式：`createWebHashHistory()`（桌面端 Tauri WebView 友好）
- `beforeEach` / `afterEach` 仅做主题同步（读 `to.meta.theme`，否则回退到 `themeManager` 当前模式），不承载业务逻辑

同时清理一处死字段：`/home` 路由上的 `meta: { layout: 'workbench' }` 全仓无任何消费方（`meta.layout` / `route.meta` 零命中），随本次一并移除。

`scripts/check-router-disabled.ts` 守卫改为指向本 ADR（`docs/architecture/ADR-0008-router-active-shell.md`），并移除对不存在的 `welcome-smil-svg` / `ADR-0006-router-dormant` 的硬编码引用。

## 边界约束（Constraints）

- 路由**不是**工作台业务编排真源；`ShellWorkbenchView.vue` 仍是唯一工作台页面。
- 当前仅保留启动锚点路由，**不**新增业务路由。
- 新增任何业务路由前，MUST 先更新本 ADR 或新增替代 ADR，并经 Code Owner 评审批准（R-18.2.x）。

## 结果（Consequences）

- ✅ 治理记录与代码现实对齐，`check-router-disabled` 守卫恢复 PASS。
- ✅ 守卫不再引用不存在的陈旧 ADR 文件名。
- ✅ 移除无人消费的 `meta.layout`，减少误导。
- ⚠️ `App.spec.ts` 行为保持不变（仍需绿）。
- 回退路径：如确需停用路由，须新建替代本 ADR 的新 ADR，移除 `main.ts` 中的 `app.use(router)` 并将 `src/router/index.ts` 标回 dormant，同时调整 `App.vue` 的渲染入口与 `App.spec.ts`。

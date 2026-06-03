# router/index.ts — 当前状态：已启用（Active）

> **@status: active** | ADR: [ADR-0008-router-active-shell](../../docs/architecture/ADR-0008-router-active-shell.md)

## 当前用途

本项目当前保留最小路由壳，仅提供工作台启动锚点：

- `/home`：工作台路由锚点（`ShellWorkbenchView.vue`）
- `App.vue` 通过唯一 `<router-view>` 渲染当前路由，并负责全局宿主组件与运行时错误呈现
- 路由组件的 `@ready` 事件驱动主窗口显示握手（`applyWindowStage({ stage: 'main' })`）

## 边界约束

- 路由 **不是** 工作台业务编排真源
- `ShellWorkbenchView.vue` 仍是唯一工作台页面
- 新增业务路由前，必须继续遵守 ADR-0008 中的范围限制与评审要求

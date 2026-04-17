# AGENTS.md
> 基于 **Vite 8 + TypeScript 6 + Tailwind CSS 4.2.2 + ESLint 10** 生态对齐
> 强化工程约束、类型安全、架构规范、Tauri 安全边界，统一团队开发标准

---

# 项目技术栈

- 桌面框架：Tauri

- 前端框架：Vue 3（Composition API + `<script setup>`）

- 语言：TypeScript **6.0.2**

- 构建工具：Vite **8.0.8**

- UI 样式：Tailwind CSS **4.2.2**

- 组件库：Shadcn Vue

- 状态管理：Pinia

- 路由：Vue Router **5.0.4**

- 代码规范：
        
    - ESLint **10.2.0**

    - @eslint/js **10.0.1**

    - eslint-plugin-vue **10.8.0**

    - vue-eslint-parser **10.4.0**

- 类型系统：vue-tsc **3.2.6**

- 类型定义：@types/node **25.6.0**

- Vue TS 配置：@vue/tsconfig **0.9.1**

- 工具库：monaco-editor **0.55.1**

- 全局变量：globals **17.5.0** 

---

# 1. 架构设计原则

## 1.1 分层架构

- 前端 UI 层（Vue + Shadcn Vue）
        
    - 页面渲染 / 交互 / 状态展示

- 业务逻辑层（TS + composables）

    - 业务处理 / 数据转换 / API 封装

- 系统层（Tauri Rust）
        
    - 文件系统 / 系统调用 / 权限控制

## 1.2 模块化原则

- 功能必须模块化、单一职责

- 禁止跨模块直接访问内部状态

- 统一通过：
        
    - composables

    - store

    - services

### 推荐结构

```plain text
src/
├── assets/
├── components/
│   └── ui/            # Shadcn 基础组件统一存放目录
├── views/
├── layouts/
├── composables/
├── services/
├── store/
├── router/
├── types/
├── constants/
├── hooks/
└── utils/
```

---

# 2. Vue 3 规范

## 2.1 组件规范

- 必须 `<script setup lang="ts">`

- 文件命名：PascalCase

- 禁止模板写复杂逻辑

- UI 与逻辑分离

## 2.2 composables 规范

- 所有复杂逻辑必须抽离
- 禁止组件内重复逻辑
- defineProps / defineEmits 必须统一使用

---

# 3. TypeScript 规范

- 禁止 any（仅允许极端场景 + 注释说明）
- 所有 API / props / emit 必须类型化
- 类型集中管理 `/types`

**命名：**

- interface：IUser / ILoginParams
- type：TResponse / TOption
- enum：EUserRole / EStatus

---

# 4. Vite 规范

- alias：`@ -> /src`
- env 前缀：`VITE_`

**禁止：**

- 硬编码 API / key / port
- 直接读取 `.env` 文件

---

# 5. Tailwind CSS 4.2.2 规范

- 优先 utility-first
- 禁止滥写自定义 CSS
- 自定义样式统一 `assets/css + @layer`
- Shadcn Vue 主题配置统一管控 UI 风格
- 禁止全局覆盖 Tailwind base

---

# 6. Shadcn Vue 规范

**统一基础组件：**

- 按钮：`Button`
- 表单：`Form` / `FormItem` / `FormField`
- 输入控件：`Input` / `Select` / `Checkbox` / `Radio`
- 表格：`Table` 系列原生组件
- 弹窗抽屉：`Dialog` / `Drawer`

**规则：**

- 所有基础 UI 组件统一使用 Shadcn Vue
- 禁止混用多套 UI 组件库
- 消息提示、通知统一封装全局工具方法
- 表单校验逻辑统一抽离至 composables 集中管理
- 自定义业务组件基于 `components/ui` 内 Shadcn 基础组件二次封装

---

# 7. Tauri 规范（强化安全）

**前端调用：**

```typescript
import { invoke } from '@tauri-apps/api'

const getLocalFile = async () => {
  try {
    return await invoke('get_local_file', { path: 'xxx' })
  } catch (e) {
    throw new Error(`Tauri调用失败：${e}`)
  }
}
```

**Rust：**

- 必须 Result 返回
- 禁止 panic
- snake_case 命名
- 最小权限原则

---

# 8. Pinia 规范

- useXXXStore
- setup store
- 禁止 store 互相调用

- 状态分类：
        
    - persistent（加密）
    - temporary

---

# 9. services 规范

- 所有请求 / IPC 统一封装
- 禁止组件内 try/catch
- 统一错误处理 request.ts

**结构：**

```plain text
services/
├── user.ts
├── file.ts
├── system.ts
└── request.ts
```

---

# 10. 性能优化

- 路由懒加载（必做）
- 组件动态 import
- 长列表虚拟滚动
- 避免 unnecessary reactive
- 图片 webp + 压缩
- 大组件 Suspense

---

# 11. 安全规范

- Tauri 权限最小化
- 禁止暴露系统路径
- 所有输入必须校验
- 禁止未授权 IPC 调用
- token 必须加密存储
- API 必须鉴权

---

# 12. Git 规范

**格式：**

- feat: xxx
- fix: xxx
- refactor: xxx
- perf: xxx
- chore: xxx

---

# 13. 开发流程（强约束）

1. types
2. constants
3. composables
4. services
5. UI
6. store
7. test

---

# 14. 命名规范

- 文件：kebab-case
- 组件：PascalCase
- 方法：camelCase
- 常量：UPPER_SNAKE_CASE
- IPC：snake_case

---

# 15. ESLint + Prettier

- ESLint 10 强制启用 flat config（推荐）
- Prettier 自动格式化
- LF + single quote + 2 spaces
- commit 前必须 lint + typecheck
---

# 16. Husky 校验

提交前必须通过：
- eslint
- prettier
- tsc
- vite build
---

# 17. 红线规则

- 禁止 any
- 禁止 DOM 操作
- 禁止业务写在组件
- 禁止跨模块耦合
- 禁止未处理异常
- 禁止 UI 混库
- 禁止未测试提交
---

# 18. 扩展方向（升级适配）

- 多窗口（Tauri）
- 插件系统
- 自动更新
- i18n 国际化
- 日志系统（前后端统一）
- IPC 类型安全化
- store 加密持久化
---

# 19. 补充优化

- 推荐启用：
        
    - unplugin-auto-import
    - unplugin-vue-components

- Vite 8 建议开启：

    - build cache
    - deps optimization

- monaco-editor 单独 chunk 懒加载
- Shadcn Vue 全局主题集中配置管理
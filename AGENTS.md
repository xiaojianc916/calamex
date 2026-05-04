## 0. META

<aside>
🤖

**AUDIENCE**: AI 编码代理（code agent）。本文档为团队 **单一事实来源（SSoT）**，采用原子化规则 ID + RFC 2119 关键字，便于 AI 按条校验、生成、修复代码。

**VOCAB**: MUST=必须 | MUST NOT=禁止 | SHOULD=应当 | SHOULD NOT=不应 | MAY=可以。缺省按 MUST 执行。

**RULE ID**: `R-<chapter>.<section>.<index>`。例：`R-3.2.1` = 第 3 章第 2 节第 1 条。引用规则 MUST 使用 ID。

**OVERRIDE**: 偏离任一 MUST / MUST NOT MUST 走 ADR 登记（`docs/architecture/ADR-*.md`）并在 PR 描述引用 ADR ID，经 Code Owner 批准。

**冲突优先级**: 安全 > 类型安全 > 可测性 > 可维护性 > 性能 > 代码风格。

**AI 行为准则**: 歧义时 MUST 选保守方案；缺数据时 MUST 停下提问，MUST NOT 猜测；任何「我认为更合理」的偏离 MUST 在输出显式声明。

</aside>

```yaml
schema_version: 1.0.0
audience: ai-code-agent
language_primary: zh-CN
code_languages: [TypeScript, Rust]
rule_id_pattern: ^R-\d+\.\d+(\.\d+)?$
rfc2119: true
override_mechanism: ADR
conflict_priority: [security, type-safety, testability, maintainability, performance, style]
```

---

# G. 全局约束

- **G-1** UTF-8 无 BOM；EOL=LF；缩进=2 空格；字符串单引号。

## **G-2** 前端 TypeScript strict；桌面 Rust（Tauri 2.x）。MUST NOT 引入第三运行时语言（`scripts/` 下一次性脚本可豁免，SHOULD 优先 TS/Rust 改写）。

- **G-3** pnpm ≥ 9；`package.json.packageManager` MUST 精确锁定（如 `pnpm@9.12.0`）；Node ≥ 20 LTS via `engines.node`。
- **G-4** CI 安装命令固定为 `pnpm install --frozen-lockfile`。MUST NOT 出现 `--no-frozen-lockfile`；MUST NOT 手工编辑 `pnpm-lock.yaml` / `Cargo.lock`。
- **G-5** 四件套门禁：合入前 MUST 通过 `typecheck` + `lint` + `test` + `build`。

## **G-6** 文档/注释/提交信息使用中文（技术专名保留英文）。

- **G-7** AI 生成代码在合入前 MUST 经人类 Code Owner 审阅并通过 G-5。
- **G-8** 规则 ID 是稳定契约：已发布规则 ID MUST NOT 改编号；废弃通过新增 `DEPRECATED` 标注 + 继任 ID 指向。

---

# 第 0 章　版本基线

## 0.1 Baseline

```yaml
tauri: ^2
dependencies:
@formkit/auto-animate 0.9.0        monaco-editor 0.55.1               
@icon-park/vue-next 1.4.2          motion-v 2.2.1                     
@tauri-apps/api 2.11.0             pinia 3.0.4                        
@tauri-apps/plugin-dialog 2.7.1    pinia-plugin-persistedstate 4.7.1  
@tauri-apps/plugin-store 2.4.3     reka-ui 2.9.6                      
@wasm-fmt/shfmt 0.2.7              shiki 4.0.2                        
@xterm/addon-fit 0.11.0            stream-markdown 0.0.15             
@xterm/addon-search 0.16.0         tailwind-merge 3.5.0               
@xterm/addon-web-links 0.12.0      tree-sitter-bash 0.25.1            
@xterm/addon-webgl 0.19.0          vue 3.5.33                         
@xterm/xterm 6.0.0                 vue-markdown-design 0.3.2          
class-variance-authority 0.7.1     vue-router 5.0.6                   
clsx 2.1.1                         vue-virtual-scroller 3.0.2         
katex 0.16.45                      web-tree-sitter 0.26.8             
lucide-vue-next 1.0.0              zod 4.4.3                          
markstream-vue 0.0.14-beta.2       

devDependencies:
@axe-core/playwright 4.11.3             eslint-plugin-vue 10.9.0                
@commitlint/cli 20.5.3                  globals 17.6.0                          
@commitlint/config-conventional 20.5.3  husky 9.1.7                             
@eslint/js 10.0.1                       jsdom 29.1.1                            
@playwright/test 1.59.1                 lint-staged 16.4.0                      
@size-limit/file 12.1.0                 postcss 8.5.13                          
@tailwindcss/postcss 4.2.4              prettier 3.8.3                          
@tauri-apps/cli 2.11.0                  shellcheck 4.1.0                        
@types/node 25.6.0                      size-limit 12.1.0                       
@vitejs/plugin-vue 6.0.6                stylelint 17.10.0                       
@vitest/coverage-v8 4.1.5               stylelint-config-tailwindcss 1.0.1      
@vue/test-utils 2.4.10                  tailwindcss 4.2.4                       
@vue/tsconfig 0.9.1                     tsx 4.21.0                              
@withfig/autocomplete 2.692.3           typescript 6.0.3                        
@withfig/autocomplete-tools 2.11.0      typescript-eslint 8.59.1                
autoprefixer 10.5.0                     vite 8.0.10                             
dpdm 4.0.1                              vitest 4.1.5                            
esbuild 0.28.0                          vue-eslint-parser 10.4.0                
eslint 10.3.0                           vue-tsc 3.2.8                           
eslint-config-prettier 10.1.8           
node: ">=24"
```

> 基线版本与真实 registry 冲突时 MUST 先走 ADR 更新本表，再动依赖。
> 
- 0.2 Rules
- **R-0.2.1** MUST 使用精确版本或受控 `^x.y` 范围。

## **R-0.2.2** MUST NOT 使用 `latest` / `next` / `beta` / `*` / 分支 / git URL 作为运行时依赖版本。

- **R-0.2.3** 主版本升级 MUST 走 RFC（变更说明 + 影响面 + 回滚方案）。
- **R-0.2.4** 次版本 / 补丁升级 MUST 由 Renovate/Dependabot 自动 PR 并人工审核 changelog。
- **R-0.2.5** 任何升级 PR MUST 通过 G-5。
- **R-0.2.6** MUST NOT 手工编辑 lock；MUST 通过重新 `install` 生成。

## **R-0.2.7** `package.json` / `tauri.conf.json` / `src-tauri/tauri.conf.json` / `Cargo.toml` 版本号 MUST 严格一致；CI 脚本 `scripts/check-versions.ts` 校验。

## 0.3 Enforcement

- `scripts/check-versions.ts`（跨文件版本一致性）+ `renovate.json` 或 `dependabot.yml`（升级）+ `pnpm audit` / `cargo audit`（安全审计）

---

# 第 1 章　架构分层

## 1.1 层次

```
UI(Vue SFC + Shadcn) ─▶ 业务逻辑(composables/store/services) ─▶ 系统(Tauri Rust)
```

依赖方向严格单向自上而下。

## 1.2 Rules

- **R-1.2.1** UI 层 MUST 仅做渲染 / 事件分发 / 视图状态展示。
- **R-1.2.2** UI 层 MUST NOT 写业务判断、MUST NOT 直接 `fetch`、MUST NOT 直接 `invoke`、MUST NOT 直接读写存储。
- **R-1.2.3** 业务层是 UI 与系统层之间的唯一桥梁；副作用（主题切换、系统监听、持久化）MUST 集中在 composables / store。
- **R-1.2.4** Rust 侧 MUST 仅暴露最小命令集；入参/出参 MUST 类型化并在前端侧运行时校验。
- **R-1.2.5** 依赖方向 MUST：UI → 业务 → 系统；MUST NOT 反向、MUST NOT 跨层穿透。

## **R-1.2.6** 组件 MUST NOT `import` 其他模块 store 的私有符号；只能用 `useXxxStore()` 公共 API。

- **R-1.2.7** MUST NOT 在 `window` / `globalThis` / 模块顶层可变变量挂全局状态。
- **R-1.2.8** MUST NOT 循环依赖；CI `dpdm` 检测。
- **R-1.2.9** 新增顶层目录 MUST 同步登记到 1.3 + ADR。

## 1.3 目录（强约束）

```
src/
  assets/css/{shadcn-theme.css, tailwind.css}
  components/ui/         # Shadcn CLI 产物；MUST NOT 手改主题样式
  components/business/   # 基于 ui 二次封装
  views/                 # 路由级页面
  layouts/
  composables/           # useXxx.ts；主题逻辑集中于 useTheme.ts
  services/              # I/O 唯一出口（第 9 章）
  store/                 # Pinia setup stores，按业务域拆分
  router/                # 懒加载路由表
  types/                 # 跨模块类型；含 ipc.generated.ts、shadcn-theme.ts
  constants/             # UPPER_SNAKE_CASE
  hooks/                 # 与框架无关副作用封装
  utils/                 # 纯函数；MUST 无副作用
src-tauri/
  capabilities/          # 按窗口/场景拆分的能力清单（第 7 章）
```

## 1.4 Enforcement

- `eslint-plugin-import.no-restricted-paths`（层间依赖）+ `dpdm`（循环依赖）+ `components/ui/` CODEOWNERS 写保护

---

# 第 2 章　Vue 3

## 2.1 组件

- **R-2.1.1** SFC MUST 使用 `<script setup lang="ts">`；MUST NOT Options API 或无 `lang="ts"` 的 `<script>`。

## **R-2.1.2** SFC 结构顺序 MUST：`<script setup>` → `<template>` → `<style>`。

- **R-2.1.3** 单文件 >300 行 SHOULD 按职责拆分。
- **R-2.1.4** 文件名 MUST PascalCase；MUST NOT 使用 `Index.vue`。
- **R-2.1.5** `defineProps` / `defineEmits` MUST 用类型化泛型；MUST NOT 运行时数组/对象声明。
- **R-2.1.6** Props 默认值 MUST 经 `withDefaults`；emits payload MUST 类型化（MUST NOT `any`）。
- **R-2.1.7** Emits 事件名 MUST kebab-case。
- **R-2.1.8** 模板 MUST NOT 含复杂表达式（>2 条件 / 多层三元 / 数据转换）；MUST 提到 `computed` 或 composable。
- **R-2.1.9** `v-for` MUST 提供稳定 key；MUST NOT 用数组索引作 key（完全不可变列表除外）。
- **R-2.1.10** `v-if` 与 `v-for` MUST NOT 写在同一元素。

---

# **R-2.1.12** 组件内 MUST NOT 声明 Shadcn 主题 CSS 变量；MUST NOT 使用 `!important`。

## **R-2.1.13** 单块逻辑 >20 行 MUST 抽离到 composable。

- **R-2.1.14** 组件 MUST NOT 直接 `fetch` / `invoke` / 读写 `localStorage`。
- **R-2.1.15** 直接操作 DOM MUST 经 `ref` 并封装成 composable。

## 2.2 composables

## **R-2.2.1** 文件 / 函数 MUST 以 `use` 开头 camelCase。

- **R-2.2.2** 一个文件 MUST 只导出一个主 composable。
- **R-2.2.3** 返回值 MUST 对象；对外只读数据 MUST 用 `readonly` 或 `computed`。
- **R-2.2.4** 副作用 MUST 在 `onScopeDispose` 清理。

## **R-2.2.5** MUST NOT 直接读写 `localStorage` / `sessionStorage`（持久化交 store 插件）。

- **R-2.2.6** MUST NOT 向外抛未处理异常；MUST 以 `{ data, error, status }` 或归一化错误对象暴露。
- 2.3 响应式
- **R-2.3.1** 优先 `ref` / `computed` / `watchEffect`；`reactive` 仅确有必要时用。
- **R-2.3.2** `watch` MUST 显式声明依赖源。

## **R-2.3.3** 大规模只读数据 MUST 用 `shallowRef` / `markRaw`。

- **R-2.3.4** 第三方实例对象（monaco / 图表 / 地图）MUST NOT 用 `ref` / `reactive`。
- **R-2.3.5** `<script setup>` 顶层 MUST NOT 写裸 `await`（除非配 `<Suspense>`）。

## 2.4 测试

- **R-2.4.1** 业务组件 MUST 配 Vitest + `@vue/test-utils` 测试。
- **R-2.4.2** 测试 MUST NOT 依赖真实网络 / IPC；MUST 通过 services mock 注入。

## 2.5 MUST NOT（汇总）

- Options API / mixin / 全局事件总线 / `provide`+`inject` 代替 store / 组件硬编码设计令牌 / `import` store 内部模块路径。

## 2.6 Enforcement

- `eslint-plugin-vue:vue3-recommended` + Vitest + `@vue/test-utils`；SFC 300 行软告警。`dpdm` 检测循环依赖；`eslint-plugin-import:no-internal-modules` 限制跨模块私有路径。

---

# 第 3 章　TypeScript

## 3.1 tsconfig

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

- **R-3.1.1** `tsconfig` MUST 继承 `@vue/tsconfig`；拆 `tsconfig.app.json` / `tsconfig.node.json`；入口 `tsconfig.json` 仅做 `references`。
- **R-3.1.2** 类型检查 MUST 用 `vue-tsc --noEmit`；MUST NOT 对 Vue 工程单独 `tsc`。

## 3.2 any / unknown

- **R-3.2.1** MUST NOT 使用 `any`。豁免同时满足：(a) 行前注释 + 清理计划；(b) 显式 `// eslint-disable-next-line @typescript-eslint/no-explicit-any`；(c) 登记 `docs/tech-debt.md` 含截止日期。
- **R-3.2.2** 外部输入（HTTP/IPC/`JSON.parse`/URL 参数）MUST 以 `unknown` 接收；MUST 经 Zod 或等效运行时校验收窄。
- **R-3.2.3** MUST NOT `as any` / `as unknown as T` 双重断言；收窄 MUST 用 `is` 谓词守卫。

## 3.3 类型位置

- **R-3.3.1** 跨模块类型 MUST 放 `src/types/`，按领域拆文件；MUST NOT 聚在单一 `index.d.ts`。
- **R-3.3.2** 单模块类型 MAY 放同目录 `types.ts` / `xxx.types.ts`。
- **R-3.3.3** 环境变量类型 MUST 在 `src/types/env.d.ts` 扩展 `ImportMetaEnv` / `ImportMeta`。
- **R-3.3.4** IPC 类型 MUST 由 `tauri-specta`（或等效）生成到 `src/types/ipc.generated.ts`；MUST NOT 手改。

## 3.4 命名

- **R-3.4.1** 接口 `I` 前缀（`IUser`）；类型别名 `T` 前缀（`TResponse`）；枚举 `E` 前缀（`EUserRole`）。
- **R-3.4.2** 泛型参数单字母：`T`/`K`/`V`/`R`/`P`。
- **R-3.4.3** 布尔变量前缀 `is`/`has`/`should`/`can`；MUST NOT 双重否定。
- **R-3.4.4** `I`/`T`/`E` 前缀是本项目刻意约定；开源发包需转换为社区风格。

## 3.5 枚举

- **R-3.5.1** SHOULD `as const` + 联合字面量。
- **R-3.5.2** 需保运行时行为 MAY `const enum`（启用 `preserveConstEnums` 并登记）。
- **R-3.5.3** MUST NOT 混用数字/字符串枚举。

## 3.6 契约类型化

- **R-3.6.1** API 响应 / Props / Emits / Store state / Service 参数 / IPC 入出参 MUST 显式类型化。

---

## 3.7 主题类型

- **R-3.7.1** Shadcn 主题变量 MUST 有 TS 定义于 `src/types/shadcn-theme.ts`，与 CSS 变量一一对应；CI 校验键名一致，不一致失败。
- **R-3.7.2** `TThemeMode = 'light' | 'dark' | 'system'` 固定；业务层 MUST NOT 扩展字面量。

## 3.8 运行时校验

- **R-3.8.1** 外部输入 MUST 用 Zod + `safeParse` / `parse`。
- **R-3.8.2** Zod schema 与 TS 类型 MUST 经 `z.infer` 单源；MUST NOT 双维护。
- **R-3.8.3** 类型守卫 MUST 命名 `isXxx`、返回 `value is T`。

## 3.9 空值

- **R-3.9.1** API/DTO 层「无值」= `null`；组件 props / 内部状态 = `undefined`；持久化层按领域在类型注释写明。
- **R-3.9.2** MUST NOT 混用 `null` / `undefined` / `''` 表达同一语义。
- **R-3.9.3** MUST NOT 非空断言 `!`；必要时配类型守卫或显式校验，PR 说明。

## 3.10 工具类型

- **R-3.10.1** 优先内置 `Partial` `Required` `Readonly` `Pick` `Omit` `Record` `ReturnType` `Parameters` `Awaited`。
- **R-3.10.2** 自定义工具类型 MUST 放 `src/types/utility.ts` + TSDoc。
- **R-3.10.3** 类型文件 MUST NOT 含运行时代码。

## 3.11 MUST NOT（汇总）

- `any` / `@ts-ignore`（必要时 `@ts-expect-error` + 注释）/ `Function` / `Object` / `{}` / `namespace` / 修改第三方类型定义（必要时 `declare module` 于 `src/types/`）。

## 3.12 Enforcement

- `typescript-eslint` 严格规则集 + `vue-tsc --noEmit` + `scripts/check-theme-keys.ts`（主题类型键名一致性）+ Zod schema 合约回归测试

---

# 第 4 章　Vite

## 4.1 入口

## **R-4.1.1** 构建配置唯一入口 MUST 为 `vite.config.ts`，`defineConfig(({ mode, command }) => ...)` 函数形态。

- **R-4.1.2** 复杂配置 MUST 拆到 `vite/` 子目录。

## 4.2 别名

- **R-4.2.1** MUST 配 `@` → `src`；`tsconfig.json.paths` MUST 一致。
- **R-4.2.2** 允许别名：`@`（必选）、`@types`、`@assets`；其他 MUST 走 ADR。
- **R-4.2.3** MUST NOT 相对路径穿越 ≥2 层。

## 4.3 环境变量

- **R-4.3.1** 暴露到客户端的变量 MUST 以 `VITE_` 开头；`.env.local` MUST 入 `.gitignore`。
- **R-4.3.2** 所有 `VITE_*` MUST 在 `src/types/env.d.ts` 登记；未登记 MUST NOT 使用。
- **R-4.3.3** MUST 通过 `import.meta.env.VITE_XXX` 访问；MUST NOT 直读 `.env`；MUST NOT 运行时拼接变量名动态访问。
- **R-4.3.4** 密钥/令牌/内部地址 MUST NOT 写入任何 `VITE_*`；MUST NOT 进入前端产物。

## 4.4 插件

- 必装：`@vitejs/plugin-vue`、`unplugin-auto-import`、`unplugin-vue-components`、`vite-plugin-vue-devtools`（仅 dev）。
- **R-4.4.1** `auto-imports.d.ts`、`components.d.ts` MUST 纳入版本控制。

---

# 4.5 构建

## `build.target: es2022`；`sourcemap` dev=`true` / staging=`'hidden'` / prod 视 Sentry（无则 `false`）；`outDir: dist`。

- **R-4.5.1** MUST NOT 关闭 `cssCodeSplit`。
- **R-4.5.2** MUST NOT 无理由提高 `chunkSizeWarningLimit`。
- **R-4.5.3** `outDir` 固定 `dist`（Tauri 读路径）。
- **R-4.5.4** 大依赖（monaco）MUST 显式 `optimizeDeps.include/exclude`。

## 4.6 Dev

- **R-4.6.1** 端口/代理 MUST 由环境变量控制；MUST NOT 硬编码。

## **R-4.6.2** Tauri 联调 MUST 通过 `tauri.conf.json.build.devUrl` 指向 Vite dev server。

- **R-4.6.3** 跨域代理 MUST 统一在 `server.proxy`。

## 4.7 资源

- **R-4.7.1** 图片优先 WebP/AVIF；SVG MUST 组件化；模板 MUST NOT 嵌大段 SVG 源码。
  唯一例外：欢迎页允许按 ADR-20260423-welcome-smil-svg 使用本地 `?raw` SVG + `v-html` 保留原生 SMIL 动画；该例外 MUST 限定在 `src/views/Welcome.vue`（及启动桥接同域组件），MUST NOT 扩散到业务页面。

## **R-4.7.2** 静态资源 MUST 放 `src/assets/{css,images,fonts,icons}`。

- **R-4.7.3** `public/` MUST NOT 放业务图片；仅限 favicon / manifest。
- **R-4.7.4** 引用 `public/` 资源 MUST 用 `import.meta.env.BASE_URL` 或 `new URL(..., import.meta.url)`。

## 4.8 分割

- **R-4.8.1** 路由级页面 MUST 动态 `import()`。

## **R-4.8.2** 首屏外重组件 MUST 动态加载 + `<Suspense>` 或加载态。

- **R-4.8.3** `manualChunks` MUST 按业务领域；MUST NOT 按字母/随机。
- **R-4.8.4** 核心公共依赖合并 `vendor-core`。
- **R-4.8.5** 新依赖 gzip >50KB MUST 动态加载。

## 4.9 MUST NOT（汇总）

- 硬编码 API 地址/端口/密钥/系统路径；绕过 `import.meta.env`；产物目录外写文件；构建阶段产出不可复现内容。

## 4.10 Enforcement

- `size-limit` + `.size-limit.json`；ESLint 禁止前端代码直读 `process.env.*`；`scripts/check-env-vars.ts` 校验 `VITE_*` 登记一致性

---

# 第 5 章　Tailwind CSS 4

## 5.1 CSS-first

- **R-5.1.1** MUST 采用 CSS-first；全局 token 在 `@theme` 块声明；MUST NOT 以 TW3 风格 `tailwind.config.ts` 作主配置（历史遗留需 ADR 登记）。
- **R-5.1.2** 入口 CSS 固定 `src/assets/css/tailwind.css`，职责限：引入 Tailwind + 引入 `shadcn-theme.css` + 极少项目级基础样式。
- **R-5.1.3** 全局设计 token MUST 在 `shadcn-theme.css` 的 `@theme` 块单源声明；MUST NOT 在 `tailwind.config.ts` 或组件内重复声明。

## 5.2 使用

- **R-5.2.1** utility-first：MUST 优先原子类。
- **R-5.2.2** 允许自定义 CSS 的场景：(a) utility 无法表达的选择器（`:has()`、`::marker`）；(b) 可复用语义块（置 `@layer components`）；(c) 第三方必要覆盖（MUST 附注释）。
- **R-5.2.3** 自定义样式 MUST 按 `@layer` 分层：`base`（仅主题变量 + 排版基线）/ `components`（语义块）/ `utilities`（扩展 utility）。
- **R-5.2.4** MUST NOT 在 `<style>` 裸写未分层全局样式。

## 5.3 @apply / 语义类

## **R-5.3.1** `@apply` MUST 仅用于 `@layer components` 语义类。

- **R-5.3.2** MUST NOT 在 SFC `<style scoped>` 用 `@apply` 替代模板 utility 组合。
- **R-5.3.3** 语义类 MUST kebab-case + 领域前缀（`btn-primary` `card-section` `form-row`）。

## 5.4 响应式 / 变体

- **R-5.4.1** MUST 用默认断点 `sm md lg xl 2xl`；自定义 MUST 在 `@theme` 声明并登记。

## **R-5.4.2** 状态变体顺序 MUST：`responsive:state:dark:utility`。

- **R-5.4.3** MUST NOT 用自定义 CSS 重复实现已有变体。

## 5.5 与 Shadcn 互通

- **R-5.5.1** 主题颜色/圆角/阴影/间距 MUST 通过 CSS 变量，Tailwind 侧经 `@theme` 暴露为 utility。
- **R-5.5.2** 变量命名 MUST 遵循 Shadcn 约定。
- **R-5.5.3** 对应 utility MUST 同步暴露。

---

## 5.6 颜色

## **R-5.6.1** 新增主题色 MUST OKLCH；历史 HSL 下次重构 MUST 迁移。

1. **R-5.6.2** 组件层 MUST NOT 直接用十六进制 / RGB 字面量表达主题色。
2. **R-5.6.3** 装饰色 MAY 硬编码，但 MUST 集中 `src/constants/colors.ts`。
3. 5.7 暗色
4. **R-5.7.1** MUST 用 `class` 策略（`<html>` 切 `dark`）；MUST NOT 用 `media` 策略。
5. **R-5.7.2** 组件 MUST NOT 写 `@media (prefers-color-scheme: dark)`；MUST 改 `.dark` 选择器或 `dark:` 变体。

## 5.8 排版

1. **R-5.8.1** 字体族/字号/行高 MUST 在 `@theme` 声明；组件 MUST NOT 写内联 `font-family` 字符串。
2. **R-5.8.2** 全局排版基线 MUST 在 `@layer base`。
3. 5.9 MUST NOT（汇总）
- `!important` / 深层选择器覆盖 Shadcn 内部实现 / 主题变量硬编码到 CSS / 一行 >15 utility 类 / 与其他 CSS 框架混用。

## 5.10 Enforcement

- `stylelint` + `stylelint-config-tailwindcss` + `scripts/check-theme-keys.ts`；`!important` 扣约扫描与黑名单已登记文件

---

# 第 6 章　Shadcn Vue

## 6.1 选型

- **R-6.1.1** UI MUST 统一 Shadcn Vue（底层 reka-ui）；MUST NOT 混用 Element Plus / Ant Design Vue / Naive UI / Vuetify。
- **R-6.1.2** 组件 MUST 通过 Shadcn CLI 生成到 `src/components/ui/`；MUST NOT 以整包 npm 引入。
- **R-6.1.3** 业务组件 MUST NOT 绕过 Shadcn 层直接消费 reka-ui primitive。

## 6.2 基础组件白名单

- 按钮 `Button`；表单 `Form` `FormField` `FormItem` `FormLabel` `FormControl` `FormDescription` `FormMessage`；输入 `Input` `Textarea` `Select` `Checkbox` `RadioGroup` `Switch` `Slider`；展示 `Table*` `Badge` `Avatar` `Tooltip` `Card`；浮层 `Dialog` `AlertDialog` `Drawer` `Popover` `HoverCard` `Sheet`；导航 `Tabs` `Breadcrumb` `Pagination` `NavigationMenu` `Command`；反馈 `Toast` `Progress` `Skeleton`。
- **R-6.2.1** 白名单外需求 MUST 先评估组合实现；确需新增 MUST 经技术评审后 CLI 生成并更新白名单。

## 6.3 二次封装

- **R-6.3.1** 业务组件 MUST 基于 `components/ui/` 封装到 `components/business/`。
- **R-6.3.2** MUST NOT 改 Shadcn 基础组件源码；扩展 MUST 通过插槽/Props/attrs 透传。
- **R-6.3.3** 全局通知/确认/Loading MUST 封装为 `services/notify.ts` / `composables/useConfirm.ts`。
- **R-6.3.4** 表单校验 MUST 在 composables 中 `vee-validate + zod`（或项目统一选型），schema/TS 单源。

## 6.4 升级

- **R-6.4.1** 升级 MUST 通过 CLI；MUST NOT 手工拉取 GitHub 源码覆盖。
- **R-6.4.2** 升级 diff MUST 经 Code Review；主题/a11y/事件接口变更 MUST 回归测试。

## 6.5 主题（核心）

## **R-6.5.1** 唯一主题配置文件 MUST 为 `src/assets/css/shadcn-theme.css`；MUST NOT 新增 `theme.css` / `variables.css` / `colors.css` 等。

- **R-6.5.2** 该文件只做主题变量与主题相关基础样式；MUST NOT 写业务/页面/组件样式；MUST NOT 引用具体组件或页面路径。
- **R-6.5.3** 变量声明 MUST 以 `@layer base` 包裹。
- **R-6.5.4** 变量覆盖维度（缺一不可）：主色（`--primary` / `--primary-foreground`）；辅助色（`--secondary` / `--secondary-foreground`）；中性色（`--background` `--foreground` `--muted*` `--accent*` `--card*` `--popover*`）；状态色（`--destructive` / `--destructive-foreground`）；描边焦点（`--border` `--input` `--ring`）；形状（`--radius` `--radius-sm/md/lg`）；阴影（`--shadow-*`）；间距（`--spacing-xs/sm/md/lg/xl`）；过渡（`--transition-theme`）。
- **R-6.5.5** 模式 MUST 支持 `light` `dark` `system`；`system` 跟随 `prefers-color-scheme`。
- **R-6.5.6** 暗色 MUST 通过 `.dark` 选择器覆盖 `:root`；MUST NOT 另起独立文件。

---

# **R-6.5.8** 主题类型定义固定 `src/types/shadcn-theme.ts`；`TThemeMode` / `IThemeMethods` 固定；CI 校验键名一致。

## **R-6.5.9** 主题逻辑 MUST 集中于 `src/composables/useTheme.ts`（订阅 store / 监听系统主题 / 切 `dark` 类 / 暴露解析主题与变量读取）。

- **R-6.5.10** 主题持久化 MUST 由 `useThemeStore` + `pinia-plugin-persistedstate`；`useTheme` MUST NOT 直接读写存储。
- **R-6.5.11** 组件 MUST NOT 自监听媒体查询或操作 `document.documentElement.classList`。
- **R-6.5.12** 主题切换 MUST 单帧内完成；过渡时长 MUST 由 `--transition-theme` 控制；首屏 MUST 在渲染前确定模式（`index.html` 注入极小同步脚本，**唯一允许的内联脚本例外**，MUST 用 CSP `nonce`）。

## 6.6 MUST NOT（汇总）

- 改 Shadcn 源码中主题样式 / 组件内自定义主题变量 / `!important` 或深选择器覆盖 / 多主题配置文件 / 主题变量与 Tailwind token 不一致 / 业务语义变量名（`--login-btn-bg`）/ 主题变量含敏感信息 / 模板硬编码设计令牌。

## 6.7 Enforcement

- `scripts/check-theme-keys.ts`（主题变量与 TS 键名一致）；`src/components/ui/**` 经 CODEOWNERS 写保护；可访问性与视觉回归（见第 11 章 / 第 15 章）

---

# 第 7 章　Tauri 2.x

## 7.1 基线

## **R-7.1.1** MUST 用 Tauri 2.x；主版本锁定。

- **R-7.1.2** 前端导入 MUST 用 2.x 包：`@tauri-apps/api/core`（`invoke`）、`@tauri-apps/api/event`、各 `@tauri-apps/plugin-*`。
- **R-7.1.3** MUST NOT 与 1.x allowlist 机制共存。

## 7.2 前端调用

- **R-7.2.1** 组件 MUST NOT 直接 `invoke`；IPC MUST 经 `services/ipc.ts`。
- **R-7.2.2** IPC 封装 MUST 提供：(a) 入参 Zod；(b) 出参 Zod；(c) 错误归一化为 `AppError`（见 9.3）；(d) 超时与取消。
- **R-7.2.3** IPC TS 类型 MUST 由 `tauri-specta` 生成到 `src/types/ipc.generated.ts`。
- **R-7.2.4** 调用 MUST `async/await` + 超时 + 取消；MUST NOT 裸 Promise 链。

## 7.3 Rust

- **R-7.3.1** 命令 MUST 返回 `Result<T, AppError>`；`AppError` 基于 `thiserror::Error`。
- **R-7.3.2** MUST NOT `unwrap` / `expect` / `panic!`。

## **R-7.3.3** 命名 MUST snake_case。

- **R-7.3.4** MUST 最小参数原则；MUST NOT 接收整个前端对象。
- **R-7.3.5** 高风险操作 MUST 封装独立模块 + 单测。
- **R-7.3.6** `Cargo.toml` MUST NOT 使用 `*` 或未锁的 `git = "..."`。

## 7.4 能力

- **R-7.4.1** 能力清单 MUST 在 `src-tauri/capabilities/` 按窗口/场景拆分。
- **R-7.4.2** 每个能力 MUST 仅授必需权限；MUST NOT 通配符。

## **R-7.4.3** 新增命令 MUST 同步更新能力清单；PR 描述 MUST 单独说明权限变更。

- **R-7.4.4** 高敏插件（fs/shell/http/notification）默认关闭；启用 MUST 经安全评审。

## **R-7.4.5** MUST NOT 启用 `dangerousRemoteDomainIpcAccess` 等危险开关。

## 7.5 CSP

- **R-7.5.1** `tauri.conf.json.app.security.csp` MUST 显式声明；MUST NOT 留空。
- **R-7.5.2** CSP MUST 禁 `unsafe-inline` / `unsafe-eval`；图/字/样/脚来源 MUST 白名单；`connect-src` MUST 仅允许已依赖后端。
- **R-7.5.3** CSP MUST 在发布产物同样生效；dev 模式放宽 MUST 在 `vite.config.ts` 条件分支中显式限定。
- **R-7.5.4** 开发 MUST 用 `build.devUrl`；MUST NOT `file://` 或绝对磁盘路径。

## 7.6 窗口 / 进程

- **R-7.6.1** 窗口创建 MUST 经配置或受控 API；MUST NOT 业务代码任意 `new WebviewWindow`。
- **R-7.6.2** 窗口标签 MUST 预声明；动态窗口 MUST 走统一工厂。
- **R-7.6.3** 子进程/Shell 默认禁用；启用 MUST 限命令白名单 + 参数校验；MUST NOT 拼接用户输入作为命令参数。

## 7.7 敏感数据

## **R-7.7.1** 令牌/密钥/凭证 MUST 存 Tauri 安全容器（`tauri-plugin-stronghold` 或系统 keyring）。

- **R-7.7.2** MUST NOT 使用 `localStorage` / `sessionStorage` / `IndexedDB` 明文存敏感数据。
- **R-7.7.3** 前端内存持有敏感数据时间 MUST 最小化，用完立即清除。
- **R-7.7.4** 日志/错误上报/遥测 MUST NOT 含敏感字段；MUST 在统一日志封装层脱敏（第 14 章）。

## 7.8 文件/路径

- **R-7.8.1** 前端 MUST NOT 接触原始绝对路径；文件操作 MUST 经 Rust 命令。
- **R-7.8.2** 路径校验 MUST 防穿越：拒绝 `..` / 拒绝沙箱外 / 拒绝符号链接穿越。
- **R-7.8.3** 文件读写 MUST 限定在应用数据目录或用户显式授权路径。

## 7.9 自动更新

- **R-7.9.1** MUST 用官方 updater + HTTPS + 签名校验。
- **R-7.9.2** 公钥 MUST 硬编码到发布产物；私钥 MUST 仅存 CI 安全存储。
- **R-7.9.3** 更新失败 MUST 可回滚；MUST NOT 破坏用户数据。

## 7.10 事件

- **R-7.10.1** 事件名 MUST kebab-case；payload MUST 类型化。
- **R-7.10.2** 请求-响应 MUST 用 `invoke`；MUST NOT 用事件模拟同步请求。

## **R-7.10.3** 高频事件 MUST 节流或批量下发。

## 7.11 Enforcement

- `cargo clippy -D warnings` + `cargo deny check` + `gitleaks`（pre-commit + CI）+ SBOM 生成脚本（CycloneDX）+ `scripts/check-capabilities.ts`（能力清单通配符扫描）+ CSP lint

---

# 第 8 章　Pinia

## 8.1 结构

- **R-8.1.1** MUST 用 setup store 风格；MUST NOT Options Store。
- **R-8.1.2** 文件 `src/store/`，按业务域一域一文件；命名 `useXxxStore`，`defineStore` id 用 kebab-case。
- **R-8.1.3** 一个文件 MUST 只导出一个主 store。

## 8.2 状态分类（注释标明）

- **persistent**：跨会话保留 → `pinia-plugin-persistedstate`；敏感项 MUST 加密序列化。
- **temporary**：仅当前会话 → MUST NOT 持久化。
- **sensitive**：令牌/凭证 → MUST NOT 进前端 store；走 Tauri 安全存储（见 R-7.7.*）。

## 8.3 Getter / Action

- **R-8.3.1** Getter MUST 是纯函数（只读、无副作用、无异步）。
- **R-8.3.2** Action 命名 MUST 动词短语（`fetchUser` `updateProfile`）。
- **R-8.3.3** Action MUST NOT `try/catch` 掩盖错误；MUST 向上抛出。
- **R-8.3.4** Action MUST 显式声明返回值类型；异步 MUST 返回 `Promise<T>`。

## 8.4 Store 间协作

- **R-8.4.1** store 间 MUST NOT 互相 `import` 形成强耦合；协作 MUST 通过下沉到 composable / 统一通知层 / 调用方组合多 store。
- **R-8.4.2** MUST NOT 在 action 中直接改另一 store 的 state；只能调其 action。

## 8.5 持久化

- **R-8.5.1** MUST 用 `pinia-plugin-persistedstate`，在 `src/store/index.ts` 一次性注册。
- **R-8.5.2** 每 store MUST 显式 `persist.paths`；MUST NOT 全量持久化。
- **R-8.5.3** `key` MUST 带统一前缀；大数据 SHOULD `debounce`。
- **R-8.5.4** MUST NOT 手写 `localStorage.setItem`。

## 8.6 主题 store

- **R-8.6.1** `useThemeStore` 至少含：当前 `TThemeMode`、派生解析主题、最近切换时间戳。
- **R-8.6.2** 持久化字段 MUST 仅含主题模式。
- **R-8.6.3** DOM 副作用 MUST 由 `useTheme` 完成；store action 仅做纯状态变更。

## 8.7 契约

- **R-8.7.1** state/getter/action 公共签名 MUST 显式类型化。
- **R-8.7.2** 对外暴露字段 MUST 最小化；内部中间状态 MUST 用模块私有变量或 `readonly`。
- **R-8.7.3** 删除对外字段 MUST 经 RFC。

## 8.8 MUST NOT（汇总）

- Options Store / 跨 store 改 state / 组件 import store 非公共符号 / 敏感数据进 store / 整 store 持久化 / action 吞异常 / store 外绕过 action 直改 state。

## 8.9 Enforcement

- ESLint 自定义规则 `no-cross-store-state-mutation`；`eslint-plugin-import:no-internal-modules` 限制私有符号 import；`store/*.ts` 单元测试必备

---

# 第 9 章　services（I/O 唯一出口）

## 9.1 目录

```
src/services/
  request.ts       # HTTP 客户端（拦截器、错误归一化、鉴权注入）
  ipc.ts           # Tauri IPC 统一封装（Zod、超时、取消、归一化）
  notify.ts        # 全局通知（基于 Shadcn Toast）
  modules/         # 按业务域拆分
    user.ts
    file.ts
    system.ts
    auth.ts
```

- **R-9.1.1** `fetch` / `axios` / `invoke` MUST 只在 `services/` 下出现；其他目录 MUST NOT 直接调用。

## 9.2 HTTP 封装

- **R-9.2.1** HTTP 客户端 MUST 二选一（原生 `fetch` + 轻封装 或 `axios`）；MUST NOT 混用。
- **R-9.2.2** 封装 MUST 具备：请求拦截（鉴权头/租户头/语言头）、响应拦截（解析统一响应体/错误归一化）、超时（常量集中配置）、取消（`AbortController`，组件卸载时 MUST 取消）、重试（幂等可有限次指数退避，非幂等 MUST NOT 自动重试）。
- **R-9.2.3** 请求/响应数据 MUST 类型化；业务接口出入参 MUST 经 Zod schema 单源校验。

## 9.3 错误模型 `AppError`

```tsx
interface IAppError {
  code: string                // 业务错误码
  message: string             // 面向用户的中文消息
  scope: 'http' | 'ipc' | 'validation' | 'unknown'
  traceId: string             // UUIDv4 或 ULID
  cause?: unknown             // 原始错误，仅日志使用
  timestamp: string           // ISO-8601
}
```

- **R-9.3.1** 请求/IPC 错误 MUST 归一化为 `AppError`。
- **R-9.3.2** 组件层 MUST NOT 写 `try/catch`；错误由 services 拦截后经 composable/store 或全局错误处理器（`app.config.errorHandler` / Router 错误钩子 / `unhandledrejection`）统一上报。
- **R-9.3.3** 错误提示 MUST 经 `services/notify.ts`；MUST NOT 组件内调底层 Toast API。
- **R-9.3.4** MUST NOT 用静默回退处理错误（产品显式要求 + 注释说明除外）。

## 9.4 接口模块

- **R-9.4.1** `services/modules/*` 内按「查询/命令」分组：查询动词 `get` `list` `search`；命令动词 `create` `update` `delete` `submit`。
- **R-9.4.2** 接口函数 MUST 显式类型化入参与返回值。
- **R-9.4.3** 路径/HTTP 方法/查询参数常量 MUST 集中于模块顶部；MUST NOT 函数体中散落字面量。

## 9.5 IPC 封装

- **R-9.5.1** `services/ipc.ts` MUST 导出 `ipc<TIn, TOut>(cmd, input, inSchema, outSchema)`。
- **R-9.5.2** 所有 IPC 命令 MUST 配 Zod schema；与 `ipc.generated.ts` 不一致时 MUST 以生成类型为准并更新 schema。
- **R-9.5.3** IPC MUST 支持超时与取消；长耗时命令 MUST 通过 Rust 事件推送进度，MUST NOT 前端轮询。
- **R-9.5.4** IPC 错误归一化 `scope='ipc'`。

## 9.6 通知

- **R-9.6.1** `notify.ts` MUST 导出四语义方法 `success` `info` `warning` `error`。
- **R-9.6.2** 默认时长/位置/堆叠数量 MUST 集中于常量。
- **R-9.6.3** 错误通知 MUST 显示错误码或 `traceId`。

## 9.7 Mock / 测试

- **R-9.7.1** services MUST 可替换：测试中通过依赖注入或模块 mock。
- **R-9.7.2** 单测 MUST NOT 真实发网络/IPC；MUST 用 mock。
- **R-9.7.3** 每个对外接口 MUST 有测试覆盖「核心成功路径 + 至少一条错误路径」。

## 9.8 MUST NOT（汇总）

- 组件裸 `fetch`/`axios`/`invoke` / 组件内 `try/catch` / 返回未归一化原始错误 / 业务函数中硬编码路径或方法或超时 / 同项目多 HTTP 客户端 / 跳过 Zod 校验 / 通知封装外用底层 Toast。

---

# 第 10 章　性能

## 10.1 原则

- **R-10.1.1** 性能改动 MUST 以可度量指标为依据；MUST 附前后对比数据（首屏时间/TTI/关键响应/产物体积/内存至少一项）。
- **R-10.1.2** 性能与可读性/可维护性冲突时 MUST 优先可读性。
- **R-10.1.3** 性能优化 MUST NOT 牺牲类型安全 / 安全边界 / 可访问性。

## 10.2 性能预算（登记于 `docs/performance-budget.md`）

- 首屏冷启动/热启动时间上限、路由切换平均耗时、关键业务操作端到端响应、打包产物总体积（gzip）、单 chunk 体积上限、运行时常驻内存上限。
- **R-10.2.1** 任一指标回归 >10% MUST 在 PR 说明原因与补偿；连续两版本 MUST 立项整改。
- **R-10.2.2** CI MUST 集成 `size-limit` 或等效，超预算直接失败。

## 10.3 路由 / 页面

- **R-10.3.1** 路由页面 MUST 动态 `import()`；MUST NOT 同步 import。
- **R-10.3.2** 首屏路由 MUST 显式标识；MAY 预加载依赖。
- **R-10.3.3** 非首屏路由 MUST NOT 启动阶段预加载。
- **R-10.3.4** 路由切换 MUST 有加载态反馈。
- **R-10.3.5** 懒加载 chunk 命名 MUST 稳定。

## 10.4 组件优化

- **R-10.4.1** 大型业务组件（富文本/图表/代码编辑器/地图）MUST 动态 `import()`。
- **R-10.4.2** `defineAsyncComponent` MUST 统一提供 `loadingComponent` + `errorComponent`。
- **R-10.4.3** 重计算 MUST 放 `computed`。
- **R-10.4.4** 高频渲染组件 MUST 用 `v-memo` 或拆 props 减重渲染；MUST NOT 传递每渲染都变的新对象/函数引用；MUST NOT 模板内联对象/箭头函数作事件处理器。

## 10.5 响应式

- **R-10.5.1** 大规模只读数据 MUST `shallowRef` / `shallowReactive` / `markRaw`。
- **R-10.5.2** 第三方实例对象 MUST NOT 直接 `ref`/`reactive`。
- **R-10.5.3** `watch` MUST 显式指定依赖源。
- **R-10.5.4** 高频副作用 MUST 经 `useDebounce.ts` / `useThrottle.ts`。

## 10.6 长列表

- **R-10.6.1** 单次渲染 >100 条 MUST 使用虚拟滚动。
- **R-10.6.2** 虚拟列表 MUST 由 `components/business/` 统一封装。
- **R-10.6.3** 大表格 MUST 支持分页或无限滚动；MUST NOT 一次性全量。
- **R-10.6.4** 大数据量排序/筛选/搜索 MUST 放 Web Worker 或 Rust 侧。

## 10.7 资源

- **R-10.7.1** 图片优先 WebP/AVIF；MUST 提供宽高与 `loading="lazy"`。
- **R-10.7.2** 构建期 MUST 压缩图片。
- **R-10.7.3** 单图体积超预算 MUST 拆分或改矢量。
- **R-10.7.4** 字体 MUST 子集化；`font-display: swap`；自托管 MUST 启用缓存。
- **R-10.7.5** 图标 MUST 按需导入（`unplugin-icons` 或 SVG sprite）；MUST NOT 整包引入。
- **R-10.7.6** 单色图标 MUST 通过 `currentColor` 继承主题色。

## 10.8 打包

- **R-10.8.1** 公共依赖合并 `vendor-core`。
- **R-10.8.2** 按领域手动分包。
- **R-10.8.3** 分包 MUST 稳定，非破坏性改动 chunk 文件名不变。
- **R-10.8.4** MUST NOT 为消除告警盲目提高 `chunkSizeWarningLimit`。
- **R-10.8.5** Monaco 语言与 worker MUST 按需加载；worker MUST 走 Vite 原生 worker。

## 10.9 缓存

- **R-10.9.1** 静态资源文件名 MUST 带内容 hash。
- **R-10.9.2** 业务请求 MUST 区分「可缓存查询/实时查询」；可缓存进 `useQuery.ts`；实时查询 MUST NOT 进缓存层。
- **R-10.9.3** 页面生命周期内同请求 MUST 去重。

## 10.10 Tauri 桌面

- **R-10.10.1** Rust 耗时任务 MUST 异步化；MUST NOT IPC 命令同步阻塞。
- **R-10.10.2** 大体积数据 MUST 分片或事件流式下发。
- **R-10.10.3** 启动阶段 MUST NOT Rust 侧重初始化。
- **R-10.10.4** 窗口操作 MUST 60 FPS。

## 10.11 主题切换

- **R-10.11.1** MUST 单帧内完成。
- **R-10.11.2** MUST NOT 触发路由重载或大规模组件重建；MUST 依赖 CSS 变量响应而非 `key` 重置。

## 10.12 内存

- **R-10.12.1** 监听器/定时器/媒体查询/Tauri 订阅 MUST 在 `onScopeDispose` / `onBeforeUnmount` 显式清理。
- **R-10.12.2** 长生命周期对象 MUST NOT 持有组件实例引用。
- **R-10.12.3** `URL.createObjectURL` / Blob MUST `revokeObjectURL` 显式释放。
- **R-10.12.4** 周期性创建的 Worker/WebSocket/EventSource MUST 复用或关闭。

## 10.13 监控

- **R-10.13.1** 关键路径 MUST 埋点：应用启动、路由切换、主操作完成、错误发生率。
- **R-10.13.2** 度量数据 MUST 脱敏。
- **R-10.13.3** 生产 MUST 开启错误与性能监控；异常阈值 MUST 触告警并通知责任人。

## 10.14 MUST NOT（汇总）

- 路由表同步引入页面 / 长列表裸渲染 / 大第三方实例深度响应式 / 主线程重 CPU / 提高告警阈值掩盖体积 / 未压缩或未 hash 静态资源进入产物 / 未清理副作用 / 无对比数据的「性能优化」。

## 10.15 Enforcement

- `size-limit` + `dpdm` + `bundle-analyzer` 定期快照 + Lighthouse CI 或 RUM

---

# 第 11 章　测试

## 11.1 分层

- **Unit**（Vitest）：纯函数、composables、store、services 原子逻辑。
- **Component**（Vitest + `@vue/test-utils`）：单组件渲染/交互/事件。
- **E2E**（Playwright）：关键用户旅程、跨窗口 IPC、视觉回归。
- **R-11.1.1** 单测 MUST NOT 启动真实浏览器或完整应用。
- **R-11.1.2** E2E MUST NOT 覆盖可由单测验证的逻辑分支。
- **R-11.1.3** 一个测试文件 MUST 只属于一层。

## 11.2 覆盖率

- **R-11.2.1** 全局行/分支覆盖率下限 80%；核心域（services/store/鉴权/金额/权限）下限 90%。
- **R-11.2.2** 新增代码差分覆盖率 MUST ≥85%；CI 强制。
- **R-11.2.3** MUST NOT 通过删除测试或 `istanbul ignore` 降低覆盖率（豁免：PR 说明 + Code Owner 批准）。

## 11.3 命名与组织

- **R-11.3.1** 测试文件与被测同目录，命名 `xxx.spec.ts` 或 `xxx.test.ts`（全项目二选一保持一致）。
- **R-11.3.2** 用例描述「被测主语 + 行为 + 预期」三段式中文。
- **R-11.3.3** 同一被测单元用例 MUST 归入同一 `describe`。
- **R-11.3.4** fixtures MUST 放同目录 `__fixtures__/`。

## 11.4 可测性

- **R-11.4.1** services/store/composables 公共函数 MUST 可注入依赖。
- **R-11.4.2** MUST NOT 在被测代码直读 `Date.now()` / `Math.random()` / 真实定时器；MUST 经抽象或 Vitest fake timers。
- **R-11.4.3** MUST NOT 为测试 export 私有函数。

## 11.5 快照与视觉回归

- **R-11.5.1** 快照 MUST 仅用于稳定、低频变更结构。
- **R-11.5.2** MUST NOT 对完整 DOM 快照。
- **R-11.5.3** 视觉回归 MUST Playwright 截图比对；阈值/设备像素比/字体渲染 MUST 集中于 `playwright.config.ts`。

## 11.6 Tauri 测试

- **R-11.6.1** Rust 命令 MUST 配套 `#[cfg(test)]` 单测。
- **R-11.6.2** Rust 测试 MUST NOT 依赖真实文件系统；MUST `tempfile` 或内存抽象。
- **R-11.6.3** 跨语言契约（Zod schema ↔ serde 结构）MUST 有往返序列化测试。

## 11.7 MUST NOT（汇总）

- `skip`/`only`/`xit` 进主干 / 关闭失败用例让 CI 通过 / 真实后端或 IPC 或数据库 / 覆盖率下降的 PR 合入 / 测试即实现镜像。

## 11.8 Enforcement

- `vitest run --coverage` + `@codecov/coverage-action` 或等效差分覆盖率检查

---

# 第 12 章　Git 与提交

## 12.1 分支模型（trunk-based）

- `main`（永久稳定可发布）；`release/x.y`（版本维护）；短期分支 `feat/*` `fix/*` `chore/*` `docs/*` `refactor/*` `perf/*`。
- **R-12.1.1** 功能分支 MUST 从最新 `main` 切出并定期同步。
- **R-12.1.2** MUST NOT 直接向 `main` 推送。
- **R-12.1.3** 分支名 MUST kebab-case。

## 12.2 提交信息（Conventional Commits）

- 格式：`<type>(<scope>): <subject>` + 空行 + body + 空行 + footer。
- `type` ∈ { feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert }。
- **R-12.2.1** `scope` MUST 填写。
- **R-12.2.2** `subject` MUST 中文祈使句，≤50 字，句尾无句号。
- **R-12.2.3** 破坏性变更 MUST footer `BREAKING CHANGE:` + 迁移方式。
- **R-12.2.4** MUST 关联 issue：`Refs: #123` 或 `Closes: #123`。

## 12.3 PR

- **R-12.3.1** PR 描述 MUST 含：背景/方案/影响面/验证方式/回滚方案。
- **R-12.3.2** 单 PR SHOULD ≤400 行 diff。
- **R-12.3.3** PR MUST ≥1 位 Code Owner 批准；安全/权限/主题/发布流程 MUST ≥2 位。
- **R-12.3.4** 合入方式 MUST squash merge。
- **R-12.3.5** MUST NOT 「凑数 PR」或「TODO PR」；未完成功能 MUST 走 feature flag。

## 12.4 Code Review

- **R-12.4.1** 作者 MUST 自审后再请求评审。
- **R-12.4.2** 评审意见分级：`must` / `should` / `nit` / `question`；`must` 未解决 MUST NOT 合入。
- **R-12.4.3** MUST NOT 人身攻击或情绪化表达。
- **R-12.4.4** 首次响应 SHOULD ≤48 小时。

## 12.5 Hooks

- `pre-commit`: lint-staged（ESLint + Prettier + `vue-tsc` 影响范围）。
- `commit-msg`: commitlint。
- `pre-push`: typecheck + 影响范围单测。
- **R-12.5.1** MUST NOT 使用 `--no-verify` 绕过 hooks。

## 12.6 MUST NOT（汇总）

- 直推 `main`/`release/*` / force push 共享分支 / 大二进制提交 / `.env.local` 、密钥、IDE 配置进仓库 / `--no-verify` / 未 squash 合入 `main`。

## 12.7 Enforcement

- `husky` + `lint-staged` + `commitlint`；GitHub branch protection + required reviewers + status checks；`gitleaks` pre-commit + CI。

---

# 第 13 章　CI/CD 与发布

## 13.1 流水线（顺序严格，失败即阻断）

1. **install** `pnpm install --frozen-lockfile`
2. **lint** ESLint + Prettier + commitlint
3. **typecheck** `vue-tsc --noEmit` + `cargo check`
4. **test** 单测 + 组件测 + 差分覆盖率
5. **build** `vite build` + `cargo build` + `size-limit` + `dpdm`
6. **e2e** Playwright（PR 触发或定时）
7. **security** `pnpm audit` + `cargo audit` + `gitleaks` + SAST（可选）
8. **package** 多平台产物 + OS 签名
9. **release** tag 触发：上传产物 + release notes + 更新 manifest
- **R-13.1.1** MUST NOT 「仅警告不阻断」。
- **R-13.1.2** MUST NOT 手工 override 必需检查。

## 13.2 缓存

- **R-13.2.1** `pnpm store` / `node_modules` / `~/.cargo` / `target/` MUST 持久化缓存，key 为 lock hash。
- **R-13.2.2** 缓存失效 MUST 自动回退冷构建。
- **R-13.2.3** 缓存命中率连续两周 <60% MUST 排查。

## 13.3 版本号

- **R-13.3.1** 遵 SemVer。
- **R-13.3.2** 根 `package.json` 版本为主源；`tauri.conf.json` / `Cargo.toml` MUST 同步；CI 校验。
- **R-13.3.3** 变更日志 MUST 自动生成（`changesets` 或 `conventional-changelog`）；MUST NOT 手工维护历史条目。
- **R-13.3.4** 每次发布 MUST 打 Git tag `vX.Y.Z` 并 GPG/SSH 签名。
- **R-13.3.5** 预发布 MUST `-rc.N` / `-beta.N` 后缀；MUST NOT 无后缀的非稳定版本流入用户渠道。

## 13.4 签名

- **R-13.4.1** 桌面产物 MUST OS 签名：Windows=Authenticode；macOS=Developer ID + notarization；Linux=发布者签名。
- **R-13.4.2** updater manifest MUST Tauri updater 签名；私钥 MUST 仅存 CI 安全存储。
- **R-13.4.3** CI MUST 在发布阶段校验产物签名有效。

## 13.5 环境

- **R-13.5.1** 至少三套 `dev` / `staging` / `prod`。
- **R-13.5.2** 环境差异 MUST 通过环境变量注入；MUST NOT 分支差异或 `if (env === 'prod')` 散落处理。
- **R-13.5.3** 生产配置变更 MUST 经审批；密钥 MUST NOT 输出到日志。
- **R-13.5.4** 环境变量清单 MUST 登记于 `docs/env-vars.md`；未登记 MUST NOT 使用。

## 13.6 回滚

- **R-13.6.1** 每版本 MUST 具备 30 分钟内可执行的回滚方案（脚本 + 前一稳定版本制品保留 + 用户侧回滚通道）。
- **R-13.6.2** P0/P1 响应流程 MUST 明确于 `docs/incident-runbook.md`。
- **R-13.6.3** 事故复盘 MUST 5 工作日内完成；MUST blameless postmortem + 改进项追踪到关闭。

## 13.7 MUST NOT（汇总）

- 仅警告不阻断 / 日志打印密钥 / 未签名产物流入用户 / 版本号跨文件不一致 / 绕过审批发布 / 生产依赖 `latest`/`next`/分支。

## 13.8 Enforcement

- GitHub Actions / GitLab CI workflows + `scripts/check-versions.ts` + 产物签名校验脚本

---

# 第 14 章　可观测性

## 14.1 日志

- **R-14.1.1** 前端/Rust MUST 结构化 JSON 日志；MUST NOT 拼接无结构字符串。
- **R-14.1.2** 字段至少：`timestamp` `level` `scope` `event` `traceId`；附加字段 MUST 登记 `docs/observability.md`。
- **R-14.1.3** 级别：`error`（需人介入）/ `warn`（可恢复或不合预期）/ `info`（关键里程碑）/ `debug`（仅 dev）。
- **R-14.1.4** MUST NOT 输出敏感字段；MUST 在统一封装层脱敏 + 白名单过滤。
- **R-14.1.5** MUST NOT 业务代码直接 `console.log` / `println!`。

## 14.2 错误上报

- **R-14.2.1** MUST 集成统一错误监控（Sentry 或等效）。
- **R-14.2.2** 范围：未捕获异常 / `unhandledrejection` / Vue `errorHandler` / Router 错误 / services 归一化 `AppError` / Rust panic。
- **R-14.2.3** 上报 MUST 携带版本号 + 用户匿名 ID + `traceId`。
- **R-14.2.4** MUST 支持采样与脱敏；采样率登记 `docs/observability.md`。
- **R-14.2.5** 上报 MUST NOT 阻塞主流程；失败 MUST 静默降级。

## 14.3 RUM

- **R-14.3.1** MUST 上报：冷启动耗时、首屏 TTI、路由切换耗时、关键操作 P95、JS 堆内存水位。
- **R-14.3.2** 上报通道 MUST 复用错误上报基础设施。
- **R-14.3.3** 面板链接与责任人 MUST 登记 `docs/observability.md`。
- **R-14.3.4** 指标回归 >预算 10% MUST 触告警并指派责任人。

## 14.4 TraceId

- **R-14.4.1** 每次前端请求/IPC MUST 在 services 层生成 UUIDv4 或 ULID。
- **R-14.4.2** `traceId` MUST 通过 `X-Trace-Id` 请求头或事件字段贯穿前端/Rust/后端。
- **R-14.4.3** 日志与错误上报 MUST 携 `traceId`。

## 14.5 审计日志

- **R-14.5.1** 权限/配置/敏感操作事件 MUST 写入审计日志，与运行日志分离。
- **R-14.5.2** 审计日志 MUST：保留 ≥180 天（按合规调整）/ 追加写入不可就地更新 / 访问受控（仅安全/运维可读）。
- **R-14.5.3** 审计事件清单 MUST 维护于 `docs/audit-events.md`。

## 14.6 MUST NOT（汇总）

- 敏感数据入日志或上报 / 生产开 `debug` / 业务代码绕过统一封装 / 审计与运行日志同存储 / 上报阻塞主流程。

---

# 第 15 章　i18n / a11y

## 15.1 i18n

- **R-15.1.1** 即使当前仅中文，代码 MUST 按可国际化结构组织；MUST NOT 组件内硬编码用户可见文案。
- **R-15.1.2** MUST 使用 `vue-i18n`（或统一选型），语言包放 `src/locales/<lang>/<domain>.json`。
- **R-15.1.3** 文案 key MUST 层级命名 `domain.subdomain.key`；MUST NOT 以文案内容作 key。
- **R-15.1.4** 复数/日期/数字/货币 MUST 通过 i18n 格式化 API；MUST NOT 手拼。
- **R-15.1.5** 语言切换 MUST 无刷新；偏好 MUST 持久化于 `useLocaleStore`，与主题 store 解耦。

## 15.2 文案

- **R-15.2.1** 文案 MUST 经产品/文案审核。
- **R-15.2.2** 错误消息 MUST 面向用户可读；MUST NOT 将技术异常暴露给用户（技术细节仅入日志）。
- **R-15.2.3** 占位符 MUST 命名变量 `{userName}`；MUST NOT 位置变量 `{0}`。
- **R-15.2.4** 中英文混排：中英文之间 MUST 加半角空格；数字与中文之间 MUST 加半角空格。

## 15.3 a11y

- **R-15.3.1** 所有交互元素 MUST 可键盘操作：Tab 序正确、Enter/Space 触发、Esc 关闭浮层。
- **R-15.3.2** 非装饰性图标/图片 MUST `alt` 或 `aria-label`。
- **R-15.3.3** 对比度遵 WCAG 2.1 AA：正文 ≥4.5:1，大字号 ≥3:1；主题调整 MUST 经对比度校验工具。
- **R-15.3.4** 浮层 MUST 管理焦点陷阱与焦点恢复；Shadcn 自带能力 MUST NOT 被覆盖。
- **R-15.3.5** 动效 MUST 尊重 `prefers-reduced-motion`，大幅动画 MUST 禁用或弱化。
- **R-15.3.6** 表单字段 MUST 有可编程可读 label 关联；错误提示 MUST 通过 `aria-describedby` 关联。

## 15.4 MUST NOT（汇总）

- 组件硬编码用户可见文案 / 以文案内容作 i18n key / 对比度不足的配色合入主题 / 破坏键盘可操作性 / 忽略 `prefers-reduced-motion` / 把技术异常直接展示给最终用户。

## 15.5 Enforcement

- `axe-core` 自动化 a11y；`eslint-plugin-vuejs-accessibility`；`scripts/check-i18n-keys.ts`

---

# 第 16 章　供应链安全

## 16.1 准入

- **R-16.1.1** 新依赖 MUST 评估：维护活跃度/下载量/许可证/体积/替代方案；结论 MUST 写入 PR 描述。
- **R-16.1.2** MUST NOT 引入许可证不兼容依赖（GPL 家族默认不兼容，需用 MUST 经法务评审）。
- **R-16.1.3** MUST NOT 引入单人维护且 12 个月无更新的关键路径依赖。
- **R-16.1.4** 新运行时依赖 MUST 经 Code Owner 审批；devDependency 可适当放宽。

## 16.2 漏洞 SLA

- critical: 24h 内修复或缓解
- high: 7d 内修复
- medium: 30d 内按迭代修复
- low: 下一大版本修复
- **R-16.2.1** CI MUST 集成 `pnpm audit` 与 `cargo audit`；high/critical 直接失败。
- **R-16.2.2** 无法即时修复 MUST 登记 `docs/security-exceptions.md`（缓解措施 + 到期日期），到期自动重评。

## 16.3 SBOM 与锁定

- **R-16.3.1** 每次发布 MUST 生成 SBOM（CycloneDX 或 SPDX），随产物归档。
- **R-16.3.2** `pnpm-lock.yaml` / `Cargo.lock` MUST 提交；生产构建 MUST 锁定依赖。
- **R-16.3.3** 私有仓库/镜像源 MUST 在 `.npmrc` / `.cargo/config.toml` 显式声明；MUST NOT 临时切源。
- **R-16.3.4** MUST NOT 删除 lock 中 integrity hash。

## 16.4 密钥

- **R-16.4.1** MUST NOT 任何密钥/令牌/证书进仓库（含历史）。
- **R-16.4.2** 提交前 MUST `gitleaks` 扫描；CI MUST 再扫兜底。
- **R-16.4.3** 发现泄露 MUST 立即吊销并轮换，轮换完成前相关服务 MUST 停用；事件 MUST 记入 `docs/incident-log.md`。
- **R-16.4.4** 历史泄露 MUST `git filter-repo` 或 BFG 清理；MUST NOT 仅用新 commit 覆盖。

## 16.5 MUST NOT（汇总）

- 未评审新依赖 / 带未缓解 high/critical 漏洞版本发布 / 密钥进仓库 / lock 缺失或不一致构建产物发布 / 绕过统一依赖源 / `npm`+`yarn`+`pnpm` 混用多份 lock。

## 16.6 Enforcement

- `pnpm audit` / `cargo audit`（CI）+ `gitleaks`（pre-commit + CI）+ SBOM 生成脚本。

---

# 第 17 章　文档

## 17.1 分层

```
docs/
  architecture/              # ADR、系统图、数据流
  guides/                    # 开发者上手、主题扩展、IPC 扩展
  api/                       # 对外接口与 IPC 契约（可自动生成）
  runbook/                   # 运维手册、故障响应、回滚
  tech-debt.md
  security-exceptions.md
  performance-budget.md
  observability.md
  env-vars.md
  audit-events.md
  incident-runbook.md
  incident-log.md
```

## 17.2 ADR

- **R-17.2.1** 跨模块重要决策 MUST 沉淀为 ADR，命名 `ADR-YYYYMMDD-<slug>.md`。
- **R-17.2.2** ADR 模板 MUST 含：背景/决策/考虑的备选/影响/相关链接/状态（`proposed`/`accepted`/`superseded`）。
- **R-17.2.3** `accepted` ADR MUST NOT 就地重写；推翻 MUST 新增 ADR 并在旧标 `superseded by`。
- **R-17.2.4** 偏离 SSoT 的决策 MUST 以 ADR 形式沉淀；MUST NOT 仅存 PR 描述。

## 17.3 代码注释

- **R-17.3.1** 公共 API（导出的函数/类/类型/store/composable/service）MUST 配 TSDoc/JSDoc：用途、参数、返回值、错误、示例。
- **R-17.3.2** 复杂算法/非直观业务规则 MUST 写「为什么」而非「做什么」。
- **R-17.3.3** 注释与实现不一致 MUST 视为 bug 修复。
- **R-17.3.4** MUST NOT 用注释掉的代码替代删除。
- **R-17.3.5** `TODO`/`FIXME` MUST 带责任人 + 截止日期：`// TODO(xiaojianc, 2026-06-01): 替换为流式接口`。

## 17.4 README

- **R-17.4.1** 仓库根 `README.md` MUST 含：项目简介/技术栈与版本基线摘要/快速上手/开发脚本/目录结构/贡献指南链接/许可证。
- **R-17.4.2** 独立可运行子模块 MUST 有自己的 README。
- **R-17.4.3** README 与本 SSoT 冲突时 MUST 以本文件为准并同步修正。

## 17.5 变更记录

- **R-17.5.1** `CHANGELOG.md` MUST 由 CI 从 Conventional Commits 自动生成。
- **R-17.5.2** 面向开发者的重要变更 MUST 补 ADR 或更新本 SSoT，并在提交说明中标注。

## 17.6 MUST NOT（汇总）

- 关键决策仅存聊天/口头 / ADR 就地重写 `accepted` 历史 / 公共 API 无 TSDoc 合入 / 注释与代码不一致 / 注释掉的代码替代删除 / `TODO`/`FIXME` 无责任人无截止日期。

---

## 附录 A　规则索引（按主题）

- **安全**：R-7.*（Tauri）、R-14.1.4、R-14.5.*、R-16.4.*、R-13.4.*
- **类型系统**：R-3.1.*、R-3.2.*、R-3.8.*、R-7.2.2
- **依赖方向**：R-1.2.*、R-2.1.14、R-9.1.1
- **主题与样式**：R-5.*、R-6.5.*、R-2.1.12
- **性能**：R-10.*、R-4.8.*、R-4.5.2
- **测试**：R-11.*、R-2.4.*、R-7.3.5、R-11.6.3
- **CI/CD**：R-13.*、R-0.2.6、R-12.5.1
- **i18n/a11y**：R-15.*、R-5.7.1
- **供应链**：R-16.*、R-0.2.2
- **文档与决策**：R-17.*、R-0.2.3
- **架构守护（反腐 / 防腐）**：R-20.1.*、R-20.2.*、R-20.3.*、R-20.4.*、R-20.5.*、R-20.6.*、R-18.11.*
- **结构债治理**：R-20.7.*、R-20.8.*、R-17.3.4、R-17.3.5
- **关键模块覆盖率**：R-20.9.*、R-11.2.*

## 附录 B　合入 DoD 自检清单（AI 模板）

AI 在提交 PR 前 MUST 逐项自检，标记 ✅ / ❌ / N/A：

- [ ]  四件套本地通过：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build`
- [ ]  所有新增/变更代码遵循对应章节规则，违规条目已以 ADR 登记或已修复
- [ ]  涉及外部输入的代码均有 Zod 或等效运行时校验（R-3.2.2、R-7.2.2、R-9.2.3）
- [ ]  新增 IPC 命令已同步更新 `src-tauri/capabilities/` 能力清单（R-7.4.3）
- [ ]  新增 `VITE_*` 已登记 `src/types/env.d.ts`（R-4.3.2）
- [ ]  新增环境变量已登记 `docs/env-vars.md`（R-13.5.4）
- [ ]  新增审计事件已登记 `docs/audit-events.md`（R-14.5.3）
- [ ]  新增公共 API 有 TSDoc（R-17.3.1）
- [ ]  提交信息符合 Conventional Commits 且 `scope` 非空（R-12.2.1 ～ R-12.2.4）
- [ ]  PR 描述含：背景/方案/影响面/验证方式/回滚方案（R-12.3.1）
- [ ]  性能相关改动附前后对比数据（R-10.1.1）
- [ ]  新增/变更代码差分覆盖率 ≥85%（R-11.2.2）
- [ ]  无密钥/敏感数据进入代码或日志（R-7.7.*、R-14.1.4、R-16.4.1）
- [ ]  无 `any`/`@ts-ignore`/非空断言 `!` 无说明（R-3.2.1、R-3.9.3）
- [ ]  无 `--no-verify` / `--no-frozen-lockfile`（G-4、R-12.5.1）
- [ ]  新增依赖已评估 + 审批（R-16.1.*）
- [ ]  偏离本 SSoT 的条款已在 PR 描述中引用 ADR ID 并获 Code Owner 批准
- [ ]  视图层未直接 import 多个业务 store（R-18.11.1）
- [ ]  未新建第二个 xterm / Monaco 实例（R-18.3.1、R-18.4.1）
- [ ]  未通过 shell 调用 `git` 命令（R-18.7.1）
- [ ]  未通过 `@tauri-apps/plugin-fs` 直接读写任意路径（R-18.8.2）
- [ ]  视图层未内联跨域编排逻辑（`<script setup>` ≤120 行、业务分支 ≤3 处）（R-20.1.1、R-20.1.4）
- [ ]  `useWorkbench.ts` 单文件 ≤400 行，且未在 façade 内内联细节实现（R-20.1.2、R-20.1.3）
- [ ]  终端域无模块级可变共享状态，会话经 registry 暴露并可注入 fake（R-20.2.1、R-20.2.2、R-20.2.6）
- [ ]  主题派生有唯一原点；终端配色来自 `ResolvedTheme.terminal`；store 未直接写 `document` 变量（R-20.3.1、R-20.3.2、R-20.3.3）
- [ ]  新增 / 变更 IPC 命令同时具备入参与出参 Zod schema、超时、取消、错误归一化、结构化日志（R-20.4.1）
- [ ]  Rust 返回值经 `safeParse` 后再进入 store；无 `as TType` 绕过（R-20.4.2、R-20.4.3）
- [ ]  `services/tauri.ts` 未泄漏 `snake_case` 字段到上层（R-20.4.5）
- [ ]  `commands/mod.rs` 未内联命令实现且 ≤80 行；每个命令模块 ≤300 行（R-20.5.1、R-20.5.3）
- [ ]  新增命令模块已同步新建 `src-tauri/capabilities/` 对应 capability 文件（R-20.5.8、R-18.12.5）
- [ ]  启动 splash 未同时存在命令式 DOM 与 Vue 双实现；`main.ts` 内联 DOM ≤120 行（R-20.6.1、R-20.6.3）
- [ ]  新增 / 变更目录含 `MATURITY.md` 且与第 19 章 Green / Yellow / Red 同步（R-20.7.1、R-20.7.2）
- [ ]  `yellow` / `red` 模块 UI 入口有明确成熟度标识；`red` 不进入生产可见路径（R-20.7.3、R-20.7.4）
- [ ]  无死代码 / 悬空配置引用（通过 `check-config-refs.ts` / `check-dead-imports.ts` / `check-dormant-modules.ts`）（R-20.8.1、R-20.8.3、R-20.8.6）
- [ ]  关键模块（终端 / 结构化运行报告 / Shell 补全 / Git diff / 主题合成 / façade）差分覆盖率 ≥90%（R-20.9.1、R-20.9.8）
- [ ]  新增启发式规则 / 状态机转移 / 补全分支已配对应 fixture 或用例（R-20.9.2 ～ R-20.9.5、R-20.9.7）

<aside>
✅

以上全部满足后方可合入 `main`。AI 自检未通过的条目 MUST 在 PR 描述中显式声明「未满足 + 原因 + 计划」，交由人类 Code Owner 决定是否豁免。

</aside>

---

# 第 18 章　桌面 Shell IDE 特化规则（项目现状适配）

<aside>
🖥️

本章针对本仓库「单窗口、单工作台的桌面 Shell 脚本 IDE」这一形态做特化约束，与前 17 章通用规则并行生效；二者冲突时 MUST 以本章为准，并 MUST 在 PR 描述中引用具体规则 ID。本章是对前述规则的补充与收口，不是替代。

</aside>

## 18.1 窗口与启动生命周期

- **R-18.1.1** 应用 MUST 采用「透明欢迎窗 → bootstrap splash → 主窗口 → 工作台挂载」四阶段启动；Vue 挂载前 MUST NOT 阻塞渲染除主题注入与运行时错误处理器注册外的任何步骤。
- **R-18.1.2** 窗口阶段切换 MUST 由 Rust `apply_window_stage` 统一驱动；前端 MUST NOT 直接调用 `WebviewWindow.setDecorations` / `show` / `hide` / `setSize` 改变阶段。
- **R-18.1.3** Splash / bootstrap DOM MUST 在工作台首帧后同帧移除；MUST NOT 用 `setTimeout` 猜测时机；MUST NOT 在移除前播放长于 200ms 的动画。
- **R-18.1.4** 运行时错误覆盖层 MUST 在 `main.ts` 最早期就绪；Vue 未挂载前的错误 MUST 能被捕获并呈现给用户。
- **R-18.1.5** `App.vue` MUST 是窗口生命周期的唯一协调器；组件内部 MUST NOT 监听 `Tauri://window` 原生事件去改变工作台挂载状态。

## 18.2 路由策略（当前形态）

- **R-18.2.1** 当前运行时 MAY 在受限启动路径中注册 Vue Router（仅 `welcome` / `home`）；`App.vue` MUST 作为窗口与工作台编排的唯一协调器。
- **R-18.2.2** `src/router/` MUST 在顶部 README 明示当前状态与边界（active/dormant、允许路由范围、关联 ADR）；业务代码 MUST NOT 在未评审情况下扩展业务路由。
- **R-18.2.3** 若扩大路由职责（超出欢迎页启动过渡）MUST 走 ADR；启用或扩容路由后 `ShellWorkbenchView.vue` MUST 同步拆解聚合职责，MUST NOT 简单套一层 `<RouterView>` 了事。
- **R-18.2.4** 通用规则 R-10.3.*（路由级性能）在当前受限路由形态下部分适用：欢迎页与工作台路由切换 MUST 满足预算与观测要求。

## 18.3 Monaco 编辑器

- **R-18.3.1** Monaco 实例生命周期 MUST 在 `ScriptEditor.vue` 内完整闭环：创建 / 模型绑定 / 主题订阅 / dispose；MUST NOT 跨组件泄漏 `editor` / `model` / `IDisposable`。
- **R-18.3.2** Monaco 主题 MUST 由 `themes/manager.ts` 统一注入并热更新；组件 MUST NOT 直调 `monaco.editor.defineTheme` / `setTheme`。
- **R-18.3.3** Worker 与语言包 MUST 按需加载；MUST NOT 静态 `import 'monaco-editor'` 全量入口；MUST NOT 在启动阶段加载非 Shell 相关语言。
- **R-18.3.4** 光标、选择、滚动位置、折叠态等编辑器会话态 MUST 随 tab 持久化于 `editor.ts` store；切换 tab MUST 无视觉抖动。
- **R-18.3.5** Marker / gutter 装饰 MUST 通过统一 decoration collection 按来源（shellcheck / git / search / symbol）分桶管理；MUST NOT 直接 `deltaDecorations` 操作裸 id 数组。
- **R-18.3.6** Monaco 的 `dispose` MUST 在 `onScopeDispose` 内成对调用；测试 MUST 验证反复挂载 / 卸载不泄漏 `IDisposable`。

## 18.4 集成终端（xterm + Rust PTY）

- **R-18.4.1** xterm 会话 MUST 为应用级单例，由 `useIntegratedTerminal.ts` 托管；业务组件 MUST NOT 新建 `Terminal` 实例。
- **R-18.4.2** PTY 数据流 MUST 通过 Tauri 事件单向下发；前端 MUST NOT 尝试同步读取终端缓冲；MUST NOT 轮询 PTY 状态。
- **R-18.4.3** `ensure_terminal_session` / `dispatch_script_to_terminal` / `write_terminal_input` / `resize_terminal_session` / `close_terminal_session` MUST 是前端进入终端的唯一入口；MUST 经 `services/tauri.ts` 收口。
- **R-18.4.4** 终端尺寸变化 MUST 经 fit addon + Rust `resize` 双向同步；window resize MUST 防抖 ≥100ms。
- **R-18.4.5** 会话关闭 MUST 释放 Rust PTY 资源；前端 `onScopeDispose` MUST 调用 `close_terminal_session`；Rust 侧 MUST 保证幂等。
- **R-18.4.6** 终端输出 MUST 同时写入结构化运行日志（structured run log）；MUST NOT 仅保留 xterm 缓冲作为唯一记录来源。
- **R-18.4.7** ANSI 控制序列 MUST 由 xterm 渲染；MUST NOT 在写入前手动剥除或重写控制字符（诊断摘要场景除外，需走独立管线）。

## 18.5 ShellCheck 诊断

- **R-18.5.1** ShellCheck 调用 MUST 由 Rust `analyze_script` 统一承担；前端 MUST NOT 内置 ShellCheck 规则判断逻辑。
- **R-18.5.2** 诊断触发 MUST 防抖（SHOULD ≥300ms）；保存事件 MUST 立刻触发一次终稿分析；关闭 tab MUST 清空关联诊断。
- **R-18.5.3** ShellCheck 中文消息 MUST 由 `Messages_zh.json` 资源注入；MUST NOT 在业务代码硬编码诊断文案翻译。
- **R-18.5.4** 诊断结果 MUST 写入 `editor.ts` store 的激活文档；`DiagnosticsPanel.vue` MUST 只做消费，MUST NOT 重复触发分析。
- **R-18.5.5** 未安装 ShellCheck 的环境 MUST 降级为「可编辑但不报诊断」，并在状态栏给出引导；MUST NOT 静默吞错、MUST NOT 用空诊断冒充通过。
- **R-18.5.6** 诊断状态 MUST 三态：`pending` / `ok` / `issues`；UI MUST 明确区分「未开始」与「已通过」。

## 18.6 脚本格式化与补全

- **R-18.6.1** 格式化 MUST 由 Rust `format_script`（shfmt）承担；失败 MUST 归一化为 `AppError`，前端 MUST NOT 将原始 stderr 直接呈现给用户。
- **R-18.6.2** Tree-sitter Bash 解析结果 MUST 缓存于 `shell-completion.ts`；补全候选 MUST 合并「本地命令目录 / 内置关键字 / 当前文档符号」三源，去重后按优先级排序。
- **R-18.6.3** 命令目录 JSON MUST 由 `generate-shell-command-catalog.mjs` 生成；MUST NOT 手工编辑生成产物；目录体积超阈值 MUST 分片并按需加载。
- **R-18.6.4** 补全检索 MUST 惰性加载分片 JSON；首屏 MUST NOT 拉取全量目录。
- **R-18.6.5** 保存时格式化（`format on save`）MUST 可配置，默认开启；格式化失败 MUST NOT 阻塞保存，但 MUST 高亮告警。

## 18.7 Git 集成

- **R-18.7.1** Git 状态 / 基线 / 暂存 / 提交 MUST 由 Rust `git.rs` 承担；前端 MUST NOT 通过 shell / 子进程调用 `git` 命令。
- **R-18.7.2** `git.ts` store MUST 是唯一缓存层；`SourceControlPanel.vue` 与 `git-diff.ts` MUST 通过 store 读取，MUST NOT 直接触发 Tauri 命令旁路。
- **R-18.7.3** gutter diff 装饰 MUST 在编辑器 model 变更或基线失效时重算；MUST NOT 保留过期装饰；切换分支 MUST 重建全部基线。
- **R-18.7.4** stage / unstage / commit MUST 在 action 内原子执行；失败 MUST 回滚 UI 乐观状态；网络或 IO 错误 MUST 归一化为 `AppError`。
- **R-18.7.5** 大仓库（>10k 文件）状态查询 MUST 分页或惰性；MUST NOT 一次性拉全量 status。
- **R-18.7.6** 提交信息 MUST 遵 R-12.2（Conventional Commits）；UI MUST 提供校验而非静默提交。

## 18.8 工作区与文件

- **R-18.8.1** 工作区根路径 MUST 经 Rust 校验（存在性、可读性、非系统保护目录）后写入 store；前端 MUST NOT 持久化未经校验的用户输入路径。
- **R-18.8.2** 文件读写 MUST 仅通过 `load_script` / `save_script` / `list_workspace_entries` / `load_image_asset`；MUST NOT 使用 `@tauri-apps/plugin-fs` 直接读写任意路径。
- **R-18.8.3** 打开文件 tab 数 SHOULD ≤30，超出 MUST 给出提示并阻止新开；避免编辑器实例过多导致内存膨胀。
- **R-18.8.4** 文件 watch / 外部变更通知 MUST 经 Rust 事件下发；前端 MUST NOT 用轮询检测文件变化。
- **R-18.8.5** 二进制 / 大文件（>4MB）MUST 拒绝以文本模式打开；图片资源 MUST 走 `ImageAssetPreview.vue`。

## 18.9 主题双层系统

- **R-18.9.1** 基础主题（light / dark / system）MUST 由 `themes/manager.ts` 管理；用户覆盖层（强调色 / 圆角 / 界面密度 / 字号 / 字体族）MUST 由 `store/app.ts` 管理。
- **R-18.9.2** 两层 MUST 单向合成：基础变体 → 覆盖层 → `document.documentElement` CSS 变量；组件内 MUST NOT 自行合成或回落到硬编码变量。
- **R-18.9.3** Monaco / xterm 派生主题 MUST 同时订阅基础变体与覆盖层并一起刷新；MUST NOT 只订阅其一导致视觉割裂。
- **R-18.9.4** 首屏主题 MUST 在 Vue 挂载前同步注入；MUST NOT 出现 FOUC 或主题闪烁；`index.html` 的内联主题脚本是 R-6.5.12 允许的唯一例外。
- **R-18.9.5** 覆盖层持久化字段 MUST 精确枚举于 `useAppStore` 的 `persist.paths`；MUST NOT 全量持久化设置对象。
- **R-18.9.6** 主题切换时 Monaco marker / xterm buffer MUST 无闪烁；切换 MUST NOT 触发文档重载或 tab 销毁。

## 18.10 搜索与索引（演进中）

- **R-18.10.1** 文件名 / 路径搜索已就绪，MUST 保持 O(文件数) 时间复杂度；候选集 >5000 条 MUST 放入 Web Worker 处理。
- **R-18.10.2** 符号搜索 MUST 基于 Tree-sitter AST；启用前 MUST 走 ADR 说明索引策略、失效策略、内存上限。
- **R-18.10.3** 内容搜索 MUST 由 Rust 侧实现（ripgrep 或等效）；MUST NOT 在 Node / 浏览器侧全量 grep。
- **R-18.10.4** 搜索面板中未接入能力 MUST 显式标注「规划中 / Coming soon」；MUST NOT 用空结果冒充完成状态。
- **R-18.10.5** 搜索结果 MUST 可跳转到编辑器对应行列；跳转 MUST 走 `useWorkbench.openFile(path, { selection })`。

## 18.11 工作台 façade（`useWorkbench.ts`）

- **R-18.11.1** `useWorkbench` MUST 是 `ShellWorkbenchView.vue` 与业务 store 之间的唯一 façade；视图层 MUST NOT 在同一文件内直接 import 超过一个业务 store（`useAppStore` / `useEditorStore` / `useGitStore`）。
- **R-18.11.2** façade 返回值 MUST 最小暴露；内部状态 MUST 用 `readonly` / `computed` 暴露给视图；MUST NOT 暴露裸 `ref` 让视图直写。
- **R-18.11.3** façade MUST 负责跨 store 协调（例：打开文件同时刷新 Git 基线、触发首次诊断、滚动位置恢复）；MUST NOT 把协调逻辑散落到组件。
- **R-18.11.4** façade 本体 MUST 可单元测试；MUST NOT 依赖真实 Tauri / 真实 Monaco / 真实 xterm；MUST 通过 service 依赖注入 mock。
- **R-18.11.5** façade 新增公开方法 MUST 含 TSDoc 与错误语义说明（成功 / 可恢复失败 / 致命失败）。

## 18.12 通用规则在本项目的适用性修订

- **R-18.12.1** R-9.2.*（HTTP 客户端）在当前无网络形态下 **N/A**；如未来引入 MUST 经 ADR 启用并补齐封装。在此之前，CI 的 HTTP 客户端检查 MUST 跳过。
- **R-18.12.2** R-10.3.*（路由级懒加载）在当前无路由形态下 **N/A**，替代约束为 R-18.3.3（Monaco 按需）与 R-18.11.*（façade）。
- **R-18.12.3** R-15.1.*（i18n 多语言）当前语言面仅 zh-CN；MUST 保持文案 key 化组织以便未来扩展，但 MUST NOT 为「占位」引入未实际使用的 locale 包。`Messages_zh.json` 是 ShellCheck 诊断消息资源，**不** 计入 i18n 语言包。
- **R-18.12.4** R-0.2.*（依赖基线）MUST 补齐以下包的精确版本并写入 0.1 Baseline：`monaco-editor`（已在表内）、`xterm`、`xterm-addon-fit`、`xterm-addon-web-links`、`tree-sitter`、`tree-sitter-bash`、`@tauri-apps/api`、`@tauri-apps/plugin-dialog`、`@tauri-apps/plugin-fs`、`@tauri-apps/plugin-shell`（若启用）。**下一次 ADR MUST 完成此补齐**。
- **R-18.12.5** R-7.4.*（Tauri 能力）MUST 对当前 5 组命令域（窗口 / 文件 / 脚本工具链 / 终端 / Git）分别维护 capability 清单；MUST NOT 单一能力文件授予跨域权限。

## 18.13 Enforcement

- ESLint `no-restricted-imports`：
    - 组件层（`components/**`、`views/**`、`layouts/**`）MUST NOT 直接 import `@tauri-apps/api/core`、`monaco-editor` 顶层、`xterm` 构造函数。
    - 视图层 MUST NOT 同文件 import 多于一个业务 store。
- `scripts/check-workbench-facade.ts`（新增）：扫描非 façade 处是否存在对 >1 业务 store 的直接 import，违规即 CI 失败。
- `scripts/check-router-disabled.ts`（新增）：若 `main.ts` 出现 `app.use(router)` 且未登记 ADR 即 CI 失败。
- `scripts/check-terminal-singleton.ts`（新增）：扫描 `new Terminal(` 出现位置，白名单仅 `composables/useIntegratedTerminal.ts`。
- `scripts/check-capabilities-domain.ts`（新增）：校验 `src-tauri/capabilities/` 按 5 组命令域拆分。
- CI 必检：`cargo test -p <tauri-crate> --lib`、`vitest run --coverage`、Playwright 桌面端冒烟（启动 / 打开脚本 / 保存 / 运行 / 关闭）。

---

# 第 19 章　功能路线图与已知缺口（非门禁）

<aside>
🗺️

本章 **不是** 合入门禁；它是产品与工程现状的「公开缺口清单」。缺口 MUST 登记此处或独立 issue，并 MUST 与 `docs/tech-debt.md` 交叉引用。AI 在提出新方案前 MUST 先读本章，避免重复提议已排期或已明确暂缓的能力。

</aside>

## 19.1 已就绪能力（Green）

- 单窗口工作台壳：标题栏、活动栏、侧栏、Tab、状态栏、设置覆盖层。
- 编辑：Monaco 实例、Shell 语言、主题热更新、光标 / 滚动持久化。
- 诊断：ShellCheck 实时分析、中文消息、状态栏提示、降级处理。
- 格式化：shfmt（Rust 侧）。
- 补全：Tree-sitter Bash + 命令目录 + 当前文档符号三源合并。
- 集成终端：xterm 单例 + Rust PTY + 结构化运行报告 + 时间线 UI。
- Git：仓库状态 / 基线 / stage / unstage / commit / gutter diff。
- 主题：light / dark / system + 用户覆盖层（强调色 / 圆角 / 密度 / 字号）。
- 搜索：文件名 / 路径搜索。

## 19.2 演进中 / 占位（Yellow）

- 符号搜索（基于 Tree-sitter AST）：UI 已占位，缺索引与失效策略 ADR。
- 全文内容搜索：需 Rust ripgrep 集成；UI 已占位。
- SSH 远程会话面板：当前仅 UI 骨架，无连接实现；启用前 MUST 完成 R-7.4.4 / R-7.7.* 安全评审。
- 运行配置持久化：需 ADR 明确配置 schema 与迁移策略。
- 脚本模板市场 / 共享：暂未立项。
- 监控与遥测（R-14.*）：当前纯本地运行，无上报基础设施；发布阶段 MUST 补齐 Sentry 或等效。
- Windows 外平台构建链（macOS / Linux）：当前 `run-tauri.mjs` 仅补齐 Windows MSVC 环境。

## 19.3 建议优先级（AI 处理新需求时参考）

1. **基线补齐（最紧急）**：完成 R-18.12.4 依赖基线 ADR，保证 `scripts/check-versions.ts` 门禁对核心包生效。
2. **内容搜索实装**：Rust + ripgrep 替换占位，让 `SearchSidebarPanel.vue` 从「Coming soon」进入 Green。
3. **façade 测试脚手架**：为 `useWorkbench` 抽出 mock 化单测模板，作为后续面板接入的范式。
4. **运行配置与模板持久化**：落到新增 `useRunStore`，统一「快速运行 / 历史 / 模板」三入口数据。
5. **SSH 面板启用前置**：安全评审 + capability 拆分 + `stronghold` / keyring 集成，**不能为演示临时放开**。
6. **遥测与监控下沉**：在发布流水线接入错误上报与 RUM；`docs/observability.md` MUST 先补齐字段与责任人。

## 19.4 非目标（明确暂缓）

- 多窗口 / 多工作台并行编辑。
- 浏览器端运行（PWA / 纯 Web）。
- 非 Shell 语言的一等公民支持（Python / JS 等）——只允许作为只读预览资产。
- 插件市场 / 扩展机制——未立项，任何相关提案 MUST 先走 RFC。

---

# 第 20 章　架构守护规则（反腐层 / 防腐约束）

<aside>
🛡️

本章针对当前仓库已识别的结构性不足与测试短板做 **反腐（anti-corruption）约束**，与 18 / 19 章并行生效。冲突优先级：R-20.* > R-18.* > 通用章节。违反 R-20.* MUST 视为架构级缺陷（severity = major），MUST NOT 以「局部便利」为由豁免。

</aside>

## 20.1 页面层职责收口（防止视图变成内核）

- **R-20.1.1** `views/*.vue` MUST 只做「装配 UI」：组合布局、绑定 façade 返回的 props / 事件、维护视图态（折叠 / 宽度 / 激活 tab）。MUST NOT 在视图内实现以下 7 项跨域职责中的任何一项：文档生命周期、窗口关闭流程、运行入口编排、终端会话状态、Git 刷新、通知触发、设置联动。
- **R-20.1.2** 以上 7 项职责 MUST 各自拆为独立 composable / service（如 `useDocumentLifecycle` / `useWindowCloseFlow` / `useRunDispatch` / `useTerminalSession` / `useGitSync` / `services/notify.ts` / `useSettingsSync`），并由 `useWorkbench` façade 以 orchestrator 身份组合；façade 本体 MUST NOT 内联细节实现。
- **R-20.1.3** `useWorkbench.ts` 单文件 MUST ≤400 行（不含 TSDoc）；超过即视为职责越界，MUST 先拆分再合入，MUST NOT 以格式压缩绕过阈值。
- **R-20.1.4** `views/ShellWorkbenchView.vue` 的 `<script setup>` MUST ≤120 行；模板内业务分支（`v-if` / `v-else-if`）MUST ≤3 处，超过 MUST 下沉到 composable。
- **R-20.1.5** 单一 view MUST NOT 同时持有 >1 个业务 store 的可写引用（与 R-18.11.1 联动）；读引用 MUST 经 façade 的 `readonly` / `computed` 返回。
- **R-20.1.6** 跨域原子编排（例：关闭窗口前冲刷未保存文档 + 停止 PTY + 持久化终端历史）MUST 由独立 orchestrator composable 承担，MUST 具备显式「步骤清单（step list）」签名与可测试的失败回滚路径，MUST NOT 内嵌到视图 / store action。

## 20.2 终端域显式化（去隐式单例）

- **R-20.2.1** `composables/useIntegratedTerminal.ts` 模块级 MUST NOT 声明可变共享状态（`let` / `const` 持有 `Terminal` 实例 / 缓冲区 / 监听器注册表 / 会话引用）；所有会话态 MUST 封装进 `TerminalSession`（类或工厂闭包）。
- **R-20.2.2** MUST 存在显式的 `useTerminalRegistry`（或同等机制）托管 session 生命周期；即便当前只有单会话，也 MUST 以 registry 暴露 `create / get / list / dispose`，MUST NOT 在代码中硬编码「唯一会话」假设。
- **R-20.2.3** `TerminalSession` MUST 实现显式接口：`{ id, status, attach(el), detach(), write(data), resize(cols, rows), dispose() }`；UI 组件 MUST 仅依赖该接口，MUST NOT 反向引用其内部实现细节。
- **R-20.2.4** `dispose()` MUST 幂等；调用后 `status` MUST 变为 `disposed`；对 `disposed` 会话写入 MUST 抛出可识别错误（`AppError.code = 'terminal/session-disposed'`），MUST NOT 静默失败。
- **R-20.2.5** PTY 事件订阅 MUST 随 session 生命周期自动注册 / 注销；模块级 MUST NOT 保留全局 unlisten 句柄或全局事件缓冲。
- **R-20.2.6** 终端域 MUST 提供 in-memory fake：`createFakeTerminalSession()`，用于单测与组件测试；façade 与业务代码 MUST 通过依赖注入消费终端，MUST NOT 直接 `import` xterm / Rust PTY 命令。
- **R-20.2.7** 未来引入多终端 / 多工作区 MUST 仅在 registry 层扩展；`TerminalSession` 接口的破坏性变更 MUST 走 ADR。

## 20.3 主题单一真源（合并三处控制）

- **R-20.3.1** 主题 MUST 有且只有一个「派生原点」：`ResolvedTheme = compose(baseVariant, userOverride)`。所有消费面（CSS 变量 / Monaco / xterm / 组件 Props）MUST 从同一 `ResolvedTheme` 订阅派生；MUST NOT 存在第二处「最终主题」计算点。
- **R-20.3.2** 终端配色 MUST 从 `ResolvedTheme.terminal` 派生；`useIntegratedTerminal.ts` MUST NOT 自建终端配色表，MUST NOT 运行时拼装 ANSI 颜色常量。
- **R-20.3.3** `store/app.ts` MUST NOT 直接操作 `document.documentElement` 的 CSS 变量；DOM 写入 MUST 由 `useTheme` / `themes/manager.ts` 的 effect 完成；store 仅存偏好与派生 getter。
- **R-20.3.4** `themes/manager.ts` MUST NOT 持有用户偏好副本或独立持久化层；其输入 MUST 来自 `useAppStore` 的 `readonly` 选择器。
- **R-20.3.5** 主题合成 `compose()` MUST 为纯函数，MUST 可单测；MUST NOT 在合成函数内读 store / 读 DOM / 读系统媒体查询（媒体查询由上游 composable 预转换为 base variant 后再入合成）。
- **R-20.3.6** 任何主题相关类型 MUST 在 `src/types/theme.ts` 单源定义；`scripts/check-theme-keys.ts` MUST 扩展覆盖三个消费面（CSS / Monaco / xterm）键名一致性，不一致 CI 失败。
- **R-20.3.7** 主题真源重复（duplicate source of truth）MUST 视为 P1 架构缺陷；MUST 在下一迭代内整改，MUST NOT 以「三处各管子集」作为长期策略。

## 20.4 服务层作为系统边界（Anti-Corruption Layer）

- **R-20.4.1** `services/tauri.ts`（或 `services/ipc.ts`）MUST 是前端与 Rust 之间的 **Anti-Corruption Layer**。每条命令封装 MUST 同时具备：(a) 入参 Zod schema；(b) 出参 Zod schema；(c) 错误归一化为 `AppError`；(d) 超时；(e) 取消；(f) 结构化调用日志（含 `traceId`）。缺任一项 MUST NOT 对外导出。
- **R-20.4.2** Rust 返回值 MUST 经出参 schema `safeParse` 后再进入上层；schema 失败 MUST 归一化为 `scope='ipc-contract'` 的 `AppError`，MUST NOT 以 `as TType` / `as unknown as TType` 绕过。
- **R-20.4.3** store（`editor.ts` / `terminal.ts` / `git.ts`）MUST NOT 基于「静态类型假设」信任上游；store action 入口 MUST 只接受已校验的类型，未校验原始值 MUST NOT 进入 state。
- **R-20.4.4** 出参 schema MUST 与 `tauri-specta` 生成类型一致：`scripts/check-ipc-schemas.ts` MUST 比对 `z.infer<typeof outSchema>` 与 `IpcGenerated[cmd]` 的结构兼容性，不一致 CI 失败。
- **R-20.4.5** 服务层 MUST NOT 将 Rust 端 `snake_case` 字段泄漏到上层；契约层 MUST 在出参 schema 中完成 `snake_case → camelCase` 的显式映射，业务层 MUST NOT 出现 `x['some_field']` 之类临时访问。
- **R-20.4.6** 服务层 MUST 对每次调用记录结构化日志 `{ cmd, traceId, durationMs, inputBytes, outputBytes, result: 'ok'\|'error', errorCode? }`；生产环境 MAY 按采样关闭 body，但 MUST NOT 关闭元数据。
- **R-20.4.7** 每条命令 MUST 提供可注入的 fake 实现；façade / 组件测试 MUST 通过服务层契约注入，MUST NOT 在测试中 mock `@tauri-apps/api/core` 的 `invoke`。

## 20.5 Rust 命令模块拆分（消除「二号内核」）

- **R-20.5.1** `src-tauri/src/commands/mod.rs` MUST 仅负责命令注册与子模块 re-export；MUST NOT 内联任何命令实现。单文件 MUST ≤80 行。
- **R-20.5.2** 命令 MUST 按领域拆分为独立模块文件，至少含：`window_stage.rs` / `workspace.rs` / `fs_ops.rs` / `shellcheck.rs` / `shfmt.rs` / `env_probe.rs` / `script_run.rs` / `pty_session.rs` / `terminal_events.rs` / `git.rs`（已有）。每模块 MUST 独立导出其 `#[tauri::command]` 符号。
- **R-20.5.3** 每个命令模块单文件 MUST ≤300 行；超出 MUST 进一步按子职责拆（例：`pty_session/{lifecycle.rs, io.rs, resize.rs}`）。
- **R-20.5.4** 命令模块之间 MUST NOT 循环依赖；公共类型 MUST 下沉到 `src-tauri/src/domain/` 或 `src-tauri/src/types/`，MUST NOT 命令模块之间互相 `pub use`。
- **R-20.5.5** 每个命令模块 MUST 附 `#[cfg(test)]` 单测文件或同目录 `tests.rs`，MUST 覆盖核心成功路径 + 至少一条错误路径（与 R-11.6.1 联动）。
- **R-20.5.6** 新增命令 MUST 先建模块再实现；MUST NOT 以「先塞进 [mod.rs](http://mod.rs) 后续再拆」规避。
- **R-20.5.7** `scripts/check-rust-command-modules.ts`（或 `cargo xtask` 等效）MUST 校验：(a) [mod.rs](http://mod.rs) 行数上限；(b) 每个命令模块行数上限；(c) 禁止 `#[tauri::command]` 属性出现于 `mod.rs`。违规 CI 失败。
- **R-20.5.8** 命令模块 MUST 与 `src-tauri/capabilities/` 按领域一一对应（与 R-18.12.5 联动）；新增命令模块 MUST 同 PR 新建对应 capability 文件。

## 20.6 启动链路单源化

- **R-20.6.1** 启动视觉（bootstrap splash）MUST 有且只有一套实现，在 ADR 中二选一固化：
    - **方案 A**：`index.html` + `main.ts` 的命令式 DOM 为真源，Vue 侧 MUST NOT 重复渲染 splash；
    - **方案 B**：`App.vue` 为真源，`main.ts` 内联 DOM MUST 仅保留「Vue 挂载失败兜底 + 同步主题注入」两项最小能力，MUST NOT 再渲染品牌动画。
- **R-20.6.2** 未决期间 MUST NOT 同时扩展两侧 splash 的样式、阶段或动画。
- **R-20.6.3** `main.ts` 的内联 DOM / CSS 字符串总长 MUST ≤120 行；超过即视为越界，MUST 走 R-20.6.1 整改。
- **R-20.6.4** 窗口阶段枚举（`transparent-welcome` / `bootstrap` / `workbench` / `error`）MUST 单源定义（`tauri-specta` 生成或 CI 比对），MUST NOT 在 `main.ts` / `App.vue` / `useWindowStage.ts` 分别维护子集。
- **R-20.6.5** Splash 移除时机 MUST 由「工作台首帧 ready 事件」驱动；MUST NOT 用 `setTimeout` / `requestIdleCallback` 近似或猜测。
- **R-20.6.6** 启动错误（主题注入失败 / Rust 握手失败 / 工作台挂载异常）MUST 由 `main.ts` 最早期注册的统一错误覆盖层呈现；Vue 侧错误 UI MUST 是同一覆盖层的 Vue 版镜像（共用文案与视觉），MUST NOT 维护第二套风格。

## 20.7 目录成熟度显式化

- **R-20.7.1** 每个顶层功能模块目录（`components/business/<domain>/`、`composables/<domain>/`、`views/<feature>/`、`src-tauri/src/commands/<domain>/`）MUST 在自身目录内含 `MATURITY.md`，声明 `status: green \| yellow \| red`、负责人、关键缺口、预计升级迭代。
- **R-20.7.2** `green`（生产可用）/ `yellow`（演进中，UI 已可见）/ `red`（占位 / 未实装）三档 MUST 与第 19 章路线图同步；MUST NOT 自说自话。
- **R-20.7.3** `yellow` / `red` 模块的 UI 入口 MUST 在交互上明确标识（徽章 / 禁用态 / `Coming soon` tooltip）；MUST NOT 以「看似可用实际无效」的方式呈现。
- **R-20.7.4** `red` 模块 MUST NOT 进入生产构建可见路径，或 MUST 由 feature flag 门控；MUST NOT 以「视觉占位」名义合入 release。
- **R-20.7.5** 新增目录 MUST 在同 PR 内补齐 `MATURITY.md`；`scripts/check-maturity-coverage.ts` MUST 校验每个受约束目录均含该文件，缺失即 CI 失败。
- **R-20.7.6** Shell 级入口（`AppSidebar.vue` / `AppActivityBar.vue` 等）MUST 以枚举驱动面板清单，`status` 字段 MUST 来自对应模块的 `MATURITY.md` 或统一 TS 常量，MUST NOT 在 shell 组件内硬编码徽章文案。

## 20.8 死代码与结构漂移治理

- **R-20.8.1** 仓库 MUST NOT 保留「未被事实来源引用」的源文件超过一个迭代；死代码 MUST 删除，或 MUST 在顶部注释显式声明「保留原因 + 复活条件 + 负责人 + 截止日期」四项，缺一 MUST 删除。
- **R-20.8.2** `src/router/` MUST 含 `README.md` 明示状态（与 R-18.2.2 联动），且 `index.ts` 顶部 MUST 含状态注释（`// @status: active` 或 `// @status: dormant`）；`scripts/check-dormant-modules.ts` MUST 校验「dormant 模块 MUST NOT 被业务代码 import」。
- **R-20.8.3** 配置文件的外部路径引用 MUST 与真实文件一致：`components.json` / `tsconfig*.json` / `vite.config.ts` / `tauri.conf.json` / `Cargo.toml` 中引用的相对路径 MUST 均可解析；`scripts/check-config-refs.ts` MUST 静态解析所有配置引用，悬空引用即 CI 失败。
- **R-20.8.4** 删除或重命名配置文件 MUST 同 PR 内更新所有引用点；MUST NOT 分多 PR 「先删后补」。
- **R-20.8.5** CSS-first Tailwind 形态下 MUST NOT 同时保留 `tailwind.config.ts` 与 `@theme` 块；若历史 `tailwind.config.ts` 已删除，`components.json` 的 `tailwind.config` 字段 MUST 清空或指向真实存在的文件，MUST NOT 保留悬空引用。
- **R-20.8.6** `scripts/check-dead-imports.ts`（基于 `ts-unused-exports` 或等效）MUST 在 CI 至少每日运行一次；连续两次出现「已导出但无消费方」的符号 MUST 清理或进 `docs/tech-debt.md` 豁免登记。
- **R-20.8.7** 结构漂移治理 MUST NOT 通过「在 README 里写一句『此文件已废弃』」代替删除或注释标注；文档层声明与仓库层状态 MUST 一致。

## 20.9 关键模块测试加固

- **R-20.9.1** 下列「高复杂度 / 启发式 / 状态机」模块 MUST 配备单元测试，差分覆盖率 MUST ≥90%（严于 R-11.2.1 的 80% 基线）：
    - `composables/useIntegratedTerminal.ts`（含 `TerminalSession` / `useTerminalRegistry` 拆分产物）
    - `utils/structured-run-report.ts`
    - `monaco/shell-completion.ts`
    - `utils/git-diff.ts`（含 gutter decoration 计算）
    - `themes/manager.ts` 的 `compose()` 合成函数（R-20.3.5）
    - `composables/useWorkbench.ts` façade（R-18.11.4）
- **R-20.9.2** `structured-run-report.ts` MUST 配「启发式规则回归集」：每条规则 MUST 在 `__fixtures__/structured-run-report/*.txt` 含正反样例；新增或修改规则 MUST 同 PR 新增 fixture，MUST NOT 以「跑一下看看」替代。
- **R-20.9.3** Shell 补全 MUST 配「语法片段 → 候选集」快照测试：代表性 Bash 片段（未完成命令、函数体内、管道右侧、变量展开内、重定向目标）各 MUST 至少一条断言，MUST NOT 仅测空输入。
- **R-20.9.4** Git diff MUST 配「基线 ↔ 编辑中」往返测试：给定基线与编辑文本，断言 gutter decoration 区间集合稳定；MUST 覆盖 add / delete / modify 三类及「空文件 / EOF 无换行 / 仅空白变更」三种边界。
- **R-20.9.5** 终端状态机 MUST 配显式状态转移表测试：每条合法转移与每条非法转移 MUST 各有一条用例；MUST NOT 仅测 happy path。
- **R-20.9.6** Playwright 桌面端 E2E MUST 至少覆盖：启动至工作台首帧 / 打开已有脚本 / 保存触发诊断 / 一次成功运行 / 一次失败运行（非零退出）/ 关闭窗口冲刷未保存文档。缺一 MUST NOT 发版。
- **R-20.9.7** 新增「高复杂度 / 启发式 / 状态机」模块（由 Code Owner 在 PR 中标注）MUST 在合入同一 PR 内带上对应测试脚手架；MUST NOT 以「后续补测试」作为合入理由。
- **R-20.9.8** `scripts/check-critical-coverage.ts` MUST 对 R-20.9.1 清单内每个模块单独报告差分覆盖率；整体达标但清单内模块未达标 MUST 视为 CI 失败。

## 20.10 Enforcement

- **行数守护**：`scripts/check-file-size.ts` 对 R-20.1.3 / R-20.1.4 / R-20.5.1 / R-20.5.3 / R-20.6.3 枚举清单执行硬阈值，越界 CI 失败。
- **结构守护**：沿用 R-18.13 的 `scripts/check-workbench-facade.ts` / `check-terminal-singleton.ts` / `check-router-disabled.ts` / `check-capabilities-domain.ts`；新增 `scripts/check-theme-sources.ts`（主题派生原点唯一性）/ `check-ipc-schemas.ts`（R-20.4.4）/ `check-rust-command-modules.ts`（R-20.5.7）/ `check-config-refs.ts`（R-20.8.3）/ `check-dormant-modules.ts`（R-20.8.2）/ `check-maturity-coverage.ts`（R-20.7.5）/ `check-critical-coverage.ts`（R-20.9.8）/ `check-dead-imports.ts`（R-20.8.6）。
- **路线图对齐**：每次发版前 `scripts/check-maturity-sync.ts` MUST 对比各 `MATURITY.md` 与第 19 章的 Green / Yellow / Red 清单，不一致 CI 失败。
- **覆盖率兜底**：R-20.9.1 清单模块 MUST 配 `vitest.config.ts` 的 `projects` 分组，CI 单独报告差分覆盖率。
- **ESLint 自定义规则**：`no-module-level-mutable-state`（R-20.2.1）、`no-runtime-unchecked-ipc`（R-20.4.2）、`no-direct-document-theme-mutation`（R-20.3.3）。

<aside>
🧭

第 18 / 19 / 20 章是本 SSoT 的「现实锚点」。若发现规范与代码现实持续偏离超过一个迭代，MUST 提交 ADR 更新本章，而不是让代码去迁就过时的规范条款。

</aside>
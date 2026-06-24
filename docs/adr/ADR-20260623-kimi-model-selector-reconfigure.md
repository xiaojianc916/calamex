# ADR-20260623：模型选择器真正切换运行中的 Kimi 后端

- 状态：已接受（分阶段落地）
- 日期：2026-06-23
- 相关：ADR-20260615（ACP 多后端 / Kimi 接入，编号见 docs/adr 既有文件）、
  ACP `session/set_config_option` 规范（agentclientprotocol.com）

## 背景（确认的根因）

用户反馈：「模型选择器在 Kimi 上完全没作用，无论选什么实际都在用 Kimi 模型，还狂烧 token」。

逐源码核对后确认两条互不相连的「模型平面」：

1. **设置里的厂商/模型选择器** → 命令 `ai_save_config` → `gateway::save_config`。该路径
   **只做两件事**：更新内存 `CONFIG` 单例、把 `ai.json` 写盘。**全程不触碰 `AcpRuntime`**：
   既不重启外部后端、不重写 Kimi 的 `config.toml`，也不调用 `set_config_option`。
2. **会话内 config_options / modes 选择器** → `ai_set_session_config_option` /
   `ai_set_session_mode` → `AcpRuntime` → 运行中宿主。这条链路是端到端通的，但与上面的
   设置选择器**毫无连线**。

Kimi（`@moonshot-ai/kimi-code` 的 TS 构建，经 `node <入口> acp` 拉起）只在**进程启动那一刻**
由 `KimiProvisioner::prepare()` 把当前配置 seed 成托管 `KIMI_CODE_HOME/config.toml` 的
`default_model` + provider 列表，**启动后不热加载**。因此：第一次拉起 Kimi 时定下的模型会一直
沿用，之后在设置里怎么改都只改了 `ai.json`，对已在跑的 `kimi acp` 是**纯空操作**——这就是
「选什么都用 kimi」。若首次 seed 还因所选厂商无已存 Key 而失败，Kimi 进一步回退到自身
`/login` 的托管模型，症状相同。

### 二次澄清：「一定要重启吗？Kimi 不是有原生切换能力吗」

是的，Kimi 原生 `session/set_config_option` 是**热切换、不重启**的——但它**只能在
`config.toml` 启动时 seed 进去的那批模型之间切**。原先 bug 期的 seed 只写了 2 个模型
（main + narrator），所以原生切换的「候选池」里也只有这两个，自然切不到第三个。**真正的修
法不是「每次都重启」，而是把整张可切换清单都 seed 进 `config.toml`**：候选池一旦覆盖全清单，
原生热切换就能覆盖到每个模型、零重启。重启只在**清单本身变化**（加厂商 / 换 Key / 扩清单）
这种结构性变更时才需要——见下「阶段二」。

## 决策

采用**后端感知的单一选择器**语义。模型切换分两条路径，按「目标模型是否已在运行进程的可选
集合内」自动二选一（即用户确认的「混合」策略）：

- **会话内、在已加载模型间切换** → 复用既有 `session/set_config_option`（实时、不重启）。
  这条链路本就存在，无需新增。
- **改动到「有哪些模型可选」的集合本身**（切换厂商 / 轮换 Key / 改 base_url / 设置里换主
  模型 / 扩充清单）→ 必须**重写 `config.toml` 并重启 Kimi**。`set_config_option` 无法凭空变出
  进程从未加载的模型，而 Kimi 只在启动时读 `config.toml`。

### 阶段一（已落地，核心修复）

`ai_save_config` 现接收 `AppHandle`；`gateway::save_config` 成功后，若 Kimi 后端
**正在运行**（`AcpRuntime::is_backend_running`），则 `restart_backend(Kimi)`。`restart_backend`
会先关停旧宿主、重新 `prepare()`（用最新配置重写 `config.toml`）、再重派生子进程，使所选
模型/厂商即时生效。未运行则不动——下次按需 `get_or_spawn` 时自然以最新配置 `prepare`，
保持懒派生语义，绝不为「重新应用配置」平白拉起一个本未运行的后端。重启失败仅记录日志、
不影响「配置已保存」这一既成结果。`ai_connect_provider` 同样接线 reconfigure。

新增 `AcpRuntime::is_backend_running(backend) -> bool`（只读、不派生）。

> 说明：为外部 agent 添加 `AppHandle` 参数不改变 tauri-specta 导出的 TS 签名（`AppHandle`
> 由 Tauri 注入、不计入前端入参），故前端调用与绑定形状不变；重新生成绑定后签名一致。

### 阶段二（已落地，seed 整张清单 + 前端持久化）

核心思路：把「有哪些模型可切换」从代码里写死的 2 个，升级为**前端持久化、后端通用渲染**的
整张清单（用户确认的 Option A）。

- **新增 `seeded_models: Vec<String>`** 落在 `AiRuntimeConfig`（`ai.json`，`#[serde(default)]`
  向后兼容旧文件），经 `normalize_seeded_models` 去空白 / 去重 / 保序。
- **新增命令 `ai_set_seeded_models`**（`gateway::set_seeded_models` → 持久化 → 复用阶段一的
  `reconfigure_running_external_backends` 重启运行中的 Kimi）。
- **provisioner 启动 seed 整张清单**：`ensure_kimi_managed_config` 在 main + narrator 之外，
  追加遍历 `seeded_sidecar_model_configs()`，把每个**有已存 Key** 的模型都渲染成
  `[providers.*]` + `[models.*]`（provider 按 TOML key 去重，模型逐个保留）。于是 Kimi 启动后
  原生 `set_config_option` 的候选池 = 整张清单 → **在清单内切换全部零重启**。
- **清单的单一事实源是前端常量** `AI_SERVICE_PLATFORM_PRESETS`（聚合为
  `MASTRA_PROVIDER_PRESET.models`，覆盖 openai/anthropic/deepseek/google/moonshotai/alibaba/
  zhipuai/ollama 八个平台）。前端在 `loadConfig` 后 fire-and-forget 调 `aiService.setSeededModels`
  下发整张清单；每会话幂等一次（守卫），失败仅告警、不阻断面板。后端不再硬编码任何清单，
  只做「拿到什么 seed 什么」的通用渲染器——要加/改模型只动前端常量，不碰 Rust。

> 为何清单由前端持有：模型目录（含 contextWindow、models.dev 兜底、UI label）本就活在前端
> `src/constants/ai/providers.ts`，是离用户最近、改动最频繁的地方。让它做单一事实源、后端做
> 通用渲染器，避免前后端各维护一份清单导致漂移（「不要新旧杂糅」）。

### 后续阶段（已决策、单独提交）

- **`config.toml` 完全接管覆盖**：去掉 `ensure_kimi_managed_config` 的 marker 跳过逻辑，
  托管 `KIMI_CODE_HOME` 下恒由 calamex 覆盖写入（用户确认「完全接管，手动登录会被清掉」）。
  代价：不要再在托管环境里 `/login`；要用 Kimi 托管模型请在设置里选 moonshotai 厂商 + 填 Key。
- **前端统一为单一后端感知选择器**：设置选择器与会话内 config_options 选择器收敛为一个，
  按当前后端路由到上述两条切换路径。
- **退役 `modes`-作为-模型 的旧路径**：模型只走 config_options（对齐 ACP「config_options 取代
  modes」的方向）；权限模式（Auto/Plan 等）那层 `modes` 保留。
- **provider → Kimi `type` 映射复核**：当前对所有厂商写 `type="openai"`，配合各厂商的
  OpenAI 兼容端点（含 Google 的 `/v1beta/openai` 垫片）是自洽且可用的；如未来要接 Kimi 的
  原生 `google-genai` / `anthropic` 类型，需连带切换对应原生 base_url，单独评估，不在本系列内
  贸然改动以免破坏现有可用链路。

## 影响

- 在清单内切换模型 → 走 Kimi 原生 `set_config_option`，**零重启、零丢会话**。
- 仅当清单集合本身变化（换厂商 / 轮换 Key / 扩充清单 / 设置里换主模型）→ 正在运行的 Kimi
  重启一次以应用新 `config.toml`：会丢弃该后端当前的 in-flight 会话/回合。对这类显式结构性
  动作是可接受且符合预期的代价。
- 仅 seed **有已存 Key** 的模型，避免把用户根本没配凭证的厂商塞进候选池造成切换即报错。
- Builtin 自家边车走逐请求 `model_config`，不受影响。

## 备选方案

- **只用 `set_config_option`、绝不重启**：新加的厂商/模型切不过去（进程未加载），否决。
- **每次切换都重启**：最简单、永远正确，但日常在已加载模型间切换也要等几秒重启、且丢会话；
  故仅作为「集合变化」时的路径，不作为唯一路径。
- **清单写死在后端**：要加模型就得改 Rust + 重新编译，且与前端目录两份漂移；否决，改由前端
  持久化下发。

## 验证（本地）

`cargo clippy && cargo test`（Rust）、`pnpm lint && pnpm typecheck && pnpm test`；
大改用 `pnpm guard`。绑定经构建由 tauri-specta 重新生成（`ai_set_seeded_models` /
`AiSetSeededModelsRequest` / `commands.aiSetSeededModels` 均由 specta 自动产出，勿手改
`src/bindings/tauri.ts`）。

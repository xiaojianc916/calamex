# ADR-0010：GitHub 登录升级为系统浏览器 OAuth + PKCE 优先

- **状态（Status）**: Proposed（待 Code Owner 评审）
- **登记日期**: 2026-06-14
- **责任人 / Code Owner**: @xiaojianc
- **关联文件**: `src-tauri/src/commands/git/github_auth.rs`、`src/services/tauri.github-auth.ts`、`src/store/github-auth.ts`、`src/components/workbench/GitHubAuthPill.vue`、`src/layouts/AppShellLayout.vue`
- **关联规则**: 前端 I/O 唯一出口 `src/services/`；令牌只进 OS keyring；前端只缓存非敏感状态快照

## 背景（Context）

原实现以 GitHub Device Flow 为主：实现简单、跨平台、无需本地回调，但桌面端 UX 较弱，且不是现代桌面 OAuth 的优先形态。

目标架构应更接近桌面应用推荐模式：

1. 系统浏览器完成 GitHub 授权；
2. 授权码使用 PKCE 保护；
3. 本地 loopback callback 仅接收一次性 `code`；
4. access token 只保存到 OS keychain/keyring；
5. 启动时从 keyring / GitHub CLI / git credential 静默恢复；
6. Device Flow 保留为兼容兜底。

## 决策（Decision）

采用分阶段迁移，不一次性删除 Device Flow：

- **首选路径**：系统浏览器 OAuth Authorization Code + PKCE（S256）+ `127.0.0.1` loopback callback。
- **兜底路径**：当浏览器 PKCE 启动或完成失败时，回退到现有 Device Flow。
- **令牌持久化**：两条路径最终都写入同一个 app-owned keyring entry：`calamex.github / oauth:{host}`。
- **凭据恢复顺序**：保持 `memory cache → app keyring → GitHub CLI → git credential`。
- **失效清理**：只清理 `calamex-oauth` 来源的坏 keyring token，不删除 `github-cli` / `git-credential`。

## 边界约束（Constraints）

- 前端不得保存 access token / refresh token / code verifier。
- 前端只负责打开系统浏览器和展示状态；OAuth `state`、PKCE verifier、callback listener、token exchange 均由 Rust 命令层持有。
- loopback callback 只监听本机随机端口，单次授权后即释放。
- GitHub OAuth App / GitHub App 侧必须允许 loopback redirect URI；若线上配置不匹配，客户端会自动回落 Device Flow。

## 结果（Consequences）

- ✅ 登录 UX 从“复制验证码”升级为“浏览器授权后自动回到应用状态”。
- ✅ PKCE 把公开桌面 client 的授权码交换风险降到合理水平。
- ✅ 保留 Device Flow，避免 OAuth App 回调配置尚未就绪时阻断登录。
- ⚠️ 后续应把 tauri-specta 绑定重新生成，移除临时手写的前端 GitHub auth 类型。
- ⚠️ 如果后续采用 GitHub App user-to-server token，可在同一 auth session 边界下加入 refresh token 轮换。

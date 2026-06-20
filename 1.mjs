#!/usr/bin/env node
// apply-calamex-review-fixes.mjs
//
// 用法：
//   node apply-calamex-review-fixes.mjs [仓库根目录] [--dry]
//   例：node apply-calamex-review-fixes.mjs "D:\com.xiaojianc\my_desktop_app"
//   省略路径则取当前目录。--dry 仅预演不写盘。
//
// 落地 7 项代码审查修复（均为单文件、可逆、不破坏编译/现有测试）：
//   #2  ssh/util.rs        safe_remote_path 统一拒绝 ".." 路径段（读/下载/列目录一并硬化）
//   #3  ssh/transfer.rs    下载时远端 size 未知则告警，不再静默接受可能截断的下载
//   #4  agent_sidecar.rs   restore_checkpoint 与 chat/resolve 一致补齐 model_config
//   #6  store/terminal.ts  修正"重新赋值 Map 才触发响应"的误导性注释（实为原地更新）
//   #7  git/tests.rs       新增单测钉住 short_commit_id 的 7 字符截断行为
//   #13 terminal/session.ts 抽出 buildEnsureArgs，消除两处重复的 ensureTerminalSession 入参
//   #14 terminal/session.ts 用具名常量取代 2/5000、1/3000 等魔法数字
//
// 未自动处理（需人工/多文件改动，见文末打印）：#1 #5 #8 #9 #10 #11 #12（#15 已撤回）。

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const repoRoot = resolve(args.find((a) => !a.startsWith('--')) ?? '.');

/** @type {Array<{id:string,file:string,kind:'replace'|'append',find?:string,replace?:string,append?:string,marker:string}>} */
const patches = [
  // ── #2 ssh/util.rs：safe_remote_path 拒绝 ".." 段 ────────────────────────────
  {
    id: '#2 util.rs reject ".." traversal',
    file: 'src-tauri/src/commands/ssh/util.rs',
    kind: 'replace',
    marker: '远程路径不能包含 .. 路径段',
    find: String.raw`    if trimmed.contains('\r') || trimmed.contains('\n') {
        return Err("远程路径包含非法控制字符。".into());
    }
    Ok(trimmed.replace('\\', "/"))`,
    replace: String.raw`    if trimmed.contains('\r') || trimmed.contains('\n') {
        return Err("远程路径包含非法控制字符。".into());
    }
    // 统一对所有带路径的远端操作（含 read / download / list）拒绝 ".." 段，
    // 与 validate_remote_mutation_name 保持一致，杜绝路径穿越的语义不一致。
    let normalized = trimmed.replace('\\', "/");
    if normalized.split('/').any(|segment| segment.trim() == "..") {
        return Err("远程路径不能包含 .. 路径段。".into());
    }
    Ok(normalized)`,
  },

  // ── #3 ssh/transfer.rs：下载 size 未知时告警 ────────────────────────────────
  {
    id: '#3 transfer.rs warn on unknown download size',
    file: 'src-tauri/src/commands/ssh/transfer.rs',
    kind: 'replace',
    marker: '远端未返回文件大小，跳过下载完整性校验',
    find: String.raw`    // 校验下载字节数，防止静默截断（与上传路径保持一致）。
    if let Some(expected) = expected_size {
        ensure_expected_transfer_size(written, expected, "下载远程文件")?;
    }`,
    replace: String.raw`    // 校验下载字节数，防止静默截断（与上传路径保持一致）。
    if let Some(expected) = expected_size {
        ensure_expected_transfer_size(written, expected, "下载远程文件")?;
    } else {
        // 远端未提供 size 元数据时无法校验完整性：明确告警而非静默接受可能被截断的下载。
        log::warn!(
            "远端未返回文件大小，跳过下载完整性校验（remote_path={remote_path}, written={written}）。"
        );
    }`,
  },

  // ── #4 agent_sidecar.rs：restore_checkpoint 补齐 model_config ────────────────
  {
    id: '#4 agent_sidecar.rs ensure_model_config on restore',
    file: 'src-tauri/src/commands/agent_sidecar.rs',
    kind: 'replace',
    marker: 'mut payload: AgentSidecarCheckpointRestoreRequest',
    find: String.raw`pub async fn agent_sidecar_restore_checkpoint(
    app: AppHandle,
    payload: AgentSidecarCheckpointRestoreRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    acp_host(&app)?
        .restore_checkpoint(crate::acp::CheckpointRestoreRequest {`,
    replace: String.raw`pub async fn agent_sidecar_restore_checkpoint(
    app: AppHandle,
    mut payload: AgentSidecarCheckpointRestoreRequest,
) -> Result<AgentSidecarResponsePayload, String> {
    // 与 chat / resolve_* 同源：检查点恢复会驱动续跑回合，缺省时也需补齐主模型配置，
    // 否则 sidecar 退回未注入的环境兜底并报"AI 模型未配置"。
    ensure_model_config(&mut payload.model_config)?;

    acp_host(&app)?
        .restore_checkpoint(crate::acp::CheckpointRestoreRequest {`,
  },

  // ── #6 store/terminal.ts：修正误导性注释（2 处） ────────────────────────────
  {
    id: '#6 store/terminal.ts fix setSessionActiveRun comment',
    file: 'src/store/terminal.ts',
    kind: 'replace',
    marker: 'Vue 对 Map.set/delete 有响应性，原地更新即可触发依赖它的',
    find: String.raw`  /** 写入/更新某会话的活动运行镜像。重新赋值 Map 以可靠触发依赖它的 computed/watcher。 */`,
    replace: String.raw`  /** 写入/更新某会话的活动运行镜像。Vue 对 Map.set/delete 有响应性，原地更新即可触发依赖它的 computed/watcher。 */`,
  },
  {
    id: '#6 store/terminal.ts fix applySessionStateChanged comment',
    file: 'src/store/terminal.ts',
    kind: 'replace',
    marker: 'Vue 对 Map.set/delete 有响应性,原地更新即可触发',
    find: String.raw`  /**
   * 收到某会话的状态转移。重新赋值新 Map,确保依赖 sessionStates 的
   * computed / watcher 可靠触发。后端仅在发生合法转移时发事件,所以这
   * 里不再校验转移合法性,只记录目标态。
   */`,
    replace: String.raw`  /**
   * 收到某会话的状态转移。Vue 对 Map.set/delete 有响应性,原地更新即可触发
   * 依赖 sessionStates 的 computed / watcher。后端仅在发生合法转移时发事件,
   * 所以这里不再校验转移合法性,只记录目标态。
   */`,
  },

  // ── #14 session.ts：注入 PTY 尺寸区间常量 ──────────────────────────────────
  {
    id: '#14 session.ts add size-bound constants',
    file: 'src/terminal/session.ts',
    kind: 'replace',
    marker: 'const TERMINAL_MIN_COLS = 2;',
    find: String.raw`/**
 * 终端会话实体，遵循 R-20.2.3 定义的接口契约；一个实例对应一个 PTY 连接。
 */
export class TerminalSession {`,
    replace: String.raw`// PTY 列宽/行高的合法区间常量：取代散落的魔法数字，集中表达约束。
const TERMINAL_MIN_COLS = 2;
const TERMINAL_MAX_COLS = 5000;
const TERMINAL_MIN_ROWS = 1;
const TERMINAL_MAX_ROWS = 3000;

/**
 * 终端会话实体，遵循 R-20.2.3 定义的接口契约；一个实例对应一个 PTY 连接。
 */
export class TerminalSession {`,
  },

  // ── #13 session.ts：抽出 buildEnsureArgs，消除重复入参（同时用上 #14 常量）──
  {
    id: '#13 session.ts extract buildEnsureArgs',
    file: 'src/terminal/session.ts',
    kind: 'replace',
    marker: 'const buildEnsureArgs = ()',
    find: String.raw`      let payload = await this._tauri.ensureTerminalSession({
        sessionId: this.id,
        cwd: null,
        cols: resolveInteger(terminal.cols, DEFAULT_COLS, 2, 5000),
        rows: resolveInteger(terminal.rows, DEFAULT_ROWS, 1, 3000),
      });
      if (!payload.created && this._resetOrphanedBackendSession) {
        await this._tauri.closeTerminalSession({ sessionId: this.id });
        payload = await this._tauri.ensureTerminalSession({
          sessionId: this.id,
          cwd: null,
          cols: resolveInteger(terminal.cols, DEFAULT_COLS, 2, 5000),
          rows: resolveInteger(terminal.rows, DEFAULT_ROWS, 1, 3000),
        });
      }`,
    replace: String.raw`      // 列宽/行高入参在两处 ensureTerminalSession 调用中完全一致，抽成 builder 防漂移；
      // 边界改用 #14 注入的具名常量。
      const buildEnsureArgs = () => ({
        sessionId: this.id,
        cwd: null,
        cols: resolveInteger(terminal.cols, DEFAULT_COLS, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS),
        rows: resolveInteger(terminal.rows, DEFAULT_ROWS, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS),
      });
      let payload = await this._tauri.ensureTerminalSession(buildEnsureArgs());
      if (!payload.created && this._resetOrphanedBackendSession) {
        await this._tauri.closeTerminalSession({ sessionId: this.id });
        payload = await this._tauri.ensureTerminalSession(buildEnsureArgs());
      }`,
  },

  // ── #7 git/tests.rs：追加 short_commit_id 7 字符截断单测 ────────────────────
  {
    id: '#7 git/tests.rs add short_commit_id test',
    file: 'src-tauri/src/commands/git/tests.rs',
    kind: 'append',
    marker: 'short_commit_id_truncates_to_seven_hex_chars',
    append: String.raw`
#[test]
fn short_commit_id_truncates_to_seven_hex_chars() {
    // 钉住 short_commit_id 依赖的 \`{:.7}\` 截断行为：避免 gix ObjectId 的 Display
    // 实现变更后短 OID 长度悄悄改变而无人察觉。
    let id = gix::ObjectId::from_hex(b"1234567890abcdef1234567890abcdef12345678")
        .expect("valid sha1 hex");
    assert_eq!(short_commit_id(id), "1234567");
}
`,
  },
];

const NOT_AUTOMATED = [
  '#1  workspace_fs 沙箱"可选"边界 —— 属产品设计（支持打开磁盘任意脚本），强制化会破坏核心功能，需产品决策。',
  '#5  agent_sidecar external_chat 返回 Debug 串 —— 改前端契约，需确认 StopReason 稳定映射后再改。',
  '#8  Linux inotify 新建目录竞态 —— 需"补挂监听后重扫并补发 Create 事件"，非纯文本替换可完成。',
  '#9  SFTP 每块 to_vec 分配 —— 需引入缓冲池并改造 channel 所有权，应单独 PR。',
  '#10 state.rs 快照热路径 entry().or_default() —— 需重构为只读快路径，易引入细微行为差异，应单独 PR。',
  '#11 拆分 ~900 行 session.ts —— 结构性重构，不可机械替换。',
  '#12 拆分 ~700 行 codemirror-shiki-highlight.ts —— 结构性重构，不可机械替换。',
  '#15 safe_remote_path 反斜杠归一 —— 已撤回：行为有意为之且有现成测试覆盖。',
];

const backedUp = new Set();
let applied = 0,
  skipped = 0,
  failed = 0;

function backup(absPath) {
  if (dryRun || backedUp.has(absPath)) return;
  const bak = absPath + '.bak';
  if (!existsSync(bak)) copyFileSync(absPath, bak);
  backedUp.add(absPath);
}

for (const p of patches) {
  const abs = join(repoRoot, p.file);
  if (!existsSync(abs)) {
    console.log(`✗ [缺失] ${p.id} —— 找不到 ${p.file}`);
    failed++;
    continue;
  }
  let content = readFileSync(abs, 'utf8');

  if (content.includes(p.marker)) {
    console.log(`• [已应用] ${p.id}`);
    skipped++;
    continue;
  }

  if (p.kind === 'append') {
    backup(abs);
    if (!dryRun) writeFileSync(abs, content + p.append, 'utf8');
    console.log(`✓ [追加] ${p.id}`);
    applied++;
    continue;
  }

  const occ = content.split(p.find).length - 1;
  if (occ === 0) {
    console.log(`✗ [锚点未命中] ${p.id} —— 源码可能已变化，已跳过（未改动）`);
    failed++;
    continue;
  }
  if (occ > 1) {
    console.log(`✗ [锚点不唯一(${occ})] ${p.id} —— 为安全起见跳过（未改动）`);
    failed++;
    continue;
  }

  backup(abs);
  content = content.replace(p.find, p.replace);
  if (!dryRun) writeFileSync(abs, content, 'utf8');
  console.log(`✓ [替换] ${p.id}`);
  applied++;
}

console.log('\n──────────── 结果 ────────────');
console.log(`仓库根目录：${repoRoot}${dryRun ? '   (DRY-RUN，未写盘)' : ''}`);
console.log(`应用 ${applied} · 已应用跳过 ${skipped} · 失败/未命中 ${failed}`);
if (backedUp.size) console.log(`已为 ${backedUp.size} 个文件创建 .bak 备份`);

console.log('\n以下未自动处理（需人工跟进）：');
for (const line of NOT_AUTOMATED) console.log('  - ' + line);

console.log('\n建议验证：');
console.log('  cargo test  （src-tauri 内，覆盖 #2 #3 #4 #7）');
console.log('  pnpm typecheck / pnpm test  （覆盖 #6 #13 #14）');

if (failed > 0) process.exitCode = 1;
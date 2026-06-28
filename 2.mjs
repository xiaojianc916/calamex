#!/usr/bin/env node
// acp-refactor.mjs — ACP 重构编解码器(安全引擎,按域喂入逐字核对过的补丁)
//
// 安全约束(吸取上一次 unicode 脚本误伤 17 文件的教训):
//   1) git 工作区必须干净,否则拒绝运行(--force 可绕过,自负风险)——保证可一键回滚。
//   2) 默认 dry-run,只预览;加 --write 才落盘。
//   3) 原子 + fail-loud:任一锚点「命中次数 ≠ 期望次数」即整体中止,一个文件都不写。
//      绝不模糊匹配、绝不部分写入。锚点对不上 = 你本地文件与基线不一致,先停下来看。
//
// 用法:
//   node acp-refactor.mjs            # 预览(dry-run)
//   node acp-refactor.mjs --write    # 全部锚点命中才落盘
//
// 落盘后务必:pnpm biome check --write(修 import 排序) → 继续域②(Rust/specta) → vue-tsc/cargo。

import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

/* ============================================================================
 * 补丁清单(按域)。每条 op:
 *   { file, find, replace, expect }  —— find 必须在 file 中恰好出现 expect 次。
 * find/replace 为逐字字符串(含缩进),不做正则。
 * ========================================================================== */
const OPS = [
  // —— 域①-a:src/services/ipc/ai.service.ts ——
  {
    file: 'src/services/ipc/ai.service.ts',
    expect: 1,
    find:
      '  IAiGetSessionConfigOptionsRequest,\n' +
      '  IAiGetSessionModesRequest,\n',
    replace:
      '  IAiEnsureAcpSessionRequest,\n' +
      '  IAiGetSessionModesRequest,\n',
  },
  {
    file: 'src/services/ipc/ai.service.ts',
    expect: 1,
    find:
      '  getSessionConfigOptions(\n' +
      '    payload: IAiGetSessionConfigOptionsRequest,\n' +
      '  ): Promise<IAiSessionConfigOptionsPayload | null> {\n' +
      '    return tauriService.aiGetSessionConfigOptions(payload);\n' +
      '  },\n' +
      '  setSessionConfigOption(payload: IAiSetSessionConfigOptionRequest): Promise<boolean> {\n' +
      '    return tauriService.aiSetSessionConfigOption(payload);\n' +
      '  },\n',
    replace:
      '  ensureAcpSession(payload: IAiEnsureAcpSessionRequest): Promise<void> {\n' +
      '    return tauriService.aiEnsureAcpSession(payload);\n' +
      '  },\n' +
      '  setSessionConfigOption(\n' +
      '    payload: IAiSetSessionConfigOptionRequest,\n' +
      '  ): Promise<IAiSessionConfigOptionsPayload | null> {\n' +
      '    return tauriService.aiSetSessionConfigOption(payload);\n' +
      '  },\n',
  },

  // —— 域①-b:src/types/ai/sidecar.ts ——
  {
    file: 'src/types/ai/sidecar.ts',
    expect: 1,
    find:
      'export interface IAcpSessionConfigOptionsState {\n' +
      '  configOptions: IAcpSessionConfigOption[];\n' +
      '}\n',
    replace:
      '/**\n' +
      ' * ACP 会话配置项发现状态(v3 · 唯一标准管线 / 判别式状态机)。\n' +
      ' *\n' +
      ' * 取代旧 `IAcpSessionConfigOptionsState`。配置项发现归一为单一事件驱动管线:\n' +
      ' * `ensure_session` 握手 + 统一 `config_option_update` 事件通道(握手快照 / 延迟通知 /\n' +
      ' * set 响应全集都汇入同一 sink),不再有 get 工作区与 host 轮询。UI 按此判别式渲染:\n' +
      ' * - idle:尚未发起握手。\n' +
      ' * - discovering:已握手,短等首帧 configOptions。\n' +
      ' * - unavailable:该 backend 不公示 configOptions(或握手失败);选择器锁定并给原因。\n' +
      ' * - ready:已拿到 configOptions 全集(可能为空数组 = 已公示但无可选项)。\n' +
      ' */\n' +
      'export type TAcpSessionConfigOptions =\n' +
      "  | { kind: 'idle' }\n" +
      "  | { kind: 'discovering' }\n" +
      "  | { kind: 'unavailable'; reason: string; message?: string }\n" +
      "  | { kind: 'ready'; configOptions: IAcpSessionConfigOption[] };\n",
  },
];

/* ========================================================================== */

function assertGitClean(force) {
  let status = '';
  try {
    status = execSync('git status --porcelain', { encoding: 'utf8' });
  } catch {
    console.error('✖ 不是 git 仓库或 git 不可用。中止。');
    process.exit(2);
  }
  if (status.trim() && !force) {
    console.error('✖ git 工作区不干净。请先 commit / stash,确保本次重构可整体回滚。');
    console.error('  (确实要在脏树上跑可加 --force,自负风险)');
    console.error('—— 未提交改动 ——');
    console.error(status);
    process.exit(2);
  }
}

function countOccurrences(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('node acp-refactor.mjs [--write] [--force]\n默认 dry-run。git 干净才允许跑。锚点全命中才落盘。');
    return;
  }
  const write = args.includes('--write');
  const force = args.includes('--force');

  assertGitClean(force);

  // 按文件分组,每个文件只读一次。
  const byFile = new Map();
  for (const op of OPS) {
    if (!byFile.has(op.file)) byFile.set(op.file, []);
    byFile.get(op.file).push(op);
  }

  const planned = []; // { file, nextContent, hits }
  const failures = [];

  for (const [file, ops] of byFile) {
    const abs = resolve(file);
    let content;
    try {
      content = await readFile(abs, 'utf8');
    } catch (err) {
      failures.push(`${file}: 读取失败 — ${err.message}`);
      continue;
    }

    let next = content;
    let hits = 0;
    for (const op of ops) {
      const found = countOccurrences(next, op.find);
      const expect = op.expect ?? 1;
      if (found !== expect) {
        const head = op.find.split('\n')[0];
        failures.push(`${file}: 锚点命中 ${found} 次,期望 ${expect} 次 → 「${head}…」`);
        continue;
      }
      next = next.split(op.find).join(op.replace);
      hits += expect;
    }
    if (next !== content) planned.push({ file, nextContent: next, hits });
  }

  // fail-loud:任一锚点不符,整体中止,不写任何文件。
  if (failures.length > 0) {
    console.error('✖ 锚点校验失败,已中止(未写任何文件):');
    for (const f of failures) console.error('  - ' + f);
    console.error('\n原因通常是:你本地文件与基线不一致,或该域补丁已应用过。先 git diff 看清再说。');
    process.exit(1);
  }

  if (planned.length === 0) {
    console.log('没有可应用的改动(可能已全部应用,幂等通过)。');
    return;
  }

  for (const p of planned) {
    console.log(`${write ? '✔ 已改写' : '○ 待改写'} ${p.file}  (${p.hits} 处锚点)`);
  }

  if (write) {
    for (const p of planned) await writeFile(resolve(p.file), p.nextContent, 'utf8');
    console.log('—'.repeat(48));
    console.log('已落盘。接着:pnpm biome check --write → 继续域②(Rust/specta)→ vue-tsc / cargo check。');
  } else {
    console.log('—'.repeat(48));
    console.log('这是预览(dry-run)。确认无误后加 --write。');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
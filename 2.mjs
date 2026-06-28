#!/usr/bin/env node
// 3.mjs — 迁移收尾补丁(仓库根运行: node 3.mjs)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const abs = (p) => path.join(ROOT, p);
const exists = (p) => fs.existsSync(abs(p));
const sh = (args) => execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
const log = (...a) => console.log(...a);

// 1) 重命名漏掉的 2 个 Rust 模块文件(否则 `mod builtin_agent;` 找不到文件 → E0583)
for (const [from, to] of [
  ['src-tauri/src/commands/agent_sidecar.rs', 'src-tauri/src/commands/builtin_agent.rs'],
  ['src-tauri/src/commands/contracts/agent_sidecar.rs', 'src-tauri/src/commands/contracts/builtin_agent.rs'],
]) {
  if (exists(from)) { log(`• git mv ${from} → ${to}`); try { sh(['mv', from, to]); } catch { fs.renameSync(abs(from), abs(to)); } }
  else if (exists(to)) log(`• 已是 ${to}(跳过)`);
  else log(`⚠️ 未找到 ${from}(请手动核对 git ls-files src-tauri | findstr agent_sidecar)`);
}

// 2) 加回 ai(非死依赖:ai-elements 用了官方 UI 类型);只保留移除 @ai-sdk/deepseek
{
  const p = abs('package.json');
  let t = fs.readFileSync(p, 'utf8');
  const depsBlock = t.match(/"dependencies"\s*:\s*\{[\s\S]*?\n\s*\}/)?.[0] ?? '';
  if (!/"ai"\s*:/.test(depsBlock)) {
    if (/(\n)(\s*)"bash-language-server":/.test(t)) {
      t = t.replace(/(\n)(\s*)"bash-language-server":/, `$1$2"ai": "7.0.4",$1$2"bash-language-server":`); // 还原字母序原位
    } else {
      t = t.replace(/("dependencies"\s*:\s*\{)/, `$1\n    "ai": "7.0.4",`);
    }
    fs.writeFileSync(p, t);
    log('• package.json: 加回 ai@7.0.4(仅清退 @ai-sdk/deepseek)');
  } else log('• ai 已在依赖中(跳过)');
}

// 3) 还原 specta 生成物,交回构建再生
if (exists('src/bindings/tauri.ts')) { log('• git checkout src/bindings/tauri.ts(交回 tauri-specta 再生)'); try { sh(['checkout', '--', 'src/bindings/tauri.ts']); } catch {} }

// 4) 修 .gitignore(脚本因无扩展名跳过)
{
  const p = abs('.gitignore');
  if (fs.existsSync(p)) {
    const b = fs.readFileSync(p, 'utf8');
    const t = b.split('agent-sidecar').join('builtin-agent');
    if (t !== b) { fs.writeFileSync(p, t); log('• .gitignore: agent-sidecar → builtin-agent'); }
  }
}

// 5) 删除陈旧的、被 ignore 的打包暂存目录(prepare-bundle-resources 会按 builtin-agent 重生)
if (exists('src-tauri/resources-bundle/agent-sidecar')) {
  fs.rmSync(abs('src-tauri/resources-bundle/agent-sidecar'), { recursive: true, force: true });
  log('• 删除陈旧 src-tauri/resources-bundle/agent-sidecar(非提交内容)');
}

log('\n收尾完成。按序过闸:');
log('  1) pnpm install');
log('  2) 再生绑定:pnpm tauri:dev 跑一次(debug 下 tauri-specta 重写 src/bindings/tauri.ts),确认命令名变 builtin_agent_*');
log('  3) pnpm typecheck && pnpm lint && pnpm test');
log('  4) cargo clippy --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml');
log('  5) pnpm guard && pnpm tauri:build   (验证打包路径 resources-bundle/builtin-agent)');
log('  6) git status 复核(.mastra / resources-bundle 应为 ignored,不进暂存)→ squash 提交 main');
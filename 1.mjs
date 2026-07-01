#!/usr/bin/env node
// codemod-inject-skills-dir-env.mjs (v2)
// 用途：在 launch.rs::build_builtin_agent_env() 注入 CALAMEX_SKILLS_DIR，
//       让边车（Node）与宿主（Rust commands/skills.rs）指向同一技能目录，
//       修复 Windows 上 ~/.calamex/skills 与 %APPDATA%/.calamex/skills 分裂的 bug。
// v2 修复：v1 用「跨行模板字符串」当锚点，在 CRLF 换行的文件上匹配不到（Windows 常见）；
//          v2 改为「单行子串 + indexOf 定位 + 自动探测 CRLF/LF」，不再受换行风格影响。
// 特性：dry-run 默认；--write 落盘；幂等（注过即跳过）；纯 std，无新依赖。
// 用法：node scripts/codemod-inject-skills-dir-env.mjs [repoRoot] [--write]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WRITE = process.argv.includes('--write');
const posArgs = process.argv.slice(2).filter((a) => a !== '--write');
const ROOT = posArgs[0] ? resolve(posArgs[0]) : process.cwd();
const rel = 'src-tauri/src/acp/launch.rs';
const abs = join(ROOT, rel);
if (!existsSync(abs)) { console.error('✗ 找不到 ' + rel + '（请在仓库根运行或传入 repoRoot）'); process.exit(1); }

let src = readFileSync(abs, 'utf8');
const before = src;
const EOL = src.includes('\r\n') ? '\r\n' : '\n';

// 在含 anchor（单行、不跨行）的那一行之后插入 lines（按文件换行风格逐行拼接）。
function insertAfterLine(text, anchor, lines) {
  const i = text.indexOf(anchor);
  if (i === -1) return null;
  const nl = text.indexOf('\n', i);
  const end = nl === -1 ? text.length : nl + 1;
  return text.slice(0, end) + lines.map((l) => l + EOL).join('') + text.slice(end);
}

// 编辑 1：新增 const SKILLS_DIR_ENV（锚点 = TAVILY 常量行，单行、无引号，CRLF 无关）。
if (src.includes('SKILLS_DIR_ENV')) {
  console.log('· [const] SKILLS_DIR_ENV 已存在，跳过。');
} else {
  const next = insertAfterLine(src, 'const TAVILY_API_KEY_ENV: &str =', [
    '/// 全局技能目录的跨进程契约：宿主解析后经此 env 注入边车，Node 侧据此定位技能库',
    '/// （见 builtin-agent workspace.ts 的 resolveGlobalSkillsDirectory / CALAMEX_SKILLS_DIR 分支）。',
    'const SKILLS_DIR_ENV: &str = "CALAMEX_SKILLS_DIR";',
  ]);
  if (next === null) { console.error('✗ [const] 未命中锚点（TAVILY 常量行），请人工核对；未改动。'); process.exit(2); }
  src = next;
  console.log('✓ [const] 已插入 SKILLS_DIR_ENV。');
}

// 编辑 2：在 uvx 注入块之后追加技能目录注入（锚点 = uvx push 行，单行、无引号）。
if (src.includes('SKILLS_DIR_ENV.to_string()')) {
  console.log('· [env.push] 技能目录注入已存在，跳过。');
} else {
  const uvxLine = 'env.push((MCP_UVX_PATH_ENV.to_string(), path_to_string(&path)));';
  const ui = src.indexOf(uvxLine);
  if (ui === -1) { console.error('✗ [env.push] 未命中锚点（uvx 注入行），请人工核对；未改动。'); process.exit(2); }
  const braceIdx = src.indexOf('}', ui);
  if (braceIdx === -1) { console.error('✗ [env.push] 未找到 uvx if 块收尾括号，请人工核对；未改动。'); process.exit(2); }
  const nl = src.indexOf('\n', braceIdx);
  const end = nl === -1 ? src.length : nl + 1;
  const block = [
    '',
    '    // 全局技能目录：由宿主（唯一事实源）解析后经 env 注入子进程，杜绝 Node 侧',
    '    // %APPDATA%/.calamex/skills 与 Rust 侧 ~/.calamex/skills 各算各的（此前在 Windows',
    '    // 上指向不同目录，导致 UI 存的技能 Agent 读不到）。与 commands::skills 同源。',
    '    if let Some(root) = crate::storage_paths::roaming_root() {',
    '        env.push((SKILLS_DIR_ENV.to_string(), path_to_string(&root.join("skills"))));',
    '    }',
  ].map((l) => l + EOL).join('');
  src = src.slice(0, end) + block + src.slice(end);
  console.log('✓ [env.push] 已注入技能目录。');
}

if (src === before) { console.log('全部已注入，无需改动。'); process.exit(0); }
if (!WRITE) { console.log('[dry-run] 预览完成，未写盘。确认无误后加 --write 落盘。'); process.exit(0); }
writeFileSync(abs, src, 'utf8');
console.log('✓ 已写入 ' + rel + '。必做自检：cd src-tauri && cargo build');
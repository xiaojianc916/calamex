/**
 * tavily-env-ipc-migration.mjs
 *
 * 将 TAVILY_API_KEY 读写路径从前端手写 dotenv 解析迁移到 Rust 侧 Tauri command。
 *
 * 修改项：
 *   ① package.json: 删除死依赖 dotenv@17
 *   ② ai.service.ts: 移除手写 dotenv 解析函数，loadTavilyApiKey/saveTavilyApiKey
 *      改调新的 Rust IPC command（get_sidecar_env / set_sidecar_env）
 *   ③ src/services/tauri/sidecar.ts: 新增 getSidecarEnv / setSidecarEnv IPC 包装
 *
 * ⚠️ 前置条件：Rust 侧需先手动添加 get_sidecar_env / set_sidecar_env command
 *    （见脚本末尾打印的 Rust 代码块），并运行 cargo check 通过后再执行本脚本。
 *
 * 用法：
 *   node tavily-env-ipc-migration.mjs           # dry-run
 *   node tavily-env-ipc-migration.mjs --write    # 实际写入
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = __dirname;
const DRY_RUN = !process.argv.includes('--write');

// ─── 工具函数 ─────────────────────────────────────────────

function readFile(relPath) {
  const abs = join(REPO_ROOT, relPath);
  if (!existsSync(abs)) {
    console.warn(`  ⚠ 文件不存在: ${relPath}`);
    return null;
  }
  return readFileSync(abs, 'utf-8');
}

function replaceOnce(content, oldStr, newStr, relPath) {
  if (content.includes(newStr)) {
    console.log(`  ✓ 已应用（跳过）: ${relPath}`);
    return content;
  }
  const count = content.split(oldStr).length - 1;
  if (count === 0) {
    console.warn(`  ✗ 锚点未找到: ${relPath}`);
    console.warn(`    预期片段（前 80 字符）: ${oldStr.slice(0, 80)}...`);
    return content;
  }
  if (count > 1) {
    console.warn(`  ✗ 锚点不唯一（${count} 处匹配）: ${relPath}`);
    return content;
  }
  return content.replace(oldStr, newStr);
}

function writeFile(relPath, content) {
  const abs = join(REPO_ROOT, relPath);
  if (DRY_RUN) {
    console.log(`  📝 [DRY-RUN] 将写入: ${relPath}`);
  } else {
    writeFileSync(abs, content, 'utf-8');
    console.log(`  ✅ 已写入: ${relPath}`);
  }
}

// ─── 修改 ① package.json: 删除 dotenv 死依赖 ──────────────

function patchPackageJson() {
  console.log('\n━ ① package.json: 删除 dotenv 死依赖 ━');

  const FILE = 'package.json';
  const content = readFile(FILE);
  if (!content) return;

  // 幂等检查
  if (!content.includes('"dotenv"')) {
    console.log('  ✓ 已删除（跳过）: package.json 中无 dotenv');
    return;
  }

  const oldStr = '    "dotenv": "^17.4.2",\n';
  const patched = replaceOnce(content, oldStr, '', FILE);
  if (patched !== content) {
    writeFile(FILE, patched);
  }
}

// ─── 修改 ② sidecar.ts: 新增 IPC 包装 ────────────────────

function patchSidecarTs() {
  console.log('\n━ ② sidecar.ts: 新增 getSidecarEnv / setSidecarEnv IPC 包装 ━');

  const FILE = 'src/services/tauri/sidecar.ts';
  const content = readFile(FILE);
  if (!content) return;

  // 找到文件末尾的 export 区块，在最后一个 export 之后追加新方法
  // 锚点：sidecar.ts 中 ITauriService 的 sidecar 相关方法声明区
  // 先读取文件内容确认锚点
  if (content.includes('getSidecarEnv')) {
    console.log('  ✓ 已应用（跳过）: sidecar.ts 中已有 getSidecarEnv');
    return;
  }

  // 在文件末尾（最后一个 export 空行之前）插入新的导出函数
  const newMethods = `
/**
 * 读取 sidecar .env 中的环境变量（经 Rust 侧 find_dotenv_value 解析，支持 export 前缀/引号/注释）。
 * 仅用于 TAVILY_API_KEY 等 sidecar 进程级配置；API Key 等敏感凭证走 keyring。
 */
export const getSidecarEnv = async (key: string): Promise<string | null> =>
  commands.getSidecarEnv(key);

/**
 * 写入 sidecar .env 中的环境变量（经 Rust 侧 write_dotenv_value 原子写入，保留注释与其他变量）。
 * 传 null 删除该 key。
 */
export const setSidecarEnv = async (key: string, value: string | null): Promise<void> =>
  commands.setSidecarEnv(key, value);
`;

  // 锚点：文件末尾最后一个 } 或 export 的位置
  // 找到文件最后一段非空行
  const lastExportIdx = content.lastIndexOf('export ');
  if (lastExportIdx === -1) {
    console.warn('  ✗ 锚点未找到: sidecar.ts 中无 export 语句');
    return;
  }

  // 找到该 export 语句的结束位置（下一个空行或文件末尾）
  const afterExport = content.indexOf('\n', lastExportIdx);
  const insertPos = afterExport === -1 ? content.length : afterExport + 1;

  const patched = content.slice(0, insertPos) + newMethods + content.slice(insertPos);
  writeFile(FILE, patched);
}

// ─── 修改 ③ ai.service.ts: 移除手写 dotenv，改调 IPC ────

function patchAiServiceTs() {
  console.log('\n━ ③ ai.service.ts: 移除手写 dotenv 解析，改调 Rust IPC ━');

  const FILE = 'src/services/ipc/ai.service.ts';
  const content = readFile(FILE);
  if (!content) return;

  if (content.includes('getSidecarEnv')) {
    console.log('  ✓ 已应用（跳过）: ai.service.ts 已用 getSidecarEnv');
    return;
  }

  // 步骤 1：替换 import 区块——移除 escapeRegExp / normalizeFileSystemPath（如果仅被 dotenv 函数使用）
  // 添加 getSidecarEnv / setSidecarEnv import
  const oldImport = `import { escapeRegExp } from '@/utils/core/regex';\nimport { normalizeFileSystemPath } from '@/utils/file/path';`;
  const newImport = `import { getSidecarEnv, setSidecarEnv } from '@/services/tauri/sidecar';`;

  // 检查 escapeRegExp / normalizeFileSystemPath 是否还被其他函数使用
  const afterImportContent = content.split(oldImport)[1] || '';
  const escapeRegExpStillUsed = /escapeRegExp/.test(afterImportContent);
  const normalizePathStillUsed = /normalizeFileSystemPath/.test(afterImportContent);

  let finalImport = newImport;
  if (escapeRegExpStillUsed) {
    finalImport = `import { escapeRegExp } from '@/utils/core/regex';\n` + finalImport;
  }
  if (normalizePathStillUsed) {
    finalImport = `import { normalizeFileSystemPath } from '@/utils/file/path';\n` + finalImport;
  }

  let patched = replaceOnce(content, oldImport, finalImport, FILE);
  if (patched === content) return;

  // 步骤 2：移除手写 dotenv 常量和函数
  const oldDotenvBlock = `const SIDECAR_DOTENV_RELATIVE_PATH = 'builtin-agent/.env';
const TAVILY_API_KEY_ENV = 'TAVILY_API_KEY';
const MISSING_FILE_ERROR_PATTERN = /不存在|找不到|not found|cannot find|no such file/iu;

const resolveSidecarDotenvPath = (workspaceRootPath: string): string =>
  \`\${normalizeFileSystemPath(workspaceRootPath, {
    collapseDuplicateSeparators: true,
    trimTrailingSeparator: true,
    foldWindowsCase: false,
  })}/\${SIDECAR_DOTENV_RELATIVE_PATH}\`;

const buildDotenvLinePattern = (key: string): RegExp =>
  new RegExp(\`^\\\\\\\\s*(?:export\\\\\\\\s+)?\${escapeRegExp(key)}\\\\\\\\s*=.*$\`, 'u');

const readOptionalScript = async (path: string) => {
  try {
    return await tauriService.loadScript(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (MISSING_FILE_ERROR_PATTERN.test(message)) {
      return null;
    }
    throw error;
  }
};

const parseDotenvValue = (rawValue: string): string => {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return '';
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed.replace(/\\s+#.*$/u, '');
};

const readDotenvAssignment = (content: string, key: string): string => {
  const linePattern = new RegExp(\`^\\\\\\\\s*(?:export\\\\\\\\s+)?\${escapeRegExp(key)}\\\\\\\\s*=\\\\\\\\s*(.*)\\\\\\\\s*$\`, 'u');

  for (const line of content.split(/\\r?\\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = line.match(linePattern);
    if (match) {
      return parseDotenvValue(match[1] ?? '');
    }
  }

  return '';
};

const formatDotenvValue = (value: string): string =>
  /[\\s#"']/u.test(value) ? JSON.stringify(value) : value;

const updateDotenvAssignment = (content: string, key: string, nextValue: string | null): string => {
  const lineBreak = content.includes('\\r\\n') ? '\\r\\n' : '\\n';
  const hadTrailingNewline = content.endsWith('\\n');
  const linePattern = buildDotenvLinePattern(key);
  const nextLines: string[] = [];
  let replaced = false;

  for (const line of content.split(/\\r?\\n/u)) {
    if (linePattern.test(line)) {
      if (!replaced && nextValue !== null) {
        nextLines.push(\`\${key}=\${formatDotenvValue(nextValue)}\`);
        replaced = true;
      }
      continue;
    }

    if (!line && !content) {
      continue;
    }

    nextLines.push(line);
  }

  if (!replaced && nextValue !== null) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1]?.trim() !== '') {
      nextLines.push('');
    }
    nextLines.push(\`\${key}=\${formatDotenvValue(nextValue)}\`);
  }

  let nextContent = nextLines.join(lineBreak);

  if (!nextContent) {
    return '';
  }

  if (hadTrailingNewline || nextValue !== null) {
    nextContent = \`\${nextContent}\${lineBreak}\`;
  }

  return nextContent;
};`;

  const newDotenvBlock = `/** TAVILY_API_KEY 在 sidecar .env 中的环境变量名。 */
const TAVILY_API_KEY_ENV = 'TAVILY_API_KEY';`;

  patched = replaceOnce(patched, oldDotenvBlock, newDotenvBlock, FILE);
  if (patched === content) {
    console.warn('  ⚠ dotenv 函数块未匹配，可能源码已有变更，请手动检查');
    return;
  }

  // 步骤 3：替换 loadTavilyApiKey 方法体
  const oldLoadMethod = `  async loadTavilyApiKey(workspaceRootPath: string): Promise<string> {
    const sidecarDotenvPath = resolveSidecarDotenvPath(workspaceRootPath);
    const script = await readOptionalScript(sidecarDotenvPath);
    return script ? readDotenvAssignment(script.content, TAVILY_API_KEY_ENV) : '';
  },`;

  const newLoadMethod = `  async loadTavilyApiKey(): Promise<string> {
    return (await getSidecarEnv(TAVILY_API_KEY_ENV)) ?? '';
  },`;

  patched = replaceOnce(patched, oldLoadMethod, newLoadMethod, FILE);
  if (patched === content) {
    console.warn('  ⚠ loadTavilyApiKey 方法体未匹配');
    return;
  }

  // 步骤 4：替换 saveTavilyApiKey 方法体
  const oldSaveMethod = `  async saveTavilyApiKey(workspaceRootPath: string, apiKey: string): Promise<void> {
    const sidecarDotenvPath = resolveSidecarDotenvPath(workspaceRootPath);
    const script = await readOptionalScript(sidecarDotenvPath);
    const nextValue = apiKey.trim();

    if (!script && !nextValue) {
      return;
    }

    await tauriService.saveScript({
      path: sidecarDotenvPath,
      workspaceRootPath,
      content: updateDotenvAssignment(script?.content ?? '', TAVILY_API_KEY_ENV, nextValue || null),
      encoding: script?.encoding ?? 'utf-8',
    });
  },`;

  const newSaveMethod = `  async saveTavilyApiKey(apiKey: string): Promise<void> {
    const nextValue = apiKey.trim();
    if (!nextValue) {
      await setSidecarEnv(TAVILY_API_KEY_ENV, null);
      return;
    }
    await setSidecarEnv(TAVILY_API_KEY_ENV, nextValue);
  },`;

  patched = replaceOnce(patched, oldSaveMethod, newSaveMethod, FILE);
  if (patched === content) {
    console.warn('  ⚠ saveTavilyApiKey 方法体未匹配');
    return;
  }

  writeFile(FILE, patched);
}

// ─── 主流程 ─────────────────────────────────────────────

function printRustCode() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ⚠ Rust 侧需手动添加的代码（cargo check 通过后再跑本脚本）     ║
╚══════════════════════════════════════════════════════════════╝

在 src-tauri/src/acp/launch.rs 中添加：

\`\`\`rust
/// 读取 sidecar .env 中指定 key 的值（供前端经 Tauri command 调用）。
/// 优先级：进程环境 > 用户环境 > .env 文件（与 build_builtin_agent_env 一致）。
#[tauri::command]
pub fn get_sidecar_env(key: String) -> Result<Option<String>, String> {
    let sidecar_root = resolve_builtin_agent_root()?;
    Ok(env_or_user_env(&key)
        .or_else(|| read_dotenv_key(&sidecar_root, &key)))
}

/// 写入 sidecar .env 中指定 key 的值（供前端经 Tauri command 调用）。
/// value = null 时删除该 key。保留 .env 中其他变量和注释。
#[tauri::command]
pub fn set_sidecar_env(key: String, value: Option<String>) -> Result<(), String> {
    let sidecar_root = resolve_builtin_agent_root()?;
    let env_path = sidecar_root.join(".env");
    let content = fs::read_to_string(&env_path).unwrap_or_default();
    let next = write_dotenv_value(&content, &key, value.as_deref());
    fs::write(&env_path, next).map_err(|e| format!("写入 .env 失败: {e}"))
}

/// 纯函数：更新 dotenv 文本中指定 key 的值（value=None 时删除），保留其他行和注释。
fn write_dotenv_value(content: &str, key: &str, value: Option<&str>) -> String {
    let line_break = if content.contains("\\r\\n") { "\\r\\n" } else { "\\n" };
    let mut lines: Vec<String> = Vec::new();
    let mut replaced = false;

    for line in content.split("\\r\\n") {
        if find_dotenv_value(&format!("{line}\\n"), key).is_some() || line_is_key(line, key) {
            if let Some(v) = value {
                if !replaced {
                    lines.push(format!("{key}={v}"));
                    replaced = true;
                }
            }
            continue;
        }
        lines.push(line.to_string());
    }

    if !replaced {
        if let Some(v) = value {
            if !lines.is_empty() && !lines.last().map(|l| l.trim().is_empty()).unwrap_or(true) {
                lines.push(String::new());
            }
            lines.push(format!("{key}={v}"));
        }
    }

    let mut result = lines.join(line_break);
    if value.is_some() && !result.ends_with(line_break) {
        result.push_str(line_break);
    }
    result
}

/// 判断一行是否为指定 key 的赋值行（支持 export 前缀）。
fn line_is_key(line: &str, key: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return false;
    }
    let Some((name, _)) = trimmed.split_once('=') else { return false; };
    let name = name.trim().strip_prefix("export ").unwrap_or(name).trim();
    name == key
}
\`\`\`

在 src-tauri/src/commands/mod.rs 或 builtin_agent.rs 中注册 command：

\`\`\`rust
.invoke_handler(tauri::generate_handler![
    // ... 现有 handlers ...
    crate::acp::launch::get_sidecar_env,
    crate::acp::launch::set_sidecar_env,
])
\`\`\`

⚠️ 注意：find_dotenv_value 和 read_dotenv_key 当前是私有函数，需改为 pub(super) 或 pub(crate)。
⚠️ set_sidecar_env 的 value 参数前端传 null 时 serde 会反序列化为 None。
`);
}

function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  TAVILY_API_KEY IPC 迁移脚本                              ║');
  console.log(`║  模式: ${DRY_RUN ? 'DRY-RUN（预览）' : 'WRITE（实际写入）'}${' '.repeat(30 - (DRY_RUN ? 16 : 18))}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  printRustCode();

  let success = 0;
  let failed = 0;

  try { patchPackageJson(); success++; } catch (e) { console.error(`  ✗ package.json 失败: ${e.message}`); failed++; }
  try { patchSidecarTs(); success++; } catch (e) { console.error(`  ✗ sidecar.ts 失败: ${e.message}`); failed++; }
  try { patchAiServiceTs(); success++; } catch (e) { console.error(`  ✗ ai.service.ts 失败: ${e.message}`); failed++; }

  console.log('\n─────────────────────────────────────────────────');
  console.log(`完成: ${success} 成功, ${failed} 失败`);
  if (DRY_RUN) {
    console.log('\n📌 当前为 DRY-RUN 模式，未实际写入文件。');
    console.log('   添加 --write 参数执行实际修改。');
    console.log('\n⚠️ 前置条件：请先手动添加 Rust 侧 command（见上方代码块），');
    console.log('   cargo check 通过后再执行 --write。');
  } else {
    console.log('\n验证命令:');
    console.log('   cd src-tauri && cargo check');
    console.log('   pnpm install');
    console.log('   pnpm lint && pnpm typecheck && pnpm test');
    console.log('\n回退:');
    console.log('   git checkout HEAD -- package.json src/services/ipc/ai.service.ts src/services/tauri/sidecar.ts');
    console.log('   pnpm install');
  }
  console.log('─────────────────────────────────────────────────');
}

main();
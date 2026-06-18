#!/usr/bin/env node
/**
 * calamex 源码修复脚本 v5
 * - storage_paths.rs: 已由 v2 修复，跳过
 * - workspace_fs.rs: GBK 补丁已由 v4 应用；resolve_save_script_path 用行级替换修复
 * - launch.rs / tauri.sidecar.ts / git.ts: 首次应用
 * 用法: node fix-calamex-issues.mjs [仓库根目录]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(process.argv[2] ?? 'D:\\com.xiaojianc\\my_desktop_app');

function getEol(raw) {
  return raw.includes('\r\n') ? '\r\n' : '\n';
}
function writeFile(fullPath, content, eol) {
  writeFileSync(fullPath, content.replace(/\n/g, eol), 'utf-8');
}

// ─── 行级函数替换：按 fn 名定位 → 找到行首 } 结束 → 整体替换 ───
function replaceFunction(filePath, funcName, newFuncLines) {
  const fullPath = join(repoRoot, filePath);
  const raw = readFileSync(fullPath, 'utf-8');
  const eol = getEol(raw);
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const startIdx = lines.findIndex(l => l.includes(`fn ${funcName}(`));
  if (startIdx === -1) throw new Error(`Function ${funcName} not found in ${filePath}`);
  let endIdx = startIdx + 1;
  while (endIdx < lines.length && lines[endIdx] !== '}') endIdx++;
  if (endIdx >= lines.length) throw new Error(`End brace not found for ${funcName}`);
  lines.splice(startIdx, endIdx - startIdx + 1, ...newFuncLines);
  writeFile(fullPath, lines.join('\n'), eol);
  console.log(`  ✓ [${filePath}] replaced function ${funcName}`);
}

// ─── 行级注释替换：按 ASCII 前缀定位行 → 整行替换 ───
function patchLine(filePath, matchPrefix, newLine) {
  const fullPath = join(repoRoot, filePath);
  const raw = readFileSync(fullPath, 'utf-8');
  const eol = getEol(raw);
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const idx = lines.findIndex(l => l.includes(matchPrefix));
  if (idx === -1) throw new Error(`Line with "${matchPrefix}" not found in ${filePath}`);
  lines[idx] = newLine;
  writeFile(fullPath, lines.join('\n'), eol);
  console.log(`  ✓ [${filePath}] patched comment line`);
}

// ─── ASCII-only 精确字符串替换 ───
function patchAscii(filePath, patches) {
  const fullPath = join(repoRoot, filePath);
  const raw = readFileSync(fullPath, 'utf-8');
  const eol = getEol(raw);
  let content = raw.replace(/\r\n/g, '\n');
  for (const { name, find, replace } of patches) {
    const f = find.replace(/\r\n/g, '\n');
    const r = replace.replace(/\r\n/g, '\n');
    const idx = content.indexOf(f);
    if (idx === -1) throw new Error(`✗ ${name}: not found in ${filePath}`);
    if (content.indexOf(f, idx + 1) !== -1) throw new Error(`✗ ${name}: multiple matches in ${filePath}`);
    content = content.slice(0, idx) + r + content.slice(idx + f.length);
    console.log(`  ✓ [${filePath}] ${name}`);
  }
  writeFile(fullPath, content, eol);
}

// ═══════════════════════════════════════════
// 1. workspace_fs.rs — 行级替换 resolve_save_script_path 整个函数
// ═══════════════════════════════════════════

replaceFunction('src-tauri/src/commands/workspace_fs.rs', 'resolve_save_script_path', [
  'fn resolve_save_script_path(',
  '    raw_path: &str,',
  '    workspace_root_path: Option<String>,',
  ') -> Result<PathBuf, String> {',
  '    let raw_path = PathBuf::from(raw_path);',
  '    let file_name = raw_path',
  '        .file_name()',
  '        .ok_or_else(|| "无法解析目标文件名。".to_string())?',
  '        .to_owned();',
  '    let parent = raw_path',
  '        .parent()',
  '        .filter(|parent| !parent.as_os_str().is_empty())',
  '        .map(Path::to_path_buf)',
  '        .unwrap_or_else(|| PathBuf::from("."));',
  '',
  '    // 先对父目录（或其最近的已存在祖先）做 canonicalize + 工作区边界检查，',
  '    // 确认安全后再创建缺失的中间目录，避免在边界外创建目录结构。',
  '    let boundary_check_path = parent.canonicalize().unwrap_or_else(|_| {',
  '        let mut ancestor = parent.as_path();',
  '        while let Some(grandparent) = ancestor.parent() {',
  '            if let Ok(canon) = grandparent.canonicalize() {',
  '                return canon;',
  '            }',
  '            ancestor = grandparent;',
  '        }',
  '        parent.clone()',
  '    });',
  '    ensure_optional_workspace_boundary(&boundary_check_path, workspace_root_path.clone())?;',
  '',
  '    fs::create_dir_all(&parent).map_err(|error| format!("创建目录失败：{error}"))?;',
  '',
  '    let file_path = parent',
  '        .canonicalize()',
  '        .map_err(|error| format!("解析目标目录失败：{error}"))?',
  '        .join(&file_name);',
  '',
  '    ensure_optional_workspace_boundary(&file_path, workspace_root_path)',
  '}',
]);

// 修复测试注释（v4 改了函数名和断言，但注释仍写 GB18030）
patchLine('src-tauri/src/commands/workspace_fs.rs',
  '// GB18030 ',
  '        // GBK 编码的"中"（0xD6 0xD0）不是合法 UTF-8，且不含 BOM / NUL，应回退到 GBK。'
);

// ═══════════════════════════════════════════
// 2. acp/launch.rs — export 前缀 + 测试
// ═══════════════════════════════════════════

patchAscii('src-tauri/src/acp/launch.rs', [
  {
    name: '#4 export prefix',
    find: `        if name.trim() != key {
            continue;
        }`,
    replace: `        // Strip "export " prefix for Unix shell convention: export KEY=value
        let name = name.trim();
        let name = name.strip_prefix("export ").unwrap_or(name).trim();

        if name != key {
            continue;
        }`,
  },
  {
    name: '#4 export test',
    find: `    #[test]
    fn find_dotenv_value_returns_none_for_missing_or_empty() {`,
    replace: `    #[test]
    fn find_dotenv_value_strips_export_prefix() {
        assert_eq!(
            find_dotenv_value("export TAVILY_API_KEY=tvly-exported", "TAVILY_API_KEY")
                .as_deref(),
            Some("tvly-exported")
        );
    }

    #[test]
    fn find_dotenv_value_returns_none_for_missing_or_empty() {`,
  },
]);

// ═══════════════════════════════════════════
// 3. tauri.sidecar.ts — 超时注释 + dev 警告
// ═══════════════════════════════════════════

patchAscii('src/services/tauri.sidecar.ts', [
  {
    name: '#7 timeout comment',
    find: `const AGENT_SIDECAR_TASK_TIMEOUT_MS = 30 * 60 * 1000;`,
    replace: `/** 30min timeout: AI agent tasks may run long; this is an IPC safety net,
 * not a business timeout. Server has its own task timeout. */
const AGENT_SIDECAR_TASK_TIMEOUT_MS = 30 * 60 * 1000;`,
  },
  {
    name: '#5 stream dev warn',
    find: `      if (!parsed.success) {
        return;
      }
      // wire`,
    replace: `      if (!parsed.success) {
        if (import.meta.env.DEV) {
          console.warn('[sidecar] stream event schema validation failed', parsed.error);
        }
        return;
      }
      // wire`,
  },
  {
    name: '#5 approval dev warn',
    find: `      if (!parsed.success) {
        return;
      }
      handler(parsed.data);`,
    replace: `      if (!parsed.success) {
        if (import.meta.env.DEV) {
          console.warn('[sidecar] ACP approval schema validation failed', parsed.error);
        }
        return;
      }
      handler(parsed.data);`,
  },
]);

// ═══════════════════════════════════════════
// 4. git.ts — 错误日志
// ═══════════════════════════════════════════

patchAscii('src/store/git.ts', [
  {
    name: '#6 commit stats log',
    find: `        } catch {
          // Commit stats are pure background optimization.
        } finally {`,
    replace: `        } catch (error) {
          console.warn('[git] background commit stats load failed', error);
        } finally {`,
  },
  {
    name: '#6 PR detail preload log',
    find: `        }).catch(() => undefined);`,
    replace: `        }).catch((error) => {
          console.warn('[git] background PR detail preload failed', pullRequest.number, error);
        });`,
  },
  {
    name: '#6 PR preload log',
    find: `    } catch {
      // Background PR preloading is best-effort only.
    }`,
    replace: `    } catch (error) {
      console.warn('[git] background PR preload failed', error);
    }`,
  },
]);

console.log('\n✅ Done. Verify with:');
console.log('  pnpm typecheck');
console.log('  cd src-tauri && cargo test');
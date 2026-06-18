#!/usr/bin/env node
/**
 * calamex 源码修复脚本 v4
 * - storage_paths.rs 已由 v2 应用，跳过
 * - 其余文件均为原始状态，全部重新应用
 * - 所有匹配只用 ASCII 子串，避免中文编码问题
 * 用法: node fix-calamex-issues.mjs [仓库根目录]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(process.argv[2] ?? 'D:\\com.xiaojianc\\my_desktop_app');

function patch(filePath, finds, replaces) {
  const fullPath = join(repoRoot, filePath);
  let content = readFileSync(fullPath, 'utf-8').replace(/\r\n/g, '\n');
  for (let i = 0; i < finds.length; i++) {
    const find = finds[i].replace(/\r\n/g, '\n');
    const replace = replaces[i].replace(/\r\n/g, '\n');
    const idx = content.indexOf(find);
    if (idx === -1) {
      throw new Error(`Patch ${i + 1} failed: substring not found in ${filePath}`);
    }
    if (content.indexOf(find, idx + 1) !== -1) {
      throw new Error(`Patch ${i + 1} failed: multiple matches in ${filePath}`);
    }
    content = content.slice(0, idx) + replace + content.slice(idx + find.length);
    console.log(`  [${filePath}] patch ${i + 1} ok`);
  }
  writeFileSync(fullPath, content, 'utf-8');
}

// ═══════════════════════════════════════════
// workspace_fs.rs — 全部 4 个补丁（文件未修改过）
// ═══════════════════════════════════════════

patch('src-tauri/src/commands/workspace_fs.rs', [
  // Patch 1: resolve_save_script_path — 匹配 ASCII 函数体
  `fn resolve_save_script_path(
    raw_path: &str,
    workspace_root_path: Option<String>,
) -> Result<PathBuf, String> {`,
  // Patch 2: GBK import
  `use encoding_rs::{GB18030, UTF_8, UTF_16BE, UTF_16LE};`,
  // Patch 3: GBK decode — 只匹配这三行 ASCII 代码
  `    let (gb18030, _, gb_errors) = GB18030.decode(bytes);
    if !gb_errors {
        return Ok((gb18030.into_owned(), DocumentEncoding::Gb18030));
    }`,
  // Patch 4: 测试函数名 (ASCII only)
  `fn falls_back_to_gb18030_for_non_utf8_bytes() {`,
  // Patch 5: 测试 expect 字符串
  `decode_script_bytes(&bytes).expect("decode gb18030")`,
  // Patch 6: 测试断言
  `assert_eq!(encoding.as_str(), "gb18030");`,
], [
  // Replace 1
  `fn resolve_save_script_path(
    raw_path: &str,
    workspace_root_path: Option<String>,
) -> Result<PathBuf, String> {
    // --- v4 patch: boundary check BEFORE create_dir_all ---
    let raw_path = PathBuf::from(raw_path);`,
  // Replace 2
  `use encoding_rs::{GB18030, GBK, UTF_8, UTF_16BE, UTF_16LE};`,
  // Replace 3
  `    // GBK first (subset of GB18030): decode GBK files as Gbk, not Gb18030.
    let (gbk, _, gbk_errors) = GBK.decode(bytes);
    if !gbk_errors {
        return Ok((gbk.into_owned(), DocumentEncoding::Gbk));
    }

    let (gb18030, _, gb_errors) = GB18030.decode(bytes);
    if !gb_errors {
        return Ok((gb18030.into_owned(), DocumentEncoding::Gb18030));
    }`,
  // Replace 4
  `fn falls_back_to_gbk_for_non_utf8_bytes() {`,
  // Replace 5
  `decode_script_bytes(&bytes).expect("decode gbk")`,
  // Replace 6
  `assert_eq!(encoding.as_str(), "gbk");`,
]);

// Patch 1 needs the function body replaced too — do it as a second pass
// on the same file, matching the old body (ASCII-only lines up to the boundary check)
patch('src-tauri/src/commands/workspace_fs.rs', [
  // Match from the v4 marker to the end of the old function body (ASCII only)
  `    // --- v4 patch: boundary check BEFORE create_dir_all ---
    let raw_path = PathBuf::from(raw_path);
    let file_name = raw_path
        .file_name()
        .ok_or_else(|| "\u{65e0}\u{6cd5}\u{89e3}\u{6790}\u{76ee}\u{6807}\u{6587}\u{4ef6}\u{540d}\u{3002}".to_string())?
        .to_owned();
    let parent = raw_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    fs::create_dir_all(&parent).map_err(|error| format!("\u{521b}\u{5efa}\u{76ee}\u{5f55}\u{5931}\u{8d25}\u{ff1a}{error}"))?;

    let file_path = parent
        .canonicalize()
        .map_err(|error| format!("\u{89e3}\u{6790}\u{76ee}\u{6807}\u{76ee}\u{5f55}\u{5931}\u{8d25}\u{ff1a}{error}"))?
        .join(&file_name);

    ensure_optional_workspace_boundary(&file_path, workspace_root_path)
}`,
], [
  `    // --- v4 patch: boundary check BEFORE create_dir_all ---
    let raw_path = PathBuf::from(raw_path);
    let file_name = raw_path
        .file_name()
        .ok_or_else(|| "\u{65e0}\u{6cd5}\u{89e3}\u{6790}\u{76ee}\u{6807}\u{6587}\u{4ef6}\u{540d}\u{3002}".to_string())?
        .to_owned();
    let parent = raw_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    // Canonicalize parent or its nearest existing ancestor, then boundary-check
    // BEFORE creating any directories, to prevent writing outside workspace.
    let boundary_check_path = parent.canonicalize().unwrap_or_else(|_| {
        let mut ancestor = parent.as_path();
        while let Some(grandparent) = ancestor.parent() {
            if let Ok(canon) = grandparent.canonicalize() {
                return canon;
            }
            ancestor = grandparent;
        }
        parent.clone()
    });
    ensure_optional_workspace_boundary(&boundary_check_path, workspace_root_path.clone())?;

    fs::create_dir_all(&parent).map_err(|error| format!("\u{521b}\u{5efa}\u{76ee}\u{5f55}\u{5931}\u{8d25}\u{ff1a}{error}"))?;

    let file_path = parent
        .canonicalize()
        .map_err(|error| format!("\u{89e3}\u{6790}\u{76ee}\u{6807}\u{76ee}\u{5f55}\u{5931}\u{8d25}\u{ff1a}{error}"))?
        .join(&file_name);

    ensure_optional_workspace_boundary(&file_path, workspace_root_path)
}`,
]);

// ═══════════════════════════════════════════
// acp/launch.rs — 2 patches
// ═══════════════════════════════════════════

patch('src-tauri/src/acp/launch.rs', [
  // Patch 1: export prefix — match ASCII-only code
  `        if name.trim() != key {
            continue;
        }`,
  // Patch 2: add test before existing test (ASCII match)
  `    #[test]
    fn find_dotenv_value_returns_none_for_missing_or_empty() {`,
], [
  // Replace 1
  `        // Strip "export " prefix for Unix shell convention: export KEY=value
        let name = name.trim();
        let name = name.strip_prefix("export ").unwrap_or(name).trim();

        if name != key {
            continue;
        }`,
  // Replace 2
  `    #[test]
    fn find_dotenv_value_strips_export_prefix() {
        assert_eq!(
            find_dotenv_value("export TAVILY_API_KEY=tvly-exported", "TAVILY_API_KEY")
                .as_deref(),
            Some("tvly-exported")
        );
    }

    #[test]
    fn find_dotenv_value_returns_none_for_missing_or_empty() {`,
]);

// ═══════════════════════════════════════════
// tauri.sidecar.ts — 3 patches
// ═══════════════════════════════════════════

patch('src/services/tauri.sidecar.ts', [
  // Patch 1: timeout constant (ASCII)
  `const AGENT_SIDECAR_TASK_TIMEOUT_MS = 30 * 60 * 1000;`,
  // Patch 2: stream event (ASCII)
  `      if (!parsed.success) {
        return;
      }
      // wire`,
  // Patch 3: ACP approval (ASCII)
  `      if (!parsed.success) {
        return;
      }
      handler(parsed.data);`,
], [
  // Replace 1
  `/** 30min timeout: AI agent tasks may run long; this is an IPC safety net,
 * not a business timeout. Server has its own task timeout. Frontend only
 * holds a Promise reference during this period. */
const AGENT_SIDECAR_TASK_TIMEOUT_MS = 30 * 60 * 1000;`,
  // Replace 2
  `      if (!parsed.success) {
        if (import.meta.env.DEV) {
          console.warn('[sidecar] stream event schema validation failed', parsed.error);
        }
        return;
      }
      // wire`,
  // Replace 3
  `      if (!parsed.success) {
        if (import.meta.env.DEV) {
          console.warn('[sidecar] ACP approval schema validation failed', parsed.error);
        }
        return;
      }
      handler(parsed.data);`,
]);

// ═══════════════════════════════════════════
// git.ts — 3 patches
// ═══════════════════════════════════════════

patch('src/store/git.ts', [
  // Patch 1: commit stats catch (ASCII)
  `        } catch {
          // Commit stats are pure background optimization.
        } finally {`,
  // Patch 2: PR detail preload catch (ASCII)
  `        }).catch(() => undefined);`,
  // Patch 3: PR preload catch (ASCII)
  `    } catch {
      // Background PR preloading is best-effort only.
    }`,
], [
  // Replace 1
  `        } catch (error) {
          console.warn('[git] background commit stats load failed', error);
        } finally {`,
  // Replace 2
  `        }).catch((error) => {
          console.warn('[git] background PR detail preload failed', pullRequest.number, error);
        });`,
  // Replace 3
  `    } catch (error) {
      console.warn('[git] background PR preload failed', error);
    }`,
]);

console.log('\nDone. Verify with:');
console.log('  pnpm typecheck');
console.log('  cd src-tauri && cargo test');
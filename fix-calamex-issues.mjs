#!/usr/bin/env node
/**
 * calamex 源码修复脚本 v3 — 仅剩余补丁
 * 前 5 个补丁已应用，此脚本处理剩余 9 个。
 * 用法: node fix-calamex-issues.mjs [仓库根目录]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(process.argv[2] ?? 'D:\\com.xiaojianc\\my_desktop_app');

function applyPatch(filePath, patches) {
  const fullPath = join(repoRoot, filePath);
  const raw = readFileSync(fullPath, 'utf-8');
  let content = raw.replace(/\r\n/g, '\n');
  for (const { name, find, replace } of patches) {
    const findNorm = find.replace(/\r\n/g, '\n');
    const idx = content.indexOf(findNorm);
    if (idx === -1) {
      throw new Error(`✗ ${name}\n  未找到匹配文本`);
    }
    // 检查唯一性
    if (content.indexOf(findNorm, idx + 1) !== -1) {
      throw new Error(`✗ ${name}\n  匹配到多处，需精确匹配`);
    }
    content = content.slice(0, idx) + findNorm.replace(findNorm, replace.replace(/\r\n/g, '\n')) + content.slice(idx + findNorm.length);
    console.log(`  ✓ ${name}`);
  }
  writeFileSync(fullPath, content, 'utf-8');
}

// ═══════════════════════════════════════════
// 1. workspace_fs.rs — #8 更新 GBK 测试
// ═══════════════════════════════════════════

applyPatch('src-tauri/src/commands/workspace_fs.rs', [
  {
    name: '#8 更新 GBK 测试',
    find: `    #[test]
    fn falls_back_to_gb18030_for_non_utf8_bytes() {
        // GB18030 编码的"中"（0xD6 0xD0）不是合法 UTF-8，且不含 BOM / NUL，应回退到 GB18030。
        let bytes = [0xD6, 0xD0];
        let (content, encoding) = decode_script_bytes(&bytes).expect("decode gb18030");
        assert_eq!(content, "中");
        assert_eq!(encoding.as_str(), "gb18030");
    }`,
    replace: `    #[test]
    fn falls_back_to_gbk_for_non_utf8_bytes() {
        // GBK 编码的"中"（0xD6 0xD0）不是合法 UTF-8，且不含 BOM / NUL，应回退到 GBK。
        let bytes = [0xD6, 0xD0];
        let (content, encoding) = decode_script_bytes(&bytes).expect("decode gbk");
        assert_eq!(content, "中");
        assert_eq!(encoding.as_str(), "gbk");
    }`,
  },
]);

// ═══════════════════════════════════════════
// 2. acp/launch.rs — #4 export 前缀
// ═══════════════════════════════════════════

applyPatch('src-tauri/src/acp/launch.rs', [
  {
    name: '#4 find_dotenv_value 去除 export 前缀',
    find: `        let Some((name, raw_value)) = trimmed.split_once('=') else {
            continue;
        };

        if name.trim() != key {
            continue;
        }`,
    replace: `        let Some((name, raw_value)) = trimmed.split_once('=') else {
            continue;
        };

        // 兼容 Unix shell 惯用写法：\`export KEY=value\`，去除 \`export\` 前缀后再比较。
        let name = name.trim();
        let name = name.strip_prefix("export ").unwrap_or(name).trim();

        if name != key {
            continue;
        }`,
  },
  {
    name: '#4 添加 export 前缀测试',
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
// 3. tauri.sidecar.ts — #5 #7
// ═══════════════════════════════════════════

applyPatch('src/services/tauri.sidecar.ts', [
  {
    name: '#7 超时常量增加注释',
    find: `const AGENT_SIDECAR_TASK_TIMEOUT_MS = 30 * 60 * 1000;`,
    replace: `/**
 * 30 分钟超时：AI agent 任务（chat / orchestrate / checkpoint restore）可能运行较久，
 * 此超时作为 IPC 层兜底而非业务超时；服务端有自己的任务超时机制。
 * 前端在此期间仅持有 Promise 引用，无额外资源占用。
 */
const AGENT_SIDECAR_TASK_TIMEOUT_MS = 30 * 60 * 1000;`,
  },
  {
    name: '#5 stream event 校验失败增加 dev 警告',
    find: `    return listen('ai:sidecar-stream', (event) => {
      const parsed = agentSidecarStreamEventPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        return;
      }`,
    replace: `    return listen('ai:sidecar-stream', (event) => {
      const parsed = agentSidecarStreamEventPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        if (import.meta.env.DEV) {
          console.warn('[sidecar] stream event schema validation failed', parsed.error);
        }
        return;
      }`,
  },
  {
    name: '#5 ACP approval 校验失败增加 dev 警告',
    find: `    return listen('ai:sidecar-approval', (event) => {
      const parsed = acpPermissionRequestPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        return;
      }`,
    replace: `    return listen('ai:sidecar-approval', (event) => {
      const parsed = acpPermissionRequestPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        if (import.meta.env.DEV) {
          console.warn('[sidecar] ACP approval schema validation failed', parsed.error);
        }
        return;
      }`,
  },
]);

// ═══════════════════════════════════════════
// 4. git.ts — #6 错误日志
// ═══════════════════════════════════════════

applyPatch('src/store/git.ts', [
  {
    name: '#6 commit stats 后台错误增加日志',
    find: `        } catch {
          // Commit stats are pure background optimization.
        } finally {`,
    replace: `        } catch (error) {
          console.warn('[git] background commit stats load failed', error);
        } finally {`,
  },
  {
    name: '#6 PR detail 预加载错误增加日志',
    find: `        await loadPullRequestDetail(pullRequest.number, {
          updateActive: false,
          visibleLoading: false,
        }).catch(() => undefined);`,
    replace: `        await loadPullRequestDetail(pullRequest.number, {
          updateActive: false,
          visibleLoading: false,
        }).catch((error) => {
          console.warn('[git] background PR detail preload failed', pullRequest.number, error);
        });`,
  },
  {
    name: '#6 PR 后台预加载错误增加日志',
    find: `    } catch {
      // Background PR preloading is best-effort only.
    }`,
    replace: `    } catch (error) {
      console.warn('[git] background PR preload failed', error);
    }`,
  },
]);

console.log('\n✅ 剩余补丁已应用完毕。');
console.log('   验证命令：');
console.log('     pnpm typecheck');
console.log('     cd src-tauri && cargo test');
// fix-batch-1.mjs
// Calamex 代码审查第一批修复：S-1 / S-2 / S-3
// 用法: node fix-batch-1.mjs
// 在仓库根目录 D:\com.xiaojianc\my_desktop_app 下运行

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = process.cwd();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 工具函数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 精确替换：要求 oldStr 在文件中唯一存在且只出现一次。
 * 替换失败（0 次或 >1 次）会抛异常，不静默写入。
 */
function replaceExact(filePath, oldStr, newStr, label) {
  const abs = join(root, filePath);
  const content = readFileSync(abs, 'utf-8');

  const count = content.split(oldStr).length - 1;
  if (count === 0) {
    throw new Error(`[${label}] 未找到匹配的原始代码块，文件可能已被修改:\n  ${filePath}`);
  }
  if (count > 1) {
    throw new Error(`[${label}] 原始代码块匹配了 ${count} 处，需要更精确的上下文:\n  ${filePath}`);
  }

  const result = content.replace(oldStr, newStr);
  writeFileSync(abs, result, 'utf-8');
  console.log(`✅ [${label}] 已修改: ${filePath}`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// S-1: useShellWorkbenchView.ts — gitRemovedCount 恒为 0
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 修复内容：
// 1. 删除 gitAddedCount + gitRemovedCount 两个 computed
// 2. 新增 gitChangeSummary computed，按 Git status letter 精确分类
// 3. 在 return 块中把 gitRemovedCount 改为 gitChangeSummary.deleted
//    把 gitAddedCount 改为 gitChangeSummary.added
//    并导出 gitChangeSummary 供模板使用

const S1_FILE = 'src/composables/useShellWorkbenchView.ts';

// --- 1) 替换 computed 定义 ---
const S1_OLD_COMPUTED = `  const gitBranchName = computed(() => gitStore.status.headBranchName ?? null);
  const gitAddedCount = computed(
    () =>
      gitStore.status.stagedCount + gitStore.status.unstagedCount + gitStore.status.untrackedCount,
  );
  const gitRemovedCount = computed(() => 0);`;

const S1_NEW_COMPUTED = `  const gitBranchName = computed(() => gitStore.status.headBranchName ?? null);

  /**
   * 按 Git status letter 精确分类统计文件变更数。
   *
   * 修复：此前 gitRemovedCount 恒为 0（写死），且 gitAddedCount 把 modified
   * 文件也算进了「新增」。现在直接遍历 status.files 数组按 index/worktree
   * status 分类：A=新增、D=删除、M/R=修改、?=未跟踪。
   */
  const gitChangeSummary = computed(() => {
    const files = gitStore.status.files;
    let added = 0;
    let modified = 0;
    let deleted = 0;

    for (const file of files) {
      if (file.isUntracked) {
        added++;
        continue;
      }
      const status = file.indexStatus ?? file.worktreeStatus;
      switch (status) {
        case 'A':
        case '?':
          added++;
          break;
        case 'D':
          deleted++;
          break;
        case 'M':
        case 'R':
          modified++;
          break;
        default:
          // C (copy)、T (type change) 等归入 modified
          modified++;
          break;
      }
    }

    return { added, modified, deleted, total: files.length };
  });`;

// --- 2) 替换 return 块中的 gitAddedCount / gitRemovedCount ---
const S1_OLD_RETURN = `    gitBranchName,
    gitAddedCount,
    gitRemovedCount,`;

const S1_NEW_RETURN = `    gitBranchName,
    gitChangeSummary,`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// S-2: workspace_fs.rs — load_image_asset TOCTOUR
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 修复内容：用一次 symlink_metadata 同时完成「是文件」和「大小检查」，
// 缩小 TOCTOUR 窗口并拒绝 symlink。

const S2_FILE = 'src-tauri/src/commands/workspace_fs.rs';

const S2_OLD = `pub fn load_image_asset(app: tauri::AppHandle, path: String) -> Result<ImageAssetPayload, String> {
    let file_path = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("读取图片资源失败：{error}"))?;

    if !file_path.is_file() {
        return Err("目标图片不存在或不是有效文件。".into());
    }

    let byte_size = ensure_within_size_limit(&file_path, MAX_IMAGE_ASSET_BYTES, "图片资源")?;`;

const S2_NEW = `pub fn load_image_asset(app: tauri::AppHandle, path: String) -> Result<ImageAssetPayload, String> {
    let file_path = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("读取图片资源失败：{error}"))?;

    // 一次 symlink_metadata 同时完成「是否是文件」和「大小」检查，
    // 缩小 TOCTOUR 窗口且拒绝通过符号链接加载图片资源。
    let metadata = fs::symlink_metadata(&file_path)
        .map_err(|error| format!("读取图片资源元数据失败：{error}"))?;

    if metadata.is_symlink() {
        return Err("不支持通过符号链接加载图片资源。".into());
    }

    if !metadata.is_file() {
        return Err("目标图片不存在或不是有效文件。".into());
    }

    let byte_size = metadata.len();
    if byte_size > MAX_IMAGE_ASSET_BYTES {
        return Err(format!(
            "图片资源过大（{:.1} MB），超过 {} MB 上限，已取消读取。",
            byte_size as f64 / (1024.0 * 1024.0),
            MAX_IMAGE_ASSET_BYTES / (1024 * 1024)
        ));
    }`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// S-3: aiAgent.ts — addOfficialUsage 嵌套路径错误
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 修复内容：outputTokenDetails.outputTokenDetails.reasoningTokens
// 双层嵌套路径几乎肯定为 undefined，改为 outputTokenDetails?.reasoningTokens

const S3_FILE = 'src/store/aiAgent.ts';

const S3_OLD = `    reasoningTokens:
      addTokenCounts(
        current?.outputTokenDetails.outputTokenDetails.reasoningTokens,
        next.outputTokenDetails.outputTokenDetails.reasoningTokens,
      ) ?? 0,`;

const S3_NEW = `    reasoningTokens:
      addTokenCounts(
        current?.outputTokenDetails?.reasoningTokens,
        next.outputTokenDetails?.reasoningTokens,
      ) ?? 0,`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 执行
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

console.log('══════════════════════════════════════════════');
console.log('  Calamex 代码审查第一批修复 (S-1 / S-2 / S-3)');
console.log('  工作目录:', root);
console.log('══════════════════════════════════════════════\\n');

try {
  // S-1: 修复 gitRemovedCount 恒为 0
  replaceExact(S1_FILE, S1_OLD_COMPUTED, S1_NEW_COMPUTED, 'S-1 computed');
  replaceExact(S1_FILE, S1_OLD_RETURN, S1_NEW_RETURN, 'S-1 return');

  // S-2: 修复 load_image_asset TOCTOUR
  replaceExact(S2_FILE, S2_OLD, S2_NEW, 'S-2');

  // S-3: 修复 addOfficialUsage 嵌套路径
  replaceExact(S3_FILE, S3_OLD, S3_NEW, 'S-3');

  console.log('\\n══════════════════════════════════════════════');
  console.log('  ✓ 全部 3 项修复完成');
  console.log('  请运行以下命令验证:');
  console.log('    pnpm tsc --noEmit');
  console.log('    cargo test --manifest-path src-tauri/Cargo.toml');
  console.log('    cargo clippy --manifest-path src-tauri/Cargo.toml');
  console.log('══════════════════════════════════════════════');
} catch (error) {
  console.error('\\n✗ 修改失败:', error.message);
  console.error('  请检查文件是否已被修改或手动应用。');
  process.exit(1);
}
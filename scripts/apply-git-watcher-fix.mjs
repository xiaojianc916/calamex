#!/usr/bin/env node
// @ts-check
/**
 * 修复:工作区 watcher 屏蔽整个 .git,导致外部(VS Code)提交后
 * 应用内 git 面板状态不刷新。仅改 src-tauri/src/commands/workspace_watcher.rs。
 * 幂等 + fail-closed + 无备份。前端监听需另接,不在本脚本内。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TARGET = resolve(
  process.argv[2] ?? 'src-tauri/src/commands/workspace_watcher.rs',
);

/**
 * @param {string} msg
 * @returns {never}
 */
const die = (msg) => {
  console.error(`✗ ${msg}`);
  console.error('  已中止,未写入任何改动。');
  process.exit(1);
};

/** @returns {string} */
const readTarget = () => {
  try {
    return readFileSync(TARGET, 'utf8');
  } catch (e) {
    die(`无法读取目标文件 ${TARGET}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const src = readTarget();

// 基本健全性:确认确实是这个模块,避免改错文件。
for (const probe of ['fn is_ignored_change', 'struct WorkspaceFsEvent', 'IGNORED_DIR_NAMES']) {
  if (!src.includes(probe)) {
    die(`目标文件缺少预期标识 "${probe}",可能路径不对或版本差异过大。`);
  }
}

/**
 * @typedef {Object} Step
 * @property {string} id            步骤名(日志用)
 * @property {string} marker        已套用判定:命中则跳过该步
 * @property {string} [find]        待替换的精确锚点
 * @property {string} [replace]     替换内容
 * @property {boolean} [optional]   true 时:find 缺失则静默跳过(不视为错误)
 */

/** @type {Step[]} */
const STEPS = [
  // 0) 兜底:若本地仍把 ".git" 留在 IGNORED_DIR_NAMES 里,移除它(当前 main 已无)。
  {
    id: 'drop-.git-from-IGNORED_DIR_NAMES',
    marker: '__never_skip_via_marker__',
    optional: true,
    find: '    ".git",\n',
    replace: '',
  },

  // 1) 新增 .git 内部高频目录白名单常量。
  {
    id: 'add-IGNORED_GIT_INTERNAL_DIRS',
    marker: 'IGNORED_GIT_INTERNAL_DIRS',
    find: '    "__pycache__",\n];\n',
    replace:
      '    "__pycache__",\n];\n' +
      '\n' +
      '/// .git 内部高频/无意义子目录(如 .git/objects/**):继续忽略以免 commit/gc 刷屏;\n' +
      '/// 但 .git 顶层状态文件(HEAD/index/packed-refs)与 .git/refs、.git/logs 不在此列,\n' +
      '/// 予以放行,让外部 git commit / checkout / pull 能触发前端刷新。\n' +
      'const IGNORED_GIT_INTERNAL_DIRS: &[&str] = &["objects", "lfs", "tmp", "fsmonitor--daemon"];\n',
  },

  // 2) 新增 is_ignored_git_internal,并让 is_ignored_change 先放行 .git 状态文件。
  {
    id: 'rewrite-is_ignored_change',
    marker: 'fn is_ignored_git_internal',
    find:
      '/// 判断变更路径是否落在监听根下被忽略的目录内。\n' +
      'fn is_ignored_change(root: &Path, path: &Path) -> bool {\n' +
      '    let Some(relative) = relativize(root, path) else {\n' +
      '        // 无法判定归属(前缀形态不一致等)时放行,避免漏报真实改动。\n' +
      '        return false;\n' +
      '    };\n' +
      '    relative.components().any(|component| match component {\n' +
      '        Component::Normal(name) => IGNORED_DIR_NAMES\n' +
      '            .iter()\n' +
      '            .any(|ignored| os_str_eq(name, OsStr::new(ignored))),\n' +
      '        _ => false,\n' +
      '    })\n' +
      '}\n',
    replace:
      '/// .git 内部高频子目录(如 .git/objects/**)是否应忽略。\n' +
      '/// .git 顶层文件(HEAD/index/packed-refs)与 .git/refs、.git/logs 放行,\n' +
      '/// 这样外部 git commit / checkout / pull 能触发前端刷新。\n' +
      'fn is_ignored_git_internal(relative: &Path) -> bool {\n' +
      '    let mut normals = relative.components().filter_map(|component| match component {\n' +
      '        Component::Normal(name) => Some(name),\n' +
      '        _ => None,\n' +
      '    });\n' +
      '    match normals.next() {\n' +
      '        Some(first) if os_str_eq(first, OsStr::new(".git")) => match normals.next() {\n' +
      '            Some(second) => IGNORED_GIT_INTERNAL_DIRS\n' +
      '                .iter()\n' +
      '                .any(|dir| os_str_eq(second, OsStr::new(dir))),\n' +
      '            // .git 顶层文件(HEAD/index/packed-refs):放行\n' +
      '            None => false,\n' +
      '        },\n' +
      '        _ => false,\n' +
      '    }\n' +
      '}\n' +
      '\n' +
      '/// 判断变更路径是否落在监听根下被忽略的目录内。\n' +
      'fn is_ignored_change(root: &Path, path: &Path) -> bool {\n' +
      '    let Some(relative) = relativize(root, path) else {\n' +
      '        // 无法判定归属(前缀形态不一致等)时放行,避免漏报真实改动。\n' +
      '        return false;\n' +
      '    };\n' +
      '    // .git:只忽略高频内部目录,放行状态文件/refs/logs(外部 git 操作要能触发刷新)。\n' +
      '    if is_ignored_git_internal(&relative) {\n' +
      '        return true;\n' +
      '    }\n' +
      '    relative.components().any(|component| match component {\n' +
      '        Component::Normal(name) => IGNORED_DIR_NAMES\n' +
      '            .iter()\n' +
      '            .any(|ignored| os_str_eq(name, OsStr::new(ignored))),\n' +
      '        _ => false,\n' +
      '    })\n' +
      '}\n',
  },

  // 3) Linux filter_entry:路径感知剪枝(.git 本体监听,objects 等高频目录剪掉)。
  {
    id: 'path-aware-filter_entry',
    marker: '// .git 内部仅保留',
    find:
      '            entry\n' +
      '                .file_name()\n' +
      '                .to_str()\n' +
      '                .map(|name| !is_ignored_dir_name(name))\n' +
      '                .unwrap_or(true)\n' +
      '        })\n',
    replace:
      '            let Some(name) = entry.file_name().to_str() else {\n' +
      '                return true;\n' +
      '            };\n' +
      '            if is_ignored_dir_name(name) {\n' +
      '                return false;\n' +
      '            }\n' +
      '            // .git 内部仅保留 refs/logs 等状态目录,剪掉 objects 等高频目录,\n' +
      '            // 让外部 git 操作写入的引用/日志能触发监听,又不被对象库刷屏。\n' +
      '            if IGNORED_GIT_INTERNAL_DIRS\n' +
      '                .iter()\n' +
      '                .any(|dir| os_str_eq(OsStr::new(name), OsStr::new(dir)))\n' +
      '                && entry.path().components().any(|component| {\n' +
      '                    matches!(component, Component::Normal(n) if os_str_eq(n, OsStr::new(".git")))\n' +
      '                })\n' +
      '            {\n' +
      '                return false;\n' +
      '            }\n' +
      '            true\n' +
      '        })\n',
  },

  // 4) 修正主忽略测试:.git/HEAD 现在应放行;新增 .git 高频目录仍忽略 + 状态文件放行测试。
  {
    id: 'fix-and-add-tests',
    marker: 'fn keeps_git_state_file_changes',
    find:
      '    #[test]\n' +
      '    fn ignores_dependency_build_and_vcs_dirs() {\n' +
      '        let root = p("/ws");\n' +
      '        assert!(is_ignored_change(&root, &p("/ws/node_modules/lodash/index.js")));\n' +
      '        assert!(is_ignored_change(&root, &p("/ws/.git/HEAD")));\n' +
      '        assert!(is_ignored_change(&root, &p("/ws/src-tauri/target/debug/app")));\n' +
      '        assert!(is_ignored_change(&root, &p("/ws/web/dist/bundle.js")));\n' +
      '        assert!(is_ignored_change(&root, &p("/ws/api/__pycache__/mod.pyc")));\n' +
      '    }\n',
    replace:
      '    #[test]\n' +
      '    fn ignores_dependency_build_and_vcs_dirs() {\n' +
      '        let root = p("/ws");\n' +
      '        assert!(is_ignored_change(&root, &p("/ws/node_modules/lodash/index.js")));\n' +
      '        assert!(is_ignored_change(&root, &p("/ws/src-tauri/target/debug/app")));\n' +
      '        assert!(is_ignored_change(&root, &p("/ws/web/dist/bundle.js")));\n' +
      '        assert!(is_ignored_change(&root, &p("/ws/api/__pycache__/mod.pyc")));\n' +
      '        // .git 高频内部目录仍忽略(避免 commit/gc 刷屏)\n' +
      '        assert!(is_ignored_change(&root, &p("/ws/.git/objects/ab/cdef")));\n' +
      '    }\n' +
      '\n' +
      '    #[test]\n' +
      '    fn keeps_git_state_file_changes() {\n' +
      '        let root = p("/ws");\n' +
      '        // 外部 commit/checkout/pull 写入的 .git 状态文件必须放行,否则面板不刷新\n' +
      '        assert!(!is_ignored_change(&root, &p("/ws/.git/HEAD")));\n' +
      '        assert!(!is_ignored_change(&root, &p("/ws/.git/index")));\n' +
      '        assert!(!is_ignored_change(&root, &p("/ws/.git/packed-refs")));\n' +
      '        assert!(!is_ignored_change(&root, &p("/ws/.git/refs/heads/main")));\n' +
      '        assert!(!is_ignored_change(&root, &p("/ws/.git/logs/HEAD")));\n' +
      '    }\n',
  },

  // 5) 修正目录名测试:.git 不再整目录忽略。
  {
    id: 'fix-ignored_dir_name_matching',
    marker: 'assert!(!is_ignored_dir_name(".git"))',
    find: '        assert!(is_ignored_dir_name(".git"));\n',
    replace:
      '        assert!(!is_ignored_dir_name(".git")); // .git 改为按子路径精细判定,不再整目录忽略\n',
  },
];

let out = src;
let applied = 0;
let skipped = 0;

for (const step of STEPS) {
  if (step.marker !== '__never_skip_via_marker__' && out.includes(step.marker)) {
    console.log(`• 跳过 ${step.id}(已套用)`);
    skipped += 1;
    continue;
  }
  const { find, replace } = step;
  if (find === undefined || replace === undefined) {
    die(`步骤 ${step.id} 缺少 find/replace 定义(脚本内部错误)。`);
  }
  const count = out.split(find).length - 1;
  if (count === 0) {
    if (step.optional) {
      console.log(`• 跳过 ${step.id}(无需改动)`);
      skipped += 1;
      continue;
    }
    die(`步骤 ${step.id} 找不到锚点。文件可能已偏离预期版本,请人工核对。`);
  }
  if (count > 1) {
    die(`步骤 ${step.id} 锚点出现 ${count} 次(歧义),拒绝盲改。`);
  }
  // 用 split/join 而非 String.replace,避免替换串里的 $ 被特殊解释。
  out = out.split(find).join(replace);
  console.log(`✓ 套用 ${step.id}`);
  applied += 1;
}

// 套用后的一致性自检:任一不满足都中止不写。
/** @type {Array<[string, () => boolean]>} */
const invariants = [
  ['含 IGNORED_GIT_INTERNAL_DIRS 常量', () => out.includes('const IGNORED_GIT_INTERNAL_DIRS')],
  ['含 is_ignored_git_internal 函数', () => out.includes('fn is_ignored_git_internal')],
  ['含 keeps_git_state_file_changes 测试', () => out.includes('fn keeps_git_state_file_changes')],
  ['IGNORED_DIR_NAMES 不再含 .git', () => !/IGNORED_DIR_NAMES[^;]*"\.git"/s.test(out)],
  ['无旧断言 is_ignored_dir_name(".git") 为真', () => !out.includes('assert!(is_ignored_dir_name(".git"));')],
  ['无旧断言 .git/HEAD 被忽略', () => !out.includes('assert!(is_ignored_change(&root, &p("/ws/.git/HEAD")))')],
];
for (const [label, ok] of invariants) {
  if (!ok()) die(`一致性自检未通过:${label}。`);
}

if (applied === 0) {
  console.log('• 无改动(全部已是最终态)。');
  process.exit(0);
}

try {
  writeFileSync(TARGET, out, 'utf8');
} catch (e) {
  die(`写入失败:${e instanceof Error ? e.message : String(e)}`);
}

console.log(`\n完成:套用 ${applied} 步,跳过 ${skipped} 步。`);
console.log('下一步本地验证:cargo clippy && cargo test(workspace_watcher 相关用例应全绿)。');
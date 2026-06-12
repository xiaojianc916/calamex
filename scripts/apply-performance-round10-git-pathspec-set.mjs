#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const filePath = 'src-tauri/src/commands/git/status.rs';
const absolutePath = resolve(root, filePath);

const fail = (message) => {
  throw new Error(`[${filePath}] ${message}`);
};

let source = readFileSync(absolutePath, 'utf8');

const replaceOnce = (oldText, newText, label) => {
  if (source.includes(newText)) {
    return;
  }

  const count = source.split(oldText).length - 1;
  if (count !== 1) {
    fail(`${label}: expected 1 match, got ${count}`);
  }

  source = source.replace(oldText, newText);
};

// 1. stage_git_paths：pathspecs 建 set，精确路径 O(1) 命中。
replaceOnce(
  `    if pathspecs.is_empty() {
        return build_git_repository_status_payload(&repository);
    }

    // 通过 gix 计算当前状态，得到所有可暂存的变更文件（已遵循 .gitignore），`,
  `    if pathspecs.is_empty() {
        return build_git_repository_status_payload(&repository);
    }
    let exact_pathspecs: std::collections::HashSet<&str> =
        pathspecs.iter().map(String::as_str).collect();

    // 通过 gix 计算当前状态，得到所有可暂存的变更文件（已遵循 .gitignore），`,
  'add exact pathspec set to stage_git_paths',
);

replaceOnce(
  `        if !pathspecs
            .iter()
            .any(|pathspec| pathspec_matches(pathspec, rel))
        {
            continue;
        }`,
  `        if !exact_pathspecs.contains(rel)
            && !pathspecs
                .iter()
                .any(|pathspec| pathspec_matches(pathspec, rel))
        {
            continue;
        }`,
  'use exact pathspec set in stage_git_paths',
);

// 2. unstage_git_paths：同样优化索引路径匹配。
replaceOnce(
  `    if pathspecs.is_empty() {
        return build_git_repository_status_payload(&repository);
    }

    let mut index = open_mut_index_or_empty(&repository)?;`,
  `    if pathspecs.is_empty() {
        return build_git_repository_status_payload(&repository);
    }
    let exact_pathspecs: std::collections::HashSet<&str> =
        pathspecs.iter().map(String::as_str).collect();

    let mut index = open_mut_index_or_empty(&repository)?;`,
  'add exact pathspec set to unstage_git_paths',
);

replaceOnce(
  `        if pathspecs
            .iter()
            .any(|pathspec| pathspec_matches(pathspec, &entry_path))
        {
            targets.insert(entry_path);
        }`,
  `        if exact_pathspecs.contains(entry_path.as_str())
            || pathspecs
                .iter()
                .any(|pathspec| pathspec_matches(pathspec, &entry_path))
        {
            targets.insert(entry_path);
        }`,
  'use exact pathspec set in unstage_git_paths',
);

writeFileSync(absolutePath, source, 'utf8');

console.log('Applied round10 Git pathspec set optimization.');
console.log('');
console.log('Touched:');
console.log(` - ${filePath}`);
console.log('');
console.log('Why:');
console.log(' - Avoids O(files * pathspecs) exact-path matching for large bulk stage/unstage operations.');
console.log(' - Keeps directory-prefix pathspec behavior as fallback.');
console.log('');
console.log('Next:');
console.log('  cd src-tauri && cargo fmt && cargo check');
console.log('  cargo test git::tests::stage_git_paths_and_unstage_git_paths_round_trip');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('');
console.log('Rollback:');
console.log(`  git checkout -- ${filePath}`);
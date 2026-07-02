#!/usr/bin/env node
// 修复：查 GitHub 登录态 / 拉 PR 列表 / 配置 git 远程时，git/gh 子进程未隐藏
// 控制台窗口，导致 Windows release 下切换 Git 侧边栏、窗口重新聚焦（含任务栏
// 恢复）时出现短暂控制台闪窗。
//
// 涉及文件：
//   src-tauri/src/commands/git/github_auth.rs
//   src-tauri/src/commands/git/pull_request.rs
//
// 用法：
//   node fix-git-credential-console-flash.mjs          # 预览
//   node fix-git-credential-console-flash.mjs --apply  # 实际写入

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const ROOT = process.cwd();

function readText(path) {
  const raw = readFileSync(path, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  return { raw, eol, normalized: raw.replace(/\r\n/g, "\n") };
}

function toEol(text, eol) {
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function patchFile(relPath, patches) {
  const filePath = join(ROOT, relPath);
  const { eol, normalized } = readText(filePath);
  let content = normalized;
  let changed = false;

  for (const { name, find, replace, alreadyDone } of patches) {
    if (alreadyDone && content.includes(alreadyDone)) {
      console.log(`  [skip] ${relPath} :: ${name} 已修复，跳过`);
      continue;
    }
    const occurrences = countOccurrences(content, find);
    if (occurrences === 0) {
      throw new Error(`${relPath} :: ${name} 未找到锚点，代码可能已变化，请重新核对后再运行。`);
    }
    if (occurrences > 1) {
      throw new Error(`${relPath} :: ${name} 锚点出现 ${occurrences} 次，不唯一，已中止。`);
    }
    content = content.replace(find, replace);
    changed = true;
    console.log(`  [ok] ${relPath} :: ${name}`);
  }

  if (!changed) return;
  if (!APPLY) {
    console.log(`  (预览模式，未写入 ${relPath}；加 --apply 实际写入)`);
    return;
  }
  writeFileSync(filePath, toEol(content, eol), "utf8");
  console.log(`  已写入 ${relPath}`);
}

console.log("== 修复 GitHub 凭据 / git 远程子进程控制台闪窗 ==");

patchFile("src-tauri/src/commands/git/github_auth.rs", [
  {
    name: "resolve_git_credential_token 隐藏控制台窗口",
    alreadyDone: `let mut command = tokio::process::Command::new("git");
    crate::commands::configure_tokio_command_for_background(&mut command);`,
    find: `async fn resolve_git_credential_token(
    repository_root: &std::path::Path,
    host: &str,
) -> Option<String> {
    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(repository_root)
        .arg("credential")
        .arg("fill")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    let mut child = command.spawn().ok()?;`,
    replace: `async fn resolve_git_credential_token(
    repository_root: &std::path::Path,
    host: &str,
) -> Option<String> {
    let mut command = tokio::process::Command::new("git");
    crate::commands::configure_tokio_command_for_background(&mut command);
    command
        .arg("-C")
        .arg(repository_root)
        .arg("credential")
        .arg("fill")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    let mut child = command.spawn().ok()?;`,
  },
  {
    name: "resolve_github_cli_token 隐藏控制台窗口",
    alreadyDone: `fn resolve_github_cli_token(host: &str) -> Option<String> {
    let mut command = std::process::Command::new("gh");
    crate::commands::configure_std_command_for_background(&mut command);`,
    find: `fn resolve_github_cli_token(host: &str) -> Option<String> {
    let output = std::process::Command::new("gh")
        .arg("auth")
        .arg("token")
        .arg("--hostname")
        .arg(host)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;`,
    replace: `fn resolve_github_cli_token(host: &str) -> Option<String> {
    let mut command = std::process::Command::new("gh");
    crate::commands::configure_std_command_for_background(&mut command);
    let output = command
        .arg("auth")
        .arg("token")
        .arg("--hostname")
        .arg(host)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;`,
  },
]);

patchFile("src-tauri/src/commands/git/pull_request.rs", [
  {
    name: "run_git_remote_subcommand 隐藏控制台窗口",
    alreadyDone: `let mut command = std::process::Command::new("git");
    crate::commands::configure_std_command_for_background(&mut command);
    let output = command
        .arg("-C")
        .arg(repository_root)
        .arg("remote")`,
    find: `let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repository_root)
        .arg("remote")
        .arg(subcommand)
        .arg(remote_name)
        .arg(remote_url)
        .output()
        .map_err(|error| format!("调用 git 配置远程失败：{error}"))?;`,
    replace: `let mut command = std::process::Command::new("git");
    crate::commands::configure_std_command_for_background(&mut command);
    let output = command
        .arg("-C")
        .arg(repository_root)
        .arg("remote")
        .arg(subcommand)
        .arg(remote_name)
        .arg(remote_url)
        .output()
        .map_err(|error| format!("调用 git 配置远程失败：{error}"))?;`,
  },
  {
    name: "resolve_github_credential 隐藏控制台窗口",
    alreadyDone: `let mut command = tokio::process::Command::new("git");
        crate::commands::configure_tokio_command_for_background(&mut command);
        command
            .arg("-C")
            .arg(repository_root)
            .arg("credential")
            .arg("fill")`,
    find: `let mut command = tokio::process::Command::new("git");
        command
            .arg("-C")
            .arg(repository_root)
            .arg("credential")
            .arg("fill")
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());

        let mut child = command.spawn().ok()?;`,
    replace: `let mut command = tokio::process::Command::new("git");
        crate::commands::configure_tokio_command_for_background(&mut command);
        command
            .arg("-C")
            .arg(repository_root)
            .arg("credential")
            .arg("fill")
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());

        let mut child = command.spawn().ok()?;`,
  },
]);

console.log("== 完成 ==");
if (!APPLY) console.log("这是预览模式。确认无误后加 --apply 实际写入文件。");
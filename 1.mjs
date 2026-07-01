#!/usr/bin/env node
// apply-s3-wsl-native-file-io.mjs — S3：WSL 写/删临时脚本改 argv 直传（tee / rm -f），
// 去掉 bash -c 字符串拼接与手搓 bash_quote。bash_quote 保留（dispatch 拼交互命令行仍需）。
// 幂等、EOL 自适应、锚点唯一才替换。用法: node apply-s3-wsl-native-file-io.mjs [仓库根]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const REL = 'src-tauri/src/terminal/wsl_pty.rs';
const ABS = join(ROOT, REL);
if (!existsSync(ABS)) {
  console.error(`✗ 找不到 ${REL}；请在 calamex 仓库根运行或传入仓库根路径。`);
  process.exit(1);
}

const raw = readFileSync(ABS, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let text = raw.replace(/\r\n/g, '\n');
let changed = 0;

function replaceOnce(label, find, replace, appliedMarker) {
  const count = text.split(find).length - 1;
  if (count === 1) {
    text = text.replace(find, replace);
    changed++;
    console.log(`  ✓ ${label}`);
  } else if (count === 0 && text.includes(appliedMarker)) {
    console.log(`  · [跳过] ${label}：已是新版`);
  } else {
    throw new Error(`✗ 锚点「${label}」匹配 ${count} 次（期望 1）。文件版本不符，未改动。`);
  }
}

// 1) 移除仅供旧实现使用的 bash_quote 导入（dispatch.rs 各自 use wsl 仍能用它）。
{
  const find = 'use super::wsl::bash_quote;\n';
  const count = text.split(find).length - 1;
  if (count === 1) { text = text.replace(find, ''); changed++; console.log('  ✓ 移除 wsl_pty 内 bash_quote 导入'); }
  else if (count === 0) { console.log('  · [跳过] bash_quote 导入：已移除'); }
  else { throw new Error(`✗ bash_quote 导入匹配 ${count} 次（期望 0/1）。`); }
}

// 2) materialize_wsl_script：bash -c "cat > <quoted>" → tee <path>（argv）
replaceOnce(
  'materialize_wsl_script → wsl.exe -- tee <path>',
  `/// 把脚本内容写入 WSL 侧的 execution_path（通过 \`bash -c 'cat > <path>'\` + stdin）。
pub(crate) fn materialize_wsl_script(
    execution_path: &str,
    content: &str,
) -> Result<(), LocalWslPtyError> {
    let mut command = std::process::Command::new("wsl.exe");
    command
        .arg("--")
        .arg("bash")
        .arg("-c")
        .arg(format!("cat > {}", bash_quote(execution_path)))
        .stdin(std::process::Stdio::piped())`,
  `/// 把脚本内容写入 WSL 侧的 execution_path。
///
/// 用 \`wsl.exe -- tee <path>\` 的 argv 直传：命令与路径各是独立 argv，不经 shell 解析、
/// 不 fork bash、无需手搓 quoting（对照旧的 \`bash -c "cat > <quoted>"\`，消除注入面与多余
/// 进程）。tee 从 stdin 读内容写入该文件（O_TRUNC 覆盖），stdout 回显重定向到 null。
/// 与仓库既有 \`wsl.exe -- shfmt --version\`（shell_tools）同范式。参见地基审查 S3。
pub(crate) fn materialize_wsl_script(
    execution_path: &str,
    content: &str,
) -> Result<(), LocalWslPtyError> {
    let mut command = std::process::Command::new("wsl.exe");
    command
        .arg("--")
        .arg("tee")
        .arg(execution_path)
        .stdin(std::process::Stdio::piped())`,
  '.arg("tee")',
);

// 3) cleanup_wsl_script：bash -c "rm -f <quoted>" → rm -f <path>（argv）
replaceOnce(
  'cleanup_wsl_script → wsl.exe -- rm -f <path>',
  `/// 清理某会话遗留在 WSL 侧的 Shell Integration 集成脚本（在读线程收尾、交互 shell 结束后调用）。
/// 通过 wsl.exe 执行 bash 的 rm -f 删除；尽力而为，失败仅记录告警，不影响关闭流程。
fn cleanup_wsl_script(execution_path: &str) -> Result<(), LocalWslPtyError> {
    let mut command = std::process::Command::new("wsl.exe");
    command
        .arg("--")
        .arg("bash")
        .arg("-c")
        .arg(format!("rm -f {}", bash_quote(execution_path)))
        .stdin(std::process::Stdio::null())`,
  `/// 清理某会话遗留在 WSL 侧的 Shell Integration 集成脚本（在读线程收尾、交互 shell 结束后调用）。
/// 用 \`wsl.exe -- rm -f <path>\` argv 直传删除（不经 bash -c、无需 quoting）；尽力而为，
/// 失败仅记录告警，不影响关闭流程。
fn cleanup_wsl_script(execution_path: &str) -> Result<(), LocalWslPtyError> {
    let mut command = std::process::Command::new("wsl.exe");
    command
        .arg("--")
        .arg("rm")
        .arg("-f")
        .arg(execution_path)
        .stdin(std::process::Stdio::null())`,
  '.arg("rm")',
);

if (changed > 0) writeFileSync(ABS, text.replace(/\n/g, eol), 'utf8');
console.log(`\n完成，改动 ${changed} 处（0 = 已全部应用过）。`);
console.log('自检：cd src-tauri && cargo fmt --check && cargo clippy --all-targets && cargo test');
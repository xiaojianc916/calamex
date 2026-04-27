use std::{path::Path, process::Command as StdCommand};

use crate::commands::configure_std_command_for_background;

const TERMINAL_PROMPT_MAX_LENGTH: usize = 240;

pub(crate) fn resolve_wsl_home_directory(wsl_command_path: &Path) -> Option<String> {
    let mut command = StdCommand::new(wsl_command_path);
    configure_std_command_for_background(&mut command);
    let output = command.args(["--cd", "~", "--", "pwd"]).output().ok()?;

    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

pub(crate) fn build_terminal_prompt_fallback(
    wsl_command_path: &Path,
    terminal_cwd: &str,
) -> Option<String> {
    let mut command = StdCommand::new(wsl_command_path);
    configure_std_command_for_background(&mut command);
    let output = command
        .args([
            "--cd",
            terminal_cwd,
            "--",
            "/bin/bash",
            "--noprofile",
            "--norc",
            "-lc",
            terminal_prompt_fallback_script(),
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let prompt = String::from_utf8_lossy(&output.stdout).to_string();
    if prompt.len() > TERMINAL_PROMPT_MAX_LENGTH
        || !prompt
            .chars()
            .any(|character| matches!(character, '$' | '#'))
    {
        return None;
    }

    Some(prompt)
}

fn terminal_prompt_fallback_script() -> &'static str {
    r#"user_name="\$(id -un)"
host_name="\$(hostname)"
display_pwd="\$(pwd)"
home_dir="\$(printf '%s' ~)"
if [ "\$display_pwd" = "\$home_dir" ]; then
  display_pwd='~'
fi
prompt_char="\$(printf '\\044')"
if [ "\$(id -u)" = "0" ]; then
  prompt_char='#'
fi
printf '[%s@%s %s]%s ' "\$user_name" "\$host_name" "\$display_pwd" "\$prompt_char"
"#
}

use std::path::{Path, PathBuf};

use super::{command_contracts::DispatchTerminalScriptRequest, wsl};

pub(crate) struct TerminalPreparedScript {
    pub(crate) execution_path: String,
    pub(crate) working_directory: String,
    pub(crate) used_temp_file: bool,
    pub(crate) should_cleanup_execution_path: bool,
    pub(crate) should_materialize_inline_content: bool,
}

pub(crate) struct TerminalDispatchCommand {
    pub(crate) display_command: String,
    pub(crate) used_temp_file: bool,
    pub(crate) execution_path: String,
    pub(crate) working_directory: String,
    pub(crate) cleanup_paths: Vec<String>,
}

pub(crate) fn prepare_terminal_dispatch_script(
    payload: &DispatchTerminalScriptRequest,
    terminal_working_directory: &str,
) -> Result<TerminalPreparedScript, String> {
    let preferred_path = payload.path.as_ref().map(PathBuf::from);
    let workspace_working_directory = payload
        .workspace_root_path
        .as_ref()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .map(|path| wsl::to_wsl_path(&path))
        .transpose()?;
    let script_working_directory = preferred_path
        .as_ref()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .map(|path| wsl::to_wsl_path(&path))
        .transpose()?;
    let working_directory = workspace_working_directory
        .or(script_working_directory)
        .unwrap_or_else(|| terminal_working_directory.to_string());

    let has_existing_preferred_path = preferred_path
        .as_ref()
        .map(|path| path.exists())
        .unwrap_or(false);
    let should_use_temp = payload.is_dirty || !has_existing_preferred_path;

    if should_use_temp {
        if !payload.is_dirty && preferred_path.is_some() && payload.content.is_empty() {
            return Err("脚本文件不存在或不可访问，请保存后再运行。".to_string());
        }

        let file_name = preferred_path
            .as_ref()
            .and_then(|path| path.file_name().and_then(|value| value.to_str()))
            .unwrap_or("untitled.sh");
        let temp_path = wsl::build_terminal_temp_script_path(file_name)?;
        return Ok(TerminalPreparedScript {
            execution_path: temp_path,
            working_directory,
            used_temp_file: true,
            should_cleanup_execution_path: true,
            should_materialize_inline_content: true,
        });
    }

    let execution_path = preferred_path.ok_or_else(|| "脚本路径无效。".to_string())?;
    Ok(TerminalPreparedScript {
        execution_path: wsl::to_wsl_path(&execution_path)?,
        working_directory,
        used_temp_file: false,
        should_cleanup_execution_path: false,
        should_materialize_inline_content: false,
    })
}

pub(crate) fn build_terminal_run_command_for_local_wsl(
    payload: &DispatchTerminalScriptRequest,
    terminal_working_directory: &str,
) -> Result<(TerminalDispatchCommand, Option<String>), String> {
    let prepared = prepare_terminal_dispatch_script(payload, terminal_working_directory)?;
    let script_content = prepared
        .should_materialize_inline_content
        .then(|| payload.content.clone());
    let cleanup_paths = if prepared.should_cleanup_execution_path {
        vec![prepared.execution_path.clone()]
    } else {
        Vec::new()
    };

    Ok((
        TerminalDispatchCommand {
            display_command: format!(
    "cd {} && /bin/bash {}",
    wsl::bash_quote(&prepared.working_directory),
    wsl::bash_quote(&prepared.execution_path)
),
            used_temp_file: prepared.used_temp_file,
            execution_path: prepared.execution_path,
            working_directory: prepared.working_directory,
            cleanup_paths,
        },
        script_content,
    ))
}

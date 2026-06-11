//! 按 `languageId` 解析「专用 External formatter」规格 + 二进制发现。
//!
//! 注册表为后端独占（前端不传任意命令）。各 formatter 的具体 CLI 参数以
//! 「stdin 进 / stdout 出」为准，需在本地集成测试中按实际版本校准。

use std::path::PathBuf;

use crate::commands::{find_command_path, shell_tools::bundled_resource_roots};

/// 一个语言的默认 External formatter 规格（命令名 + 参数模板 + 合成扩展名）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct ExternalFormatterSpec {
    /// 稳定 id，回传前端用于展示 / 日志（如 "shfmt" / "prettier" / "biome"）。
    pub(crate) id: &'static str,
    /// 跨平台命令名（不含扩展名；Windows 下自动补 .exe / .cmd 候选）。
    command: &'static str,
    /// 传给命令的参数模板；字面量 "{file}" 会被替换为有效文件名。
    args: &'static [&'static str],
    /// 无路径时合成 stdin 文件名用的扩展名（供 prettier / biome 选 parser）。
    synthetic_ext: &'static str,
}

/// 已发现可执行二进制并完成参数实例化的 formatter。
pub(crate) struct ResolvedFormatter {
    pub(crate) id: &'static str,
    pub(crate) executable: PathBuf,
    pub(crate) args: Vec<String>,
}

const SHFMT: ExternalFormatterSpec = ExternalFormatterSpec {
    id: "shfmt",
    command: "shfmt",
    args: &["-i", "2"],
    synthetic_ext: "sh",
};

const fn biome(synthetic_ext: &'static str) -> ExternalFormatterSpec {
    ExternalFormatterSpec {
        id: "biome",
        command: "biome",
        args: &["format", "--stdin-file-path", "{file}"],
        synthetic_ext,
    }
}

const fn prettier(synthetic_ext: &'static str) -> ExternalFormatterSpec {
    ExternalFormatterSpec {
        id: "prettier",
        command: "prettier",
        args: &["--stdin-filepath", "{file}"],
        synthetic_ext,
    }
}

const RUSTFMT: ExternalFormatterSpec = ExternalFormatterSpec {
    id: "rustfmt",
    command: "rustfmt",
    args: &["--emit", "stdout"],
    synthetic_ext: "rs",
};

const GOFMT: ExternalFormatterSpec = ExternalFormatterSpec {
    id: "gofmt",
    command: "gofmt",
    args: &[],
    synthetic_ext: "go",
};

const RUFF: ExternalFormatterSpec = ExternalFormatterSpec {
    id: "ruff",
    command: "ruff",
    args: &["format", "-"],
    synthetic_ext: "py",
};

const TAPLO: ExternalFormatterSpec = ExternalFormatterSpec {
    id: "taplo",
    command: "taplo",
    args: &["format", "-"],
    synthetic_ext: "toml",
};

/// 语言 → 默认 External formatter。未命中返回 None（前端退回 whitespace）。
pub(crate) fn resolve_external_formatter(language_id: &str) -> Option<ExternalFormatterSpec> {
    let spec = match language_id {
        "shell" => SHFMT,
        "typescript" => biome("ts"),
        "tsx" => biome("tsx"),
        "javascript" => biome("js"),
        "jsx" => biome("jsx"),
        "json" => biome("json"),
        "css" => prettier("css"),
        "scss" => prettier("scss"),
        "less" => prettier("less"),
        "html" => prettier("html"),
        "vue" => prettier("vue"),
        "markdown" => prettier("md"),
        "yaml" => prettier("yaml"),
        "rust" => RUSTFMT,
        "go" => GOFMT,
        "python" => RUFF,
        "toml" => TAPLO,
        _ => return None,
    };
    Some(spec)
}

impl ExternalFormatterSpec {
    /// 发现可用二进制并实例化参数：随包优先 → PATH。
    pub(crate) fn discover(&self, path: Option<&str>) -> Option<ResolvedFormatter> {
        let executable = discover_binary(self.command)?;
        let file_token = effective_file_name(path, self.synthetic_ext);
        let args: Vec<String> = self
            .args
            .iter()
            .map(|arg| {
                if *arg == "{file}" {
                    file_token.clone()
                } else {
                    (*arg).to_string()
                }
            })
            .collect();
        Some(ResolvedFormatter {
            id: self.id,
            executable,
            args,
        })
    }
}

fn effective_file_name(path: Option<&str>, synthetic_ext: &str) -> String {
    if let Some(path) = path
        && !path.trim().is_empty()
    {
        return path.to_string();
    }
    format!("stdin.{synthetic_ext}")
}

fn discover_binary(command: &str) -> Option<PathBuf> {
    // Windows 下 node 系工具（prettier / biome）常为 .cmd；优先 .exe 再 .cmd。
    let candidates: Vec<String> = if cfg!(windows) {
        vec![
            format!("{command}.exe"),
            format!("{command}.cmd"),
            command.to_string(),
        ]
    } else {
        vec![command.to_string()]
    };

    for name in &candidates {
        // 随包优先：安装目录内自带的二进制。
        for root in bundled_resource_roots() {
            let bundled = root.join(name);
            if bundled.is_file() {
                return Some(bundled);
            }
        }
        if let Some(system_binary) = find_command_path(name, &[]) {
            return Some(system_binary);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_default_formatter_per_language() {
        assert_eq!(resolve_external_formatter("shell").unwrap().id, "shfmt");
        assert_eq!(resolve_external_formatter("typescript").unwrap().id, "biome");
        assert_eq!(resolve_external_formatter("json").unwrap().id, "biome");
        assert_eq!(resolve_external_formatter("css").unwrap().id, "prettier");
        assert_eq!(resolve_external_formatter("vue").unwrap().id, "prettier");
        assert_eq!(resolve_external_formatter("rust").unwrap().id, "rustfmt");
        assert_eq!(resolve_external_formatter("go").unwrap().id, "gofmt");
        assert_eq!(resolve_external_formatter("python").unwrap().id, "ruff");
        assert_eq!(resolve_external_formatter("toml").unwrap().id, "taplo");
        assert!(resolve_external_formatter("plaintext").is_none());
        assert!(resolve_external_formatter("unknownlang").is_none());
    }

    #[test]
    fn substitutes_file_token_with_path_or_synthetic() {
        let spec = resolve_external_formatter("typescript").unwrap();
        assert_eq!(
            effective_file_name(Some("src/app.ts"), spec.synthetic_ext),
            "src/app.ts"
        );
        assert_eq!(effective_file_name(None, spec.synthetic_ext), "stdin.ts");
        assert_eq!(effective_file_name(Some("   "), spec.synthetic_ext), "stdin.ts");
    }
}

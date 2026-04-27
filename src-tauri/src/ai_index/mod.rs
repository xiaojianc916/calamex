use crate::ai::errors;
use crate::commands::contracts::{
    AiBuildIndexPayload, AiBuildIndexRequest, AiIndexResultPayload, AiQueryIndexPayload,
    AiQueryIndexRequest,
};
use ignore::WalkBuilder;
use std::fs;
use std::path::{Path, PathBuf};

pub mod embedding_index;
pub mod file_index;
pub mod incremental;
pub mod symbol_index;
pub mod text_index;

const MAX_INDEX_FILE_BYTES: u64 = 512 * 1024;
const MAX_QUERY_RESULTS: usize = 80;

pub fn build_index(payload: AiBuildIndexRequest) -> Result<AiBuildIndexPayload, String> {
    let root = validate_root(&payload.workspace_root_path)?;
    let mut indexed_file_count = 0usize;
    let mut skipped_file_count = 0usize;

    for entry in WalkBuilder::new(&root).hidden(false).build() {
        let Ok(entry) = entry else {
            skipped_file_count += 1;
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            skipped_file_count += 1;
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if metadata.len() > MAX_INDEX_FILE_BYTES || is_sensitive_path(entry.path()) {
            skipped_file_count += 1;
            continue;
        }
        indexed_file_count += 1;
    }

    Ok(AiBuildIndexPayload {
        root_path: root.to_string_lossy().to_string(),
        indexed_file_count,
        skipped_file_count,
    })
}

pub fn query_index(payload: AiQueryIndexRequest) -> Result<AiQueryIndexPayload, String> {
    let root = validate_root(&payload.workspace_root_path)?;
    let query = payload.query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(AiQueryIndexPayload {
            root_path: root.to_string_lossy().to_string(),
            results: Vec::new(),
        });
    }
    let limit = payload.limit.unwrap_or(30).min(MAX_QUERY_RESULTS);
    let mut results = Vec::new();

    for entry in WalkBuilder::new(&root).hidden(false).build() {
        if results.len() >= limit {
            break;
        }
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_INDEX_FILE_BYTES || is_sensitive_path(path) {
            continue;
        }
        let relative_path = path
            .strip_prefix(&root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        if relative_path.to_lowercase().contains(&query) {
            results.push(AiIndexResultPayload {
                path: path.to_string_lossy().to_string(),
                line_number: None,
                preview: relative_path,
                score: 100,
            });
            continue;
        }
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        for (index, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&query) {
                results.push(AiIndexResultPayload {
                    path: path.to_string_lossy().to_string(),
                    line_number: Some(index + 1),
                    preview: line.chars().take(240).collect(),
                    score: 80,
                });
                break;
            }
        }
    }

    Ok(AiQueryIndexPayload {
        root_path: root.to_string_lossy().to_string(),
        results,
    })
}

fn validate_root(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_dir() {
        return Err(errors::error("AI_INDEX_NOT_READY", "工作区目录不可用。"));
    }
    path.canonicalize().map_err(|error| {
        errors::error(
            "AI_INDEX_BUILD_FAILED",
            format!("索引目录解析失败：{error}"),
        )
    })
}

fn is_sensitive_path(path: &Path) -> bool {
    let value = path.to_string_lossy().to_lowercase();
    value.contains(".env")
        || value.contains("id_rsa")
        || value.contains("id_ed25519")
        || value.contains(".pem")
        || value.contains(".key")
        || value.contains("node_modules")
        || value.contains("target")
        || value.contains("dist")
}

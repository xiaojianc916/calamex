//! 全局技能库（Agent Skills）的增删改查。
//!
//! 技能统一存放在漫游区 `%APPDATA%\.calamex\skills` 下，每个技能是一个目录：
//! `<skills-root>/<slug>/SKILL.md`。`SKILL.md` 采用 Mastra 约定的 YAML frontmatter
//! 描述 `name` / `description`，正文为技能说明，供 Agent 的 skill 工具按需检索加载。
//!
//! 本模块仅做磁盘 IO 与基本路径安全校验（slug 不得含分隔符 / `..`），不依赖工作区，
//! 因此技能可跨项目全局复用。路径安全 / 原子写入策略与 `workspace_fs` 保持一致。

use crate::commands::contracts::{
    DeleteSkillPayload, DeleteSkillRequest, SaveSkillRequest, SkillDetailPayload, SkillListPayload,
    SkillSummaryPayload,
};
use crate::storage_paths::roaming_root;
use atomic_write_file::AtomicWriteFile;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

/// 单个技能说明文件名（Mastra 技能约定）。
const SKILL_FILE_NAME: &str = "SKILL.md";
/// 技能正文体积上限，防御性保护，避免一次性读入超大文件。
const MAX_SKILL_BYTES: u64 = 1024 * 1024;

#[tauri::command]
#[specta::specta]
pub fn list_skills() -> Result<SkillListPayload, String> {
    let root = ensure_skills_root()?;
    let mut skills = Vec::new();

    let read_dir = fs::read_dir(&root).map_err(|error| format!("读取技能目录失败：{error}"))?;
    for item in read_dir {
        let Ok(entry) = item else {
            continue;
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(slug) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let skill_file = path.join(SKILL_FILE_NAME);
        if !skill_file.is_file() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&skill_file) else {
            continue;
        };
        let parsed = parse_skill_document(&raw);
        skills.push(SkillSummaryPayload {
            name: if parsed.name.is_empty() {
                slug.to_string()
            } else {
                parsed.name
            },
            slug: slug.to_string(),
            description: parsed.description,
            updated_at_ms: file_modified_ms(&skill_file),
        });
    }

    skills.sort_by_key(|left| left.name.to_lowercase());

    Ok(SkillListPayload {
        root_path: root.to_string_lossy().to_string(),
        skills,
    })
}

#[tauri::command]
#[specta::specta]
pub fn read_skill(slug: String) -> Result<SkillDetailPayload, String> {
    let root = ensure_skills_root()?;
    let validated = validate_slug(&slug)?;
    let skill_file = root.join(&validated).join(SKILL_FILE_NAME);
    if !skill_file.is_file() {
        return Err("目标技能不存在。".into());
    }
    ensure_within_size_limit(&skill_file)?;
    let raw = fs::read_to_string(&skill_file).map_err(|error| format!("读取技能失败：{error}"))?;
    let parsed = parse_skill_document(&raw);

    Ok(SkillDetailPayload {
        name: if parsed.name.is_empty() {
            validated.clone()
        } else {
            parsed.name
        },
        slug: validated,
        description: parsed.description,
        content: parsed.body,
        path: skill_file.to_string_lossy().to_string(),
        updated_at_ms: file_modified_ms(&skill_file),
    })
}

#[tauri::command]
#[specta::specta]
pub fn save_skill(payload: SaveSkillRequest) -> Result<SkillDetailPayload, String> {
    let root = ensure_skills_root()?;
    let name = payload.name.trim();
    if name.is_empty() {
        return Err("技能名称不能为空。".into());
    }
    let description = payload.description.trim().to_string();

    // 已有 slug 表示更新；否则按名称生成新的唯一 slug。
    let slug = match payload.slug.as_deref() {
        Some(existing) => validate_slug(existing)?,
        None => allocate_slug(&root, name)?,
    };

    let skill_dir = root.join(&slug);
    fs::create_dir_all(&skill_dir).map_err(|error| format!("创建技能目录失败：{error}"))?;
    let skill_file = skill_dir.join(SKILL_FILE_NAME);

    let document = build_skill_document(name, &description, &payload.content);
    atomic_write(&skill_file, document.as_bytes())?;

    Ok(SkillDetailPayload {
        slug,
        name: name.to_string(),
        description,
        content: payload.content,
        path: skill_file.to_string_lossy().to_string(),
        updated_at_ms: file_modified_ms(&skill_file),
    })
}

#[tauri::command]
#[specta::specta]
pub fn delete_skill(payload: DeleteSkillRequest) -> Result<DeleteSkillPayload, String> {
    let root = ensure_skills_root()?;
    let slug = validate_slug(&payload.slug)?;
    let skill_dir = root.join(&slug);
    if !skill_dir.is_dir() {
        return Err("目标技能不存在。".into());
    }
    trash::delete(&skill_dir).map_err(|error| format!("移动到回收站失败：{error}"))?;
    Ok(DeleteSkillPayload { slug })
}

struct ParsedSkill {
    name: String,
    description: String,
    body: String,
}

/// 解析技能根目录并确保其存在。
fn ensure_skills_root() -> Result<PathBuf, String> {
    let root = roaming_root()
        .ok_or_else(|| "无法定位应用数据目录。".to_string())?
        .join("skills");
    fs::create_dir_all(&root).map_err(|error| format!("创建技能目录失败：{error}"))?;
    Ok(root)
}

/// 校验 slug：非空、非 `.`/`..`、不含路径分隔符与非法字符，杜绝路径穿越。
fn validate_slug(raw: &str) -> Result<String, String> {
    let slug = raw.trim();
    if slug.is_empty() {
        return Err("技能标识不能为空。".into());
    }
    if slug == "." || slug == ".." {
        return Err("技能标识非法。".into());
    }
    let candidate = Path::new(slug);
    if candidate.file_name().and_then(|value| value.to_str()) != Some(slug) {
        return Err("技能标识不能包含路径分隔符。".into());
    }
    const INVALID_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    if slug
        .chars()
        .any(|character| INVALID_CHARS.contains(&character) || character.is_control())
    {
        return Err("技能标识包含非法字符。".into());
    }
    Ok(slug.to_string())
}

/// 把名称转为 ascii slug（小写、非字母数字折叠为单个连字符）。
fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for character in name.trim().to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "skill".to_string()
    } else {
        trimmed
    }
}

/// 为新技能分配唯一 slug：若同名目录已存在则追加 `-2`、`-3` …。
fn allocate_slug(root: &Path, name: &str) -> Result<String, String> {
    let base = slugify(name);
    let mut candidate = base.clone();
    let mut suffix = 2u32;
    while root.join(&candidate).exists() {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }
    Ok(candidate)
}

/// 解析 `SKILL.md`：提取 YAML frontmatter 的 name / description，其余为正文。
fn parse_skill_document(raw: &str) -> ParsedSkill {
    let normalized = raw.replace("\r\n", "\n");
    if let Some(rest) = normalized.strip_prefix("---\n")
        && let Some(end) = rest.find("\n---")
    {
            let front = &rest[..end];
            let after = &rest[end + 4..];
            let body = after.trim_start_matches('\n').to_string();
            let mut name = String::new();
            let mut description = String::new();
            for line in front.lines() {
                if let Some(value) = line.strip_prefix("name:") {
                    name = unquote(value);
                } else if let Some(value) = line.strip_prefix("description:") {
                    description = unquote(value);
                }
            }
            return ParsedSkill {
                name,
                description,
                body,
            };
    }
    ParsedSkill {
        name: String::new(),
        description: String::new(),
        body: normalized,
    }
}

/// 去除 YAML 标量两端的引号。
fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

/// 生成带 frontmatter 的 `SKILL.md` 文本。
fn build_skill_document(name: &str, description: &str, body: &str) -> String {
    let mut document = String::from("---\n");
    document.push_str(&format!("name: {}\n", yaml_quote(name)));
    document.push_str(&format!("description: {}\n", yaml_quote(description)));
    document.push_str("---\n\n");
    document.push_str(body.replace("\r\n", "\n").trim_end());
    document.push('\n');
    document
}

/// 用双引号包裹并转义 YAML 标量，避免冒号 / 引号破坏 frontmatter。
fn yaml_quote(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// 文件最近修改时间（毫秒）；无法读取时返回 0。
fn file_modified_ms(path: &Path) -> f64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0)
}

fn ensure_within_size_limit(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取技能失败：{error}"))?;
    if metadata.len() > MAX_SKILL_BYTES {
        return Err("技能文件过大，已取消读取。".into());
    }
    Ok(())
}

/// 原子写入：由 atomic-write-file 在目标同目录创建唯一临时文件，完整写入后 commit 覆盖目标，
/// 避免固定临时文件名在并发保存时互相覆盖 / 删除（与 `workspace_fs` 的原子写入保持一致）。
fn atomic_write(file_path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = AtomicWriteFile::options()
        .open(file_path)
        .map_err(|error| format!("保存技能失败：{error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("保存技能失败：{error}"))?;
    file.commit()
        .map_err(|error| format!("保存技能失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_normalizes_ascii_names() {
        assert_eq!(slugify("Email Design Eng"), "email-design-eng");
        assert_eq!(slugify("  Find   Skills!! "), "find-skills");
        assert_eq!(slugify("***"), "skill");
    }

    #[test]
    fn skill_document_roundtrips_frontmatter() {
        let doc = build_skill_document("My Skill", "Does things: nicely", "# Body\n\ncontent");
        let parsed = parse_skill_document(&doc);
        assert_eq!(parsed.name, "My Skill");
        assert_eq!(parsed.description, "Does things: nicely");
        assert!(parsed.body.contains("# Body"));
        assert!(parsed.body.contains("content"));
    }

    #[test]
    fn parse_handles_document_without_frontmatter() {
        let parsed = parse_skill_document("just a body\nline two");
        assert_eq!(parsed.name, "");
        assert_eq!(parsed.description, "");
        assert_eq!(parsed.body, "just a body\nline two");
    }

    #[test]
    fn validate_slug_rejects_traversal() {
        assert!(validate_slug("../evil").is_err());
        assert!(validate_slug("a/b").is_err());
        assert!(validate_slug("").is_err());
        assert_eq!(validate_slug("ok-slug").unwrap(), "ok-slug");
    }
}

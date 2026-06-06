use serde::{Deserialize, Serialize};
use specta::Type;

// ============================================================================
// Agent skills（全局技能库，存于 %APPDATA%\.calamex\skills）
// ============================================================================

/// 技能列表项（轻量，仅含展示所需字段）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummaryPayload {
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) updated_at_ms: f64,
}

/// 单个技能详情（含正文，用于查看 / 编辑）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetailPayload {
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) content: String,
    pub(crate) path: String,
    pub(crate) updated_at_ms: f64,
}

/// 技能列表整体返回（含技能根目录，便于前端提示存储位置）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillListPayload {
    pub(crate) root_path: String,
    pub(crate) skills: Vec<SkillSummaryPayload>,
}

/// 新建 / 更新技能入参。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveSkillRequest {
    /// None 表示新建（按名称生成 slug）；Some(slug) 表示更新已存在技能。
    pub(crate) slug: Option<String>,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) content: String,
}

/// 删除技能入参。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSkillRequest {
    pub(crate) slug: String,
}

/// 删除技能返回。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSkillPayload {
    pub(crate) slug: String,
}

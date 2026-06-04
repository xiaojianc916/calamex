use std::collections::HashSet;

use crate::ai::agent::policy::{AgentTaskPolicyInput, classify_task as classify_by_policy};
use crate::ai::errors;
use crate::commands::contracts::{
    AiAgentClassifyTaskPayload, AiAgentClassifyTaskRequest, AiContextReferencePayload,
};

pub struct AgentPlanner;

impl AgentPlanner {
    pub fn classify_task(
        payload: AiAgentClassifyTaskRequest,
    ) -> Result<AiAgentClassifyTaskPayload, String> {
        let goal = normalize_goal(&payload.goal)?;
        let decision = classify_by_policy(AgentTaskPolicyInput {
            goal,
            referenced_file_count: count_referenced_files(&payload.context),
        });

        Ok(AiAgentClassifyTaskPayload {
            classification: decision.classification.as_str().to_string(),
            should_enter_plan_mode: decision.should_enter_plan_mode,
            reason: decision.reason.to_string(),
        })
    }
}

fn normalize_goal(goal: &str) -> Result<&str, String> {
    let trimmed = goal.trim();

    if trimmed.is_empty() {
        return Err(errors::error("AI_AGENT_PLAN_INVALID", "任务目标不能为空。"));
    }

    Ok(trimmed)
}

fn count_referenced_files(context: &[AiContextReferencePayload]) -> usize {
    context
        .iter()
        .filter_map(|reference| reference.path.as_deref())
        .filter(|path| !path.trim().is_empty())
        .collect::<HashSet<_>>()
        .len()
}

#[cfg(test)]
mod tests {
    use super::AgentPlanner;
    use crate::commands::contracts::{AiAgentClassifyTaskRequest, AiContextReferencePayload};

    fn file_reference(path: &str) -> AiContextReferencePayload {
        AiContextReferencePayload {
            id: format!("ref-{path}"),
            kind: "file".to_string(),
            label: path.to_string(),
            path: Some(path.to_string()),
            range: None,
            content_preview: String::new(),
            redacted: false,
        }
    }

    #[test]
    fn classifies_more_than_two_files_as_complex() {
        let payload = AgentPlanner::classify_task(AiAgentClassifyTaskRequest {
            goal: "调整样式".to_string(),
            context: vec![
                file_reference("src/a.ts"),
                file_reference("src/b.ts"),
                file_reference("src/c.ts"),
            ],
        })
        .expect("classification should succeed");

        assert_eq!(payload.classification, "complex");
        assert!(payload.should_enter_plan_mode);
    }

    #[test]
    fn rejects_empty_goal() {
        let error = AgentPlanner::classify_task(AiAgentClassifyTaskRequest {
            goal: "   ".to_string(),
            context: Vec::new(),
        })
        .expect_err("empty goal should be rejected");

        assert!(error.contains("AI_AGENT_PLAN_INVALID"));
    }
}

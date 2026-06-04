pub const MIN_PLAN_STEPS: usize = 2;
pub const MAX_PLAN_STEPS: usize = 6;

const COMPLEX_KEYWORDS: &[&str] = &[
    "重构",
    "完善",
    "接入",
    "实现",
    "修复一组",
    "全链路",
    "架构",
    "方案落地",
    "测试",
    "构建",
    "验证",
    "回滚",
    "联网",
    "网络搜索",
    "web_search",
    "web_fetch",
    "patch",
    "写盘",
    "修改",
    "多文件",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentTaskClassification {
    Simple,
    Complex,
}

impl AgentTaskClassification {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Simple => "simple",
            Self::Complex => "complex",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentTaskPolicyDecision {
    pub classification: AgentTaskClassification,
    pub should_enter_plan_mode: bool,
    pub reason: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentTaskPolicyInput<'a> {
    pub goal: &'a str,
    pub referenced_file_count: usize,
}

pub fn classify_task(input: AgentTaskPolicyInput<'_>) -> AgentTaskPolicyDecision {
    if input.referenced_file_count > 2 {
        return complex("任务涉及 2 个以上文件，需先计划后执行。");
    }

    if input.goal.chars().count() >= 24 {
        return complex("任务描述较长且影响面不明确，需先计划后执行。");
    }

    if COMPLEX_KEYWORDS
        .iter()
        .any(|keyword| input.goal.contains(keyword))
    {
        return complex("任务包含多阶段动作或潜在写盘影响，需先计划后执行。");
    }

    AgentTaskPolicyDecision {
        classification: AgentTaskClassification::Simple,
        should_enter_plan_mode: false,
        reason: "任务可在单轮内完成，可直接执行。",
    }
}

fn complex(reason: &'static str) -> AgentTaskPolicyDecision {
    AgentTaskPolicyDecision {
        classification: AgentTaskClassification::Complex,
        should_enter_plan_mode: true,
        reason,
    }
}

pub fn clamp_plan_step_count(count: usize) -> usize {
    count.clamp(MIN_PLAN_STEPS, MAX_PLAN_STEPS)
}

#[cfg(test)]
mod tests {
    use super::{
        AgentTaskClassification, AgentTaskPolicyInput, MAX_PLAN_STEPS, MIN_PLAN_STEPS,
        classify_task,
    };

    #[test]
    fn classifies_keyword_task_as_complex() {
        let decision = classify_task(AgentTaskPolicyInput {
            goal: "接入 Agent Plan Mode",
            referenced_file_count: 0,
        });

        assert_eq!(decision.classification, AgentTaskClassification::Complex);
        assert!(decision.should_enter_plan_mode);
    }

    #[test]
    fn classifies_short_modify_request_as_complex() {
        let decision = classify_task(AgentTaskPolicyInput {
            goal: "你修改一下",
            referenced_file_count: 1,
        });

        assert_eq!(decision.classification, AgentTaskClassification::Complex);
        assert!(decision.should_enter_plan_mode);
    }

    #[test]
    fn classifies_multi_file_task_as_complex() {
        let decision = classify_task(AgentTaskPolicyInput {
            goal: "调整样式",
            referenced_file_count: 3,
        });

        assert_eq!(decision.classification, AgentTaskClassification::Complex);
    }

    #[test]
    fn classifies_short_readonly_question_as_simple() {
        let decision = classify_task(AgentTaskPolicyInput {
            goal: "解释当前选区",
            referenced_file_count: 1,
        });

        assert_eq!(decision.classification, AgentTaskClassification::Simple);
        assert!(!decision.should_enter_plan_mode);
    }

    #[test]
    fn exposes_plan_step_bounds() {
        assert_eq!(MIN_PLAN_STEPS, 2);
        assert_eq!(MAX_PLAN_STEPS, 6);
        assert_eq!(super::clamp_plan_step_count(0), MIN_PLAN_STEPS);
        assert_eq!(super::clamp_plan_step_count(8), MAX_PLAN_STEPS);
    }
}

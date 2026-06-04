import type { TAgentPlanWorkflowStatus } from '../../../schemas/plan-workflow.js';

// -----------------------------------------------------------------------------
// Schema constants
// -----------------------------------------------------------------------------

export const WORKFLOW_RUN_TABLE = 'agent_plan_workflow_runs';
export const WORKFLOW_EVENT_TABLE = 'agent_plan_workflow_events';
export const WORKFLOW_META_TABLE = 'agent_plan_workflow_meta';
export const WORKFLOW_SCHEMA_VERSION = 1;

export const WORKFLOW_RUN_SELECT_FIELDS = [
    'workflow_run_id', 'plan_id', 'plan_version', 'thread_id',
    'status', 'phase', 'current_step_id', 'execution_cursor',
    'approved_plan_hash', 'last_heartbeat_at',
    'parent_run_id', 'replan_of_version',
    'suspend_reason', 'suspend_token', 'mastra_run_id',
    'created_at', 'updated_at',
    'suspended_at', 'resumed_at', 'finished_at',
    'error_message', 'state_json', 'revision',
].join(', ');

export const WORKFLOW_EVENT_SELECT_FIELDS = [
    'event_id', 'workflow_run_id', 'plan_id', 'plan_version',
    'seq', 'created_at', 'event_json',
].join(', ');

export const ACTIVE_STATUSES: ReadonlySet<TAgentPlanWorkflowStatus> = new Set([
    'waiting_approval',
    'approved',
    'executing',
]);

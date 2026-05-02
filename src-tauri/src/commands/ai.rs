use super::contracts::{
    AiAgentApprovePlanPayload, AiAgentApprovePlanRequest, AiAgentClassifyTaskPayload,
    AiAgentClassifyTaskRequest, AiAgentListRunsPayload, AiAgentNetworkPermissionPayload,
    AiAgentPatchSummaryStreamEventPayload, AiAgentPlanPayload, AiAgentPlanRequest,
    AiAgentResolveToolConfirmationRequest, AiAgentRunEnvelopePayload, AiAgentRunIdRequest,
    AiAgentRunPayload, AiAgentRunPlanRequest, AiAgentRunStepRequest, AiAgentRunStreamEventPayload,
    AiAgentSetNetworkPermissionRequest, AiAgentStepStreamEventPayload,
    AiAgentStreamEndEventPayload, AiAgentToolActivityStreamEventPayload,
    AiAgentToolConfirmationStreamEventPayload, AiApplyPatchPayload, AiApplyPatchRequest,
    AiBuildIndexPayload, AiBuildIndexRequest, AiCancelRequest, AiChatMessagePayload, AiChatPayload,
    AiChatRequest, AiChatStreamPayload, AiCodeActionPayload, AiCodeActionRequest, AiConfigPayload,
    AiConversationTitlePayload, AiConversationTitleRequest, AiEditAuthStatePayload,
    AiEditCreateSnapshotPayload, AiEditCreateSnapshotRequest, AiEditGetDiffPayload,
    AiEditGetDiffRequest, AiEditListTimelinePayload, AiEditListTimelineRequest,
    AiEditRestoreSnapshotPayload, AiEditRestoreSnapshotRequest, AiEditRevertFilePayload,
    AiEditRevertFileRequest, AiEditRevertHunkPayload, AiEditRevertHunkRequest,
    AiEditRevertTaskPayload, AiEditRevertTaskRequest, AiEditSetAuthLevelRequest,
    AiEditUndoOperationPayload, AiEditUndoOperationRequest, AiInlineCompletionRangePayload,
    AiInlineCompletionRequest, AiInlineCompletionResult, AiProposePatchPayload,
    AiProposePatchRequest, AiProviderConnectionPayload, AiProviderConnectionRequest,
    AiProviderProfileDetailPayload, AiProviderProfilePayload, AiProviderProfileSwitchRequest,
    AiProviderTestPayload, AiQueryIndexPayload, AiQueryIndexRequest, AiSaveConfigRequest,
    AiSaveCredentialsRequest, AiTaskPlanStepPayload, AiToolActivityInlinePayload,
    AiToolDefinitionPayload, AiWebFetchInput, AiWebFetchPayload, AiWebSearchInput,
    AiWebSearchPayload,
};
use crate::ai::audit::{self, AiAuditEventKind};
use crate::ai::gateway;
use crate::ai::stream_manager;
use crate::ai_agent::runtime as agent_runtime;
use crate::ai_agent::tool_loop::{
    build_tool_activity_label, AgentToolRuntimeServices, AgentToolUseContext,
};
use crate::ai_edit;
use crate::ai_edit::AiEditState;
use crate::ai_index;
use crate::ai_patch;
use crate::ai_tools::registry;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;

static AI_AGENT_STREAM_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_agent_stream_seq() -> u64 {
    AI_AGENT_STREAM_SEQ.fetch_add(1, Ordering::Relaxed)
}

fn resolve_ai_edit_storage_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| ai_edit::errors::storage_path_unavailable(&error.to_string()))?
        .join(".notion-ide-ai")
        .join("edits"))
}

struct AiAgentAedRuntimeServices<'a> {
    app: &'a AppHandle,
    state: &'a AiEditState,
}

impl AgentToolRuntimeServices for AiAgentAedRuntimeServices<'_> {
    fn auto_apply_patch(
        &self,
        payload: AiApplyPatchRequest,
        context: &AgentToolUseContext,
    ) -> Result<(String, Option<String>), String> {
        let snapshot_root = resolve_ai_edit_storage_root(self.app)?;
        let patch = payload.patch.clone();
        let metadata = payload.metadata.clone();
        let result = ai_patch::apply_patch(payload, self.state, &snapshot_root)?;

        if let Some(metadata) = metadata.as_ref() {
            emit_agent_patch_summary(self.app, &patch, &result, metadata);
        }

        Ok((
            format!(
                "auto_apply_patch applied {} file(s) through AED.",
                result.applied_files.len()
            ),
            Some(format!(
                "agent-tool-result:auto_apply_patch:{}:{}",
                context.run_id, context.step_id
            )),
        ))
    }

    fn emit_tool_activity(
        &self,
        context: &AgentToolUseContext,
        tool_name: &str,
        state: &str,
        label: String,
    ) {
        emit_agent_tool_activity(
            self.app,
            &context.run_id,
            &context.step_id,
            tool_name,
            state,
            label,
        );
    }
}

#[tauri::command]
pub fn ai_get_config() -> Result<AiConfigPayload, String> {
    Ok(gateway::get_config())
}

#[tauri::command]
pub fn ai_save_config(payload: AiSaveConfigRequest) -> Result<AiConfigPayload, String> {
    gateway::save_config(
        &payload.provider_type,
        payload.selected_model,
        payload.base_url,
        payload.inline_completion_enabled,
        payload.chat_enabled,
        payload.agent_enabled,
    )
}

#[tauri::command]
pub fn ai_save_credentials(payload: AiSaveCredentialsRequest) -> Result<AiConfigPayload, String> {
    gateway::save_credentials(&payload.provider_type, &payload.api_key)
}

#[tauri::command]
pub async fn ai_test_provider_config(
    payload: AiProviderConnectionRequest,
) -> Result<AiProviderTestPayload, String> {
    match gateway::test_provider_config(
        &payload.provider_type,
        payload.selected_model,
        payload.base_url,
        payload.inline_completion_enabled,
        payload.chat_enabled,
        payload.agent_enabled,
        payload.api_key.as_ref().map(|value| value.expose()),
    )
    .await
    {
        Ok(()) => Ok(AiProviderTestPayload {
            ok: true,
            code: "AI_PROVIDER_READY".to_string(),
            message: "AI Provider 可用。".to_string(),
        }),
        Err(error) => Ok(AiProviderTestPayload {
            ok: false,
            code: "AI_PROVIDER_UNAVAILABLE".to_string(),
            message: error,
        }),
    }
}

#[tauri::command]
pub async fn ai_connect_provider(
    payload: AiProviderConnectionRequest,
) -> Result<AiProviderConnectionPayload, String> {
    let config = gateway::connect_provider(
        &payload.provider_type,
        payload.selected_model,
        payload.base_url,
        payload.inline_completion_enabled,
        payload.chat_enabled,
        payload.agent_enabled,
        payload.api_key.as_ref().map(|value| value.expose()),
    )
    .await?;

    Ok(AiProviderConnectionPayload {
        config,
        test: AiProviderTestPayload {
            ok: true,
            code: "AI_PROVIDER_READY".to_string(),
            message: "AI Provider 可用。".to_string(),
        },
    })
}

#[tauri::command]
pub fn ai_clear_credentials() -> Result<(), String> {
    gateway::clear_credentials()?;
    audit::emit(AiAuditEventKind::CredentialCleared);
    Ok(())
}

#[tauri::command]
pub fn ai_list_provider_profiles() -> Result<Vec<AiProviderProfilePayload>, String> {
    gateway::list_provider_profiles()
}

#[tauri::command]
pub fn ai_get_provider_profile_detail(
    payload: AiProviderProfileSwitchRequest,
) -> Result<AiProviderProfileDetailPayload, String> {
    gateway::get_provider_profile_detail(payload)
}

#[tauri::command]
pub fn ai_switch_provider_profile(
    payload: AiProviderProfileSwitchRequest,
) -> Result<AiConfigPayload, String> {
    gateway::switch_provider_profile(payload)
}

#[tauri::command]
pub async fn ai_test_provider() -> Result<AiProviderTestPayload, String> {
    match gateway::test_provider().await {
        Ok(()) => Ok(AiProviderTestPayload {
            ok: true,
            code: "AI_PROVIDER_READY".to_string(),
            message: "AI Provider 可用。".to_string(),
        }),
        Err(error) => Ok(AiProviderTestPayload {
            ok: false,
            code: "AI_PROVIDER_UNAVAILABLE".to_string(),
            message: error,
        }),
    }
}

#[tauri::command]
pub async fn ai_chat(payload: AiChatRequest) -> Result<AiChatPayload, String> {
    let response = gateway::chat(payload).await?;
    Ok(AiChatPayload {
        message: AiChatMessagePayload {
            id: format!("assistant-{}", chrono::Utc::now().timestamp_millis()),
            role: "assistant".to_string(),
            content: response.content,
            created_at: chrono::Utc::now().to_rfc3339(),
            references: Vec::new(),
        },
        provider_type: gateway::get_config().provider_type,
        model: response.model,
    })
}

#[tauri::command]
pub async fn ai_generate_conversation_title(
    payload: AiConversationTitleRequest,
) -> Result<AiConversationTitlePayload, String> {
    gateway::generate_conversation_title(payload).await
}

#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    payload: AiChatRequest,
) -> Result<AiChatStreamPayload, String> {
    let started = gateway::chat_stream(app, payload).await?;
    Ok(AiChatStreamPayload {
        stream_id: started.stream_id,
        assistant_message_id: started.assistant_message_id,
        provider_type: started.provider_type,
        model: started.model,
    })
}

#[tauri::command]
pub fn ai_cancel(payload: AiCancelRequest) -> Result<(), String> {
    let stream_id = payload.stream_id.trim();
    if stream_id.is_empty() {
        return Err("AI_REQUEST_CANCELLED: streamId 不能为空。".to_string());
    }
    stream_manager::cancel(stream_id);
    Ok(())
}

#[tauri::command]
pub async fn ai_inline_complete(
    payload: AiInlineCompletionRequest,
) -> Result<AiInlineCompletionResult, String> {
    let result = gateway::inline_complete(payload).await?;
    Ok(AiInlineCompletionResult {
        insert_text: result.insert_text,
        range: AiInlineCompletionRangePayload {
            start_offset: result.range.start_offset,
            end_offset: result.range.end_offset,
        },
        confidence: result.confidence,
    })
}

#[tauri::command]
pub async fn ai_code_action(payload: AiCodeActionRequest) -> Result<AiCodeActionPayload, String> {
    gateway::code_action(payload).await
}

#[tauri::command]
pub async fn ai_agent_classify_task(
    payload: AiAgentClassifyTaskRequest,
) -> Result<AiAgentClassifyTaskPayload, String> {
    gateway::classify_task(payload).await
}

#[tauri::command]
pub async fn ai_plan_task(payload: AiAgentPlanRequest) -> Result<AiAgentPlanPayload, String> {
    gateway::plan_task(payload).await
}

#[tauri::command]
pub async fn ai_agent_approve_plan(
    payload: AiAgentApprovePlanRequest,
) -> Result<AiAgentApprovePlanPayload, String> {
    gateway::approve_plan(payload).await
}

#[tauri::command]
pub fn ai_agent_run_plan(
    app: AppHandle,
    payload: AiAgentRunPlanRequest,
) -> Result<AiAgentRunEnvelopePayload, String> {
    let envelope = agent_runtime::run_plan(payload)?;
    emit_agent_run_event(&app, &envelope.run);
    Ok(envelope)
}

#[tauri::command]
pub fn ai_agent_run_step(
    app: AppHandle,
    payload: AiAgentRunStepRequest,
    state: State<AiEditState>,
) -> Result<AiAgentRunEnvelopePayload, String> {
    let before = agent_runtime::get_run(AiAgentRunIdRequest {
        run_id: payload.run_id.clone(),
    })
    .ok()
    .map(|envelope| envelope.run);
    let services = AiAgentAedRuntimeServices {
        app: &app,
        state: state.inner(),
    };
    let envelope = agent_runtime::run_step_with_services(payload, Some(&services))?;
    emit_agent_step_transition(&app, before.as_ref(), &envelope.run);
    if let Some(confirmation) = agent_runtime::pending_tool_confirmation(&envelope.run.id) {
        emit_agent_tool_confirmation(&app, &envelope.run.id, confirmation);
    }
    emit_agent_run_event(&app, &envelope.run);

    if envelope.run.status == "completed" {
        emit_agent_stream_end(&app, &envelope.run.id, "completed");
    }

    Ok(envelope)
}

#[tauri::command]
pub fn ai_agent_pause(
    app: AppHandle,
    payload: AiAgentRunIdRequest,
) -> Result<AiAgentRunEnvelopePayload, String> {
    let envelope = agent_runtime::pause(payload)?;
    emit_agent_run_event(&app, &envelope.run);
    Ok(envelope)
}

#[tauri::command]
pub fn ai_agent_resume(
    app: AppHandle,
    payload: AiAgentRunIdRequest,
) -> Result<AiAgentRunEnvelopePayload, String> {
    let envelope = agent_runtime::resume(payload)?;
    emit_agent_run_event(&app, &envelope.run);
    Ok(envelope)
}

#[tauri::command]
pub fn ai_agent_cancel(
    app: AppHandle,
    payload: AiAgentRunIdRequest,
) -> Result<AiAgentRunEnvelopePayload, String> {
    let envelope = agent_runtime::cancel(payload)?;
    emit_agent_run_event(&app, &envelope.run);
    emit_agent_stream_end(&app, &envelope.run.id, "cancelled");
    Ok(envelope)
}

#[tauri::command]
pub fn ai_agent_get_run(payload: AiAgentRunIdRequest) -> Result<AiAgentRunEnvelopePayload, String> {
    agent_runtime::get_run(payload)
}

#[tauri::command]
pub fn ai_agent_list_runs() -> Result<AiAgentListRunsPayload, String> {
    agent_runtime::list_runs()
}

#[tauri::command]
pub fn ai_agent_set_network_permission(
    payload: AiAgentSetNetworkPermissionRequest,
) -> Result<AiAgentNetworkPermissionPayload, String> {
    agent_runtime::set_network_permission(payload)
}

#[tauri::command]
pub fn ai_agent_resolve_tool_confirmation(
    app: AppHandle,
    payload: AiAgentResolveToolConfirmationRequest,
) -> Result<AiAgentRunEnvelopePayload, String> {
    let envelope = agent_runtime::resolve_tool_confirmation(payload)?;
    emit_agent_run_event(&app, &envelope.run);
    if envelope.run.status == "cancelled" {
        emit_agent_stream_end(&app, &envelope.run.id, "cancelled");
    }
    Ok(envelope)
}

#[tauri::command]
pub async fn ai_web_search(payload: AiWebSearchInput) -> Result<AiWebSearchPayload, String> {
    crate::ai_tools::web_search::search(payload).await
}

#[tauri::command]
pub async fn ai_web_fetch(payload: AiWebFetchInput) -> Result<AiWebFetchPayload, String> {
    crate::ai_tools::web_fetch::fetch(payload).await
}

#[tauri::command]
pub fn ai_build_index(payload: AiBuildIndexRequest) -> Result<AiBuildIndexPayload, String> {
    ai_index::build_index(payload)
}

#[tauri::command]
pub fn ai_query_index(payload: AiQueryIndexRequest) -> Result<AiQueryIndexPayload, String> {
    ai_index::query_index(payload)
}

#[tauri::command]
pub fn ai_propose_patch(payload: AiProposePatchRequest) -> Result<AiProposePatchPayload, String> {
    ai_patch::propose_patch(payload)
}

#[tauri::command]
pub fn ai_apply_patch(
    app: AppHandle,
    payload: AiApplyPatchRequest,
    state: State<AiEditState>,
) -> Result<AiApplyPatchPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    let patch = payload.patch.clone();
    let metadata = payload.metadata.clone();
    let result = ai_patch::apply_patch(payload, state.inner(), &snapshot_root)?;

    if let Some(metadata) = metadata.as_ref() {
        emit_agent_patch_summary(&app, &patch, &result, metadata);
    }

    Ok(result)
}

fn emit_agent_patch_summary(
    app: &AppHandle,
    patch: &super::contracts::AiPatchSetPayload,
    result: &AiApplyPatchPayload,
    metadata: &super::contracts::AiApplyPatchMetadataRequest,
) {
    let seq = next_agent_stream_seq();
    let applied_at = chrono::Utc::now().to_rfc3339();
    let Some(summary) = ai_patch::build_agent_patch_summary(
        patch,
        &result.applied_files,
        metadata,
        applied_at,
        seq,
    ) else {
        return;
    };

    let event = AiAgentPatchSummaryStreamEventPayload {
        event: "patch.summary".to_string(),
        seq,
        run_id: summary.run_id.clone(),
        summary,
    };

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("ai:agent-stream", event);
    }
}

fn emit_agent_run_event(app: &AppHandle, run: &AiAgentRunPayload) {
    let event = AiAgentRunStreamEventPayload {
        event: "agent.run".to_string(),
        seq: next_agent_stream_seq(),
        run_id: run.id.clone(),
        run: run.clone(),
    };

    emit_agent_stream_payload(app, event);
}

fn emit_agent_step_event(app: &AppHandle, run_id: &str, step: &AiTaskPlanStepPayload) {
    let event = AiAgentStepStreamEventPayload {
        event: "agent.step".to_string(),
        seq: next_agent_stream_seq(),
        run_id: run_id.to_string(),
        step: step.clone(),
    };

    emit_agent_stream_payload(app, event);
}

fn emit_agent_tool_activity(
    app: &AppHandle,
    run_id: &str,
    step_id: &str,
    tool_name: &str,
    state: &str,
    label: String,
) {
    if !registry::is_tool_registered(tool_name) {
        return;
    }

    let timestamp = chrono::Utc::now().to_rfc3339();
    let event = AiAgentToolActivityStreamEventPayload {
        event: "tool.activity".to_string(),
        seq: next_agent_stream_seq(),
        run_id: run_id.to_string(),
        activity: AiToolActivityInlinePayload {
            id: format!("{run_id}:{step_id}:{tool_name}:{state}"),
            step_id: step_id.to_string(),
            tool_name: tool_name.to_string(),
            state: state.to_string(),
            label,
            target_preview: None,
            started_at: timestamp,
            elapsed_ms: None,
        },
    };

    emit_agent_stream_payload(app, event);
}

fn emit_agent_tool_confirmation(
    app: &AppHandle,
    run_id: &str,
    confirmation: super::contracts::AiToolConfirmationRequestPayload,
) {
    let event = AiAgentToolConfirmationStreamEventPayload {
        event: "tool.confirmation".to_string(),
        seq: next_agent_stream_seq(),
        run_id: run_id.to_string(),
        confirmation,
    };

    emit_agent_stream_payload(app, event);
}

fn emit_agent_stream_end(app: &AppHandle, run_id: &str, reason: &str) {
    let event = AiAgentStreamEndEventPayload {
        event: "stream.end".to_string(),
        seq: next_agent_stream_seq(),
        run_id: run_id.to_string(),
        reason: reason.to_string(),
    };

    emit_agent_stream_payload(app, event);
}

fn emit_agent_step_transition(
    app: &AppHandle,
    before: Option<&AiAgentRunPayload>,
    after: &AiAgentRunPayload,
) {
    let Some(step) = find_changed_step(before, after) else {
        return;
    };

    emit_agent_step_event(app, &after.id, step);

    match step.status.as_str() {
        "running" => {
            for tool_name in &step.tools {
                emit_agent_tool_activity(
                    app,
                    &after.id,
                    &step.id,
                    tool_name,
                    "running",
                    build_tool_activity_label(tool_name, step),
                );
            }
        }
        "done" => {
            let tool_results = agent_runtime::list_step_tool_result_messages(&after.id, &step.id);
            if !tool_results.is_empty() {
                for result in tool_results {
                    let state = if result.status == "failed" {
                        "failed"
                    } else {
                        "succeeded"
                    };
                    emit_agent_tool_activity(
                        app,
                        &after.id,
                        &step.id,
                        &result.tool_name,
                        state,
                        result.summary,
                    );
                }
                return;
            }

            for tool_name in &step.tools {
                emit_agent_tool_activity(
                    app,
                    &after.id,
                    &step.id,
                    tool_name,
                    "succeeded",
                    build_completed_tool_activity_label(tool_name, step),
                );
            }
        }
        "failed" | "cancelled" => {
            for tool_name in &step.tools {
                emit_agent_tool_activity(
                    app,
                    &after.id,
                    &step.id,
                    tool_name,
                    "cancelled",
                    build_cancelled_tool_activity_label(tool_name, step),
                );
            }
        }
        _ => {}
    }
}

fn build_completed_tool_activity_label(tool_name: &str, step: &AiTaskPlanStepPayload) -> String {
    let running_label = build_tool_activity_label(tool_name, step);
    let completed = running_label
        .strip_prefix("正在")
        .map(|rest| format!("已{}", rest.trim_end_matches('…')))
        .unwrap_or_else(|| format!("已使用 {tool_name}"));

    completed.trim().to_string()
}

fn build_cancelled_tool_activity_label(tool_name: &str, step: &AiTaskPlanStepPayload) -> String {
    let running_label = build_tool_activity_label(tool_name, step);
    let target = running_label
        .strip_prefix("正在")
        .unwrap_or(tool_name)
        .trim_end_matches('…')
        .trim();

    if target.is_empty() {
        return format!("已停止 {tool_name}");
    }

    format!("已停止{target}")
}

fn find_changed_step<'a>(
    before: Option<&AiAgentRunPayload>,
    after: &'a AiAgentRunPayload,
) -> Option<&'a AiTaskPlanStepPayload> {
    let Some(before) = before else {
        return after
            .current_step_id
            .as_ref()
            .and_then(|step_id| after.steps.iter().find(|step| &step.id == step_id));
    };

    after.steps.iter().find(|next_step| {
        before
            .steps
            .iter()
            .find(|previous_step| previous_step.id == next_step.id)
            .is_some_and(|previous_step| {
                previous_step.status != next_step.status
                    || previous_step.is_active != next_step.is_active
            })
    })
}

fn emit_agent_stream_payload<T: Clone + serde::Serialize>(app: &AppHandle, payload: T) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("ai:agent-stream", payload);
    }
}

#[tauri::command]
pub fn ai_edit_get_auth_level(state: State<AiEditState>) -> Result<AiEditAuthStatePayload, String> {
    ai_edit::get_auth_level(state.inner())
}

#[tauri::command]
pub fn ai_edit_set_auth_level(
    payload: AiEditSetAuthLevelRequest,
    state: State<AiEditState>,
) -> Result<AiEditAuthStatePayload, String> {
    ai_edit::set_auth_level(payload, state.inner())
}

#[tauri::command]
pub fn ai_edit_list_timeline(
    app: AppHandle,
    payload: AiEditListTimelineRequest,
    state: State<AiEditState>,
) -> Result<AiEditListTimelinePayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    let stored_snapshots = ai_edit::snapshot::list_stored_snapshots(&snapshot_root)?;
    let stored_operations = ai_edit::edit_journal::list_operations(&snapshot_root)?;
    ai_edit::list_timeline_with_state(payload, state.inner(), stored_snapshots, stored_operations)
}

#[tauri::command]
pub fn ai_edit_get_diff(
    app: AppHandle,
    payload: AiEditGetDiffRequest,
    state: State<AiEditState>,
) -> Result<AiEditGetDiffPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    ai_edit::get_diff(payload, &snapshot_root, state.inner())
}

#[tauri::command]
pub fn ai_edit_create_snapshot(
    app: AppHandle,
    payload: AiEditCreateSnapshotRequest,
    state: State<AiEditState>,
) -> Result<AiEditCreateSnapshotPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    ai_edit::create_snapshot(payload, &snapshot_root, state.inner())
}

#[tauri::command]
pub fn ai_edit_restore_snapshot(
    app: AppHandle,
    payload: AiEditRestoreSnapshotRequest,
    state: State<AiEditState>,
) -> Result<AiEditRestoreSnapshotPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    ai_edit::restore_snapshot(payload, &snapshot_root, state.inner())
}

#[tauri::command]
pub fn ai_edit_undo_operation(
    app: AppHandle,
    payload: AiEditUndoOperationRequest,
    state: State<AiEditState>,
) -> Result<AiEditUndoOperationPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    ai_edit::undo_operation(payload, &snapshot_root, state.inner())
}

#[tauri::command]
pub fn ai_edit_revert_file(
    app: AppHandle,
    payload: AiEditRevertFileRequest,
    state: State<AiEditState>,
) -> Result<AiEditRevertFilePayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    ai_edit::revert_file(payload, &snapshot_root, state.inner())
}

#[tauri::command]
pub fn ai_edit_revert_hunk(
    app: AppHandle,
    payload: AiEditRevertHunkRequest,
    state: State<AiEditState>,
) -> Result<AiEditRevertHunkPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    ai_edit::revert_hunk(payload, &snapshot_root, state.inner())
}

#[tauri::command]
pub fn ai_edit_revert_task(
    app: AppHandle,
    payload: AiEditRevertTaskRequest,
    state: State<AiEditState>,
) -> Result<AiEditRevertTaskPayload, String> {
    let snapshot_root = resolve_ai_edit_storage_root(&app)?;
    ai_edit::revert_task(payload, &snapshot_root, state.inner())
}

#[tauri::command]
pub fn ai_list_tools() -> Result<Vec<AiToolDefinitionPayload>, String> {
    Ok(registry::list_tools()
        .into_iter()
        .map(|tool| AiToolDefinitionPayload {
            name: tool.name.to_string(),
            read_only: tool.read_only,
            destructive: tool.destructive,
            requires_confirmation: tool.requires_confirmation,
        })
        .collect())
}

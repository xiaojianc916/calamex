//! Native orchestration (Mastra createWorkflow) client command layer.
//!
//! Defined as a child module of `agent_sidecar` so it can reuse the parent's
//! existing HTTP / streaming / sidecar-autostart private helpers (via `super::`).
//! Both orchestration channels stream workflow events to the UI as NDJSON,
//! mirroring the per-phase `/stream` routes:
//!   - `orchestrate`        -> streaming POST `/agent/plan/orchestrate/stream`
//!   - `orchestrate_resume` -> streaming POST `/agent/plan/orchestrate/resume/stream`
//!
//! Gated on the sidecar by `AGENT_ORCHESTRATION_WORKFLOW`: when disabled the
//! streaming endpoints return 404, and we surface an explicit
//! `AGENT_SIDECAR_ORCHESTRATION_DISABLED` error WITHOUT silently falling back to
//! a non-streaming legacy endpoint (orchestration has no legacy fallback).
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{
    build_sidecar_url, client, configured_base_url, current_sidecar_model_config, decode_response,
    decode_sidecar_stream_line_bytes, drain_complete_sidecar_stream_lines,
    emit_sidecar_stream_event, ensure_default_sidecar_available, ensure_request_session_id,
    has_non_whitespace_bytes,
};
use crate::commands::contracts::{
    AgentSidecarOrchestratePayload, AgentSidecarOrchestrateRequest,
    AgentSidecarOrchestrateResumeRequest,
};

const ORCHESTRATE_STREAM_ENDPOINT: &str = "/agent/plan/orchestrate/stream";
const ORCHESTRATE_RESUME_STREAM_ENDPOINT: &str = "/agent/plan/orchestrate/resume/stream";

/// NDJSON frames pushed by the orchestration streaming endpoints
/// (`/agent/plan/orchestrate/stream` and `/agent/plan/orchestrate/resume/stream`).
///
/// Unlike the per-phase `AgentSidecarStreamFrame`: the orchestration stream's
/// first frame is `meta{runId}` and the last is `response{runId,result}` (the
/// server also sends a redundant `status` field, ignored as an unknown field).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
enum AgentSidecarOrchestrateStreamFrame {
    #[serde(rename = "meta")]
    Meta {
        #[serde(rename = "runId")]
        #[allow(dead_code)]
        run_id: String,
    },
    #[serde(rename = "event")]
    Event { event: serde_json::Value },
    #[serde(rename = "response")]
    Response {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(default)]
        result: serde_json::Value,
    },
    #[serde(rename = "error")]
    Error { error: String },
}

fn consume_orchestrate_stream_line(
    app: &AppHandle,
    session_id: &str,
    seq: &mut u64,
    line: &str,
    endpoint: &str,
) -> Result<Option<AgentSidecarOrchestratePayload>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let frame = serde_json::from_str::<AgentSidecarOrchestrateStreamFrame>(trimmed).map_err(
        |error| {
            format!(
                "AGENT_SIDECAR_CONTRACT_ERROR: failed to parse sidecar stream response ({endpoint}): {error}"
            )
        },
    )?;

    match frame {
        AgentSidecarOrchestrateStreamFrame::Meta { .. } => Ok(None),
        AgentSidecarOrchestrateStreamFrame::Event { event } => {
            emit_sidecar_stream_event(app, session_id, *seq, event);
            *seq += 1;
            Ok(None)
        }
        AgentSidecarOrchestrateStreamFrame::Response { run_id, result } => {
            Ok(Some(AgentSidecarOrchestratePayload { run_id, result }))
        }
        AgentSidecarOrchestrateStreamFrame::Error { error } => Err(format!(
            "AGENT_SIDECAR_STREAM_ERROR: sidecar stream execution failed ({endpoint}): {error}"
        )),
    }
}

/// Shared NDJSON streaming driver for the orchestration channels. Posts
/// `payload` to `endpoint`, emits each inner agent `event` frame to
/// `ai:sidecar-stream`, and returns the final `response{runId,result}` frame.
/// A 404 means orchestration is disabled on the sidecar (no legacy fallback).
async fn post_orchestrate_streaming<TRequest>(
    app: &AppHandle,
    endpoint: &str,
    payload: &TRequest,
    session_id: &str,
) -> Result<AgentSidecarOrchestratePayload, String>
where
    TRequest: Serialize,
{
    let base_url = configured_base_url();
    ensure_default_sidecar_available(&base_url).await?;

    let url = build_sidecar_url(&base_url, endpoint);
    let mut response = client()?
        .post(&url)
        .json(payload)
        .send()
        .await
        .map_err(|error| {
            format!("AGENT_SIDECAR_UNAVAILABLE: failed to connect to Node sidecar ({url}): {error}")
        })?;

    let status = response.status();
    if status.as_u16() == 404 {
        return Err(
            "AGENT_SIDECAR_ORCHESTRATION_DISABLED: native orchestration endpoint is not enabled; set AGENT_ORCHESTRATION_WORKFLOW=1 on the sidecar and restart."
                .to_string(),
        );
    }
    if !status.is_success() {
        return decode_response(response, endpoint).await;
    }

    let mut buffer: Vec<u8> = Vec::new();
    let mut seq = 0_u64;
    let mut final_response: Option<AgentSidecarOrchestratePayload> = None;

    while let Some(chunk) = response.chunk().await.map_err(|error| {
        format!(
            "AGENT_SIDECAR_READ_ERROR: failed to read sidecar stream response ({endpoint}): {error}"
        )
    })? {
        buffer.extend_from_slice(&chunk);

        for line in drain_complete_sidecar_stream_lines(&mut buffer, endpoint)? {
            if let Some(response) =
                consume_orchestrate_stream_line(app, session_id, &mut seq, &line, endpoint)?
            {
                final_response = Some(response);
            }
        }
    }

    if has_non_whitespace_bytes(&buffer) {
        let line = decode_sidecar_stream_line_bytes(std::mem::take(&mut buffer), endpoint)?;

        if let Some(response) =
            consume_orchestrate_stream_line(app, session_id, &mut seq, &line, endpoint)?
        {
            final_response = Some(response);
        }
    }

    final_response.ok_or_else(|| {
        format!(
            "AGENT_SIDECAR_CONTRACT_ERROR: sidecar stream response missing final result ({endpoint})"
        )
    })
}

/// Start one native orchestration run: runs until it suspends at an approval
/// gate or reaches a terminal state, streaming workflow events to the
/// `ai:sidecar-stream` window event throughout, and returns `{runId, result}`.
pub async fn orchestrate(
    app: AppHandle,
    mut payload: AgentSidecarOrchestrateRequest,
) -> Result<AgentSidecarOrchestratePayload, String> {
    let session_id = ensure_request_session_id(&mut payload.session_id, "sidecar-orchestrate");
    if payload.model_config.is_none() {
        payload.model_config = Some(current_sidecar_model_config()?);
    }
    post_orchestrate_streaming(&app, ORCHESTRATE_STREAM_ENDPOINT, &payload, &session_id).await
}

/// Resume an orchestration run suspended at an approval gate (approve / reject),
/// streaming the post-approval execute -> validate -> replan -> finish phases to
/// the `ai:sidecar-stream` window event (same UI contract as `orchestrate`), and
/// returns the post-resume `{runId, result}`.
pub async fn orchestrate_resume(
    app: AppHandle,
    mut payload: AgentSidecarOrchestrateResumeRequest,
) -> Result<AgentSidecarOrchestratePayload, String> {
    if payload.model_config.is_none() {
        payload.model_config = Some(current_sidecar_model_config()?);
    }
    // The resume request has no session_id field (the run is keyed by runId);
    // synthesize one only to label the emitted `ai:sidecar-stream` events so the
    // post-approval phases stream with the same UI contract as the initial run.
    let mut session_id_slot: Option<String> = None;
    let session_id = ensure_request_session_id(&mut session_id_slot, "sidecar-orchestrate-resume");
    post_orchestrate_streaming(
        &app,
        ORCHESTRATE_RESUME_STREAM_ENDPOINT,
        &payload,
        &session_id,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::AgentSidecarOrchestrateStreamFrame;

    #[test]
    fn orchestrate_stream_frames_decode_by_type_tag() {
        let meta: AgentSidecarOrchestrateStreamFrame =
            serde_json::from_str(r#"{"type":"meta","runId":"run-1"}"#)
                .expect("meta frame should decode");
        assert!(matches!(
            meta,
            AgentSidecarOrchestrateStreamFrame::Meta { .. }
        ));

        let event: AgentSidecarOrchestrateStreamFrame = serde_json::from_str(
            r#"{"type":"event","event":{"type":"message_delta","text":"hi"}}"#,
        )
        .expect("event frame should decode");
        match event {
            AgentSidecarOrchestrateStreamFrame::Event { event } => assert_eq!(
                event.get("type").and_then(|value| value.as_str()),
                Some("message_delta")
            ),
            other => panic!("expected event frame, got {other:?}"),
        }

        // The response frame carries a redundant `status` field that must be
        // ignored on decode; only runId + result are taken.
        let response: AgentSidecarOrchestrateStreamFrame = serde_json::from_str(
            r#"{"type":"response","runId":"run-1","status":"success","result":{"ok":true}}"#,
        )
        .expect("response frame should decode");
        match response {
            AgentSidecarOrchestrateStreamFrame::Response { run_id, result } => {
                assert_eq!(run_id, "run-1");
                assert_eq!(
                    result.get("ok").and_then(|value| value.as_bool()),
                    Some(true)
                );
            }
            other => panic!("expected response frame, got {other:?}"),
        }

        let error: AgentSidecarOrchestrateStreamFrame =
            serde_json::from_str(r#"{"type":"error","error":"boom"}"#)
                .expect("error frame should decode");
        match error {
            AgentSidecarOrchestrateStreamFrame::Error { error } => assert_eq!(error, "boom"),
            other => panic!("expected error frame, got {other:?}"),
        }
    }
}

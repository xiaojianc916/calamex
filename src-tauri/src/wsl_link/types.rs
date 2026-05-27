use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_PROTOCOL_VERSION: &str = "wsl-link.v1";
pub const DEFAULT_VSOCK_GRPC_PORT: u32 = 50_373;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WslLinkTransportKind {
    VsockGrpc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslLinkResumeFrame {
    pub session_id: String,
    pub last_ack_server_seq: u64,
    pub last_client_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslLinkAck {
    pub session_id: String,
    pub ack_client_seq: u64,
    pub server_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslLinkEnvelope {
    pub session_id: String,
    pub request_id: String,
    pub idempotency_key: String,
    pub client_seq: u64,
    pub ack_server_seq: u64,
    pub trace_id: String,
    pub payload: Vec<u8>,
    pub created_at_unix_ms: u64,
}

impl WslLinkEnvelope {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.session_id.trim().is_empty() {
            return Err("session_id 不能为空。");
        }
        if self.request_id.trim().is_empty() {
            return Err("request_id 不能为空。");
        }
        if self.idempotency_key.trim().is_empty() {
            return Err("idempotency_key 不能为空。");
        }
        if self.trace_id.trim().is_empty() {
            return Err("trace_id 不能为空。");
        }
        if self.client_seq == 0 {
            return Err("client_seq 必须从 1 开始。");
        }

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslLinkMetrics {
    pub active_transport: Option<WslLinkTransportKind>,
    pub rtt_ms: Option<u64>,
    pub reconnects_total: u64,
    pub inflight_requests: u64,
    pub last_error: Option<String>,
}

pub fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_envelope() -> WslLinkEnvelope {
        WslLinkEnvelope {
            session_id: "s1".to_string(),
            request_id: "r1".to_string(),
            idempotency_key: "idem-1".to_string(),
            client_seq: 1,
            ack_server_seq: 0,
            trace_id: "trace-1".to_string(),
            payload: b"ping".to_vec(),
            created_at_unix_ms: 1,
        }
    }

    #[test]
    fn envelope_rejects_empty_idempotency_key() {
        let mut envelope = valid_envelope();
        envelope.idempotency_key.clear();

        assert!(envelope.validate().is_err());
    }

    #[test]
    fn envelope_accepts_valid_payload() {
        assert!(valid_envelope().validate().is_ok());
    }
}

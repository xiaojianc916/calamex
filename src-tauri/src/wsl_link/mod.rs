//! WSL Link 可靠连接核心。
//!
//! 当前模块收敛为单通道连接核心：状态机、退避抖动、HTTP/2 keepalive、
//! `AF_HYPERV` / `AF_VSOCK` + tonic gRPC、Noise 握手和 `(session, client_seq)`
//! 去重。生产切流必须等待真机矩阵。

// @status: yellow
// 保留原因：ADR-20260506 的 P0 可靠性核心先于生产传输接入落地。
// 复活条件：WSL agent、AF_HYPERV / AF_VSOCK、重连和终端切流矩阵完成后移除此豁免。
// 负责人：xiaojianc 
// 截止日期：2026-06-06
#![allow(dead_code)]

#[cfg(not(feature = "wsl-link-agent"))]
pub mod adapters;
pub mod agent;
#[cfg(not(feature = "wsl-link-agent"))]
pub mod agent_distribution;
#[cfg(not(feature = "wsl-link-agent"))]
pub mod agent_install;
pub mod agent_runtime;
pub mod config;
#[cfg(not(feature = "wsl-link-agent"))]
pub mod grpc_transport;
#[cfg(not(feature = "wsl-link-agent"))]
pub mod manager;
pub mod noise;
pub mod noise_stream;
pub mod noise_handshake;
pub mod noise_material;
#[cfg(not(feature = "wsl-link-agent"))]
pub mod primary_supervisor;
pub mod protocol;
#[cfg(not(feature = "wsl-link-agent"))]
pub mod retry;
#[cfg(not(feature = "wsl-link-agent"))]
pub mod runtime;
#[cfg(not(feature = "wsl-link-agent"))]
pub mod self_check;
#[cfg(not(feature = "wsl-link-agent"))]
pub mod state_machine;
#[cfg(not(feature = "wsl-link-agent"))]
pub mod terminal_client;
pub mod terminal_exec;
pub mod types;

#[cfg(all(test, windows, not(feature = "wsl-link-agent")))]
mod smoke_tests;

#[cfg(all(test, not(feature = "wsl-link-agent")))]
mod e2e_tests;

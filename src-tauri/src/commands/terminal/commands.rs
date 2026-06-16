//! 集成终端命令入口：对前端暴露的 Tauri 命令。
//!
//! 本模块只负责命令编排，状态存取下沉到 `state`，事件发射下沉到 `events`。

use jiff::Timestamp;
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use tauri::{AppHandle, State};

use crate::terminal::{
    command_contracts::{
        CancelTerminalRunRequest, CloseTerminalSessionRequest, DispatchTerminalScriptPayload,
        DispatchTerminalScriptRequest, EnsureTerminalSessionRequest, TerminalInputRequest,
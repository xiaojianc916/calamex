#![allow(dead_code)]

use agent_client_protocol::{
    BoxFuture,
    schema::{
        ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse,
    },
};
use std::sync::Arc;

pub type AcpResult<T> = Result<T, agent_client_protocol::Error>;

pub type FsReadResolver = Arc<
    dyn Fn(ReadTextFileRequest) -> BoxFuture<'static, AcpResult<ReadTextFileResponse>>
        + Send
        + Sync,
>;

pub type FsWriteResolver = Arc<
    dyn Fn(WriteTextFileRequest) -> BoxFuture<'static, AcpResult<WriteTextFileResponse>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct AcpBridges {
    pub fs_read: FsReadResolver,
    pub fs_write: FsWriteResolver,
}

impl AcpBridges {
    pub fn disk_backed() -> Self {
        Self {
            fs_read: super::fs_bridge::fs_read_resolver(),
            fs_write: super::fs_bridge::fs_write_resolver(),
        }
    }
}

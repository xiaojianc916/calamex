use agent_client_protocol::{
    BoxFuture, Error,
    schema::{
        ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse,
    },
};
use std::sync::Arc;

use super::bridges::{AcpResult, FsReadResolver, FsWriteResolver};

pub fn fs_read_resolver() -> FsReadResolver {
    Arc::new(
        |req: ReadTextFileRequest| -> BoxFuture<'static, AcpResult<ReadTextFileResponse>> {
            Box::pin(async move {
                let path = req.path.clone();
                let content = std::fs::read_to_string(&path).map_err(|err| {
                    if err.kind() == std::io::ErrorKind::NotFound {
                        Error::resource_not_found(Some(path.display().to_string()))
                    } else {
                        Error::into_internal_error(err)
                    }
                })?;
                let sliced = slice_lines(&content, req.line, req.limit);
                Ok(ReadTextFileResponse::new(sliced))
            })
        },
    )
}

pub fn fs_write_resolver() -> FsWriteResolver {
    Arc::new(
        |req: WriteTextFileRequest| -> BoxFuture<'static, AcpResult<WriteTextFileResponse>> {
            Box::pin(async move {
                if let Some(parent) = req.path.parent()
                    && !parent.as_os_str().is_empty()
                {
                    std::fs::create_dir_all(parent).map_err(Error::into_internal_error)?;
                }
                std::fs::write(&req.path, req.content.as_bytes())
                    .map_err(Error::into_internal_error)?;
                Ok(WriteTextFileResponse::new())
            })
        },
    )
}

fn slice_lines(content: &str, line: Option<u32>, limit: Option<u32>) -> String {
    if line.is_none() && limit.is_none() {
        return content.to_string();
    }
    let start = line.map(|value| value.saturating_sub(1) as usize).unwrap_or(0);
    let selected = content.lines().skip(start);
    let collected: Vec<&str> = match limit {
        Some(count) => selected.take(count as usize).collect(),
        None => selected.collect(),
    };
    collected.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slice_lines_returns_all_when_unbounded() {
        let input = "a\nb\nc";
        assert_eq!(slice_lines(input, None, None), "a\nb\nc");
    }

    #[test]
    fn slice_lines_applies_offset_and_limit() {
        let input = "a\nb\nc\nd";
        assert_eq!(slice_lines(input, Some(2), Some(2)), "b\nc");
    }
}

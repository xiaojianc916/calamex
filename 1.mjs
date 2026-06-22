// fix-acp-cancel.mjs
// 带外取消修复:AcpClientHandle::cancel 绕过串行命令队列,直接经连接句柄发 session/cancel。
// 仅改 src-tauri/src/acp/client.rs;最小必要、可逆;无 .bak。
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'src-tauri/src/acp/client.rs'
let src = readFileSync(FILE, 'utf8')

function replaceOnce(from, to, label) {
  const n = src.split(from).length - 1
  if (n !== 1) {
    throw new Error(`[${label}] 期望命中 1 处,实际 ${n} 处——文件可能已变更,已中止(未写入任何内容)`)
  }
  src = src.replace(from, to)
  console.log(`✓ ${label}`)
}

// 1) 引入 std::sync::Mutex
replaceOnce(
`use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};`,
`use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};`,
  'import Mutex',
)

// 2) 删除 Command::Cancel 变体(取消改走带外通道)
replaceOnce(
`    Cancel {
        session_id: SessionId,
    },
    Shutdown,
}`,
`    Shutdown,
}`,
  'remove Command::Cancel variant',
)

// 3) AcpClientHandle 新增带外取消槽
replaceOnce(
`#[derive(Clone)]
pub struct AcpClientHandle {
    cmd_tx: mpsc::UnboundedSender<Command>,
}`,
`#[derive(Clone)]
pub struct AcpClientHandle {
    cmd_tx: mpsc::UnboundedSender<Command>,
    /// 带外取消通道:连接就绪后存入 \`cx.clone()\`,让 \`cancel()\` 绕过串行命令队列,
    /// 即便 Prompt 把命令循环 .await 阻塞,也能直接发 \`session/cancel\`。
    cancel_cx: Arc<Mutex<Option<ConnectionTo<Agent>>>>,
}`,
  'AcpClientHandle.cancel_cx field',
)

// 4) 重写 cancel():带外直发,不再入队
replaceOnce(
`    pub fn cancel(&self, session_id: SessionId) -> Result<(), AcpClientError> {
        self.cmd_tx
            .send(Command::Cancel { session_id })
            .map_err(|_| AcpClientError::NotRunning)
    }`,
`    pub fn cancel(&self, session_id: SessionId) -> Result<(), AcpClientError> {
        // 带外取消:直接经连接句柄发送 session/cancel,绕过串行命令队列。
        // 即使命令循环正卡在某个 Prompt 的 .await 上,取消通知依旧能送达 agent,
        // 触发 StopReason::Cancelled 解阻塞该 Prompt → 循环恢复 → 死锁解除。
        let guard = self
            .cancel_cx
            .lock()
            .map_err(|_| AcpClientError::NotRunning)?;
        let cx = guard.as_ref().ok_or(AcpClientError::NotRunning)?;
        cx.send_notification(CancelNotification::new(session_id))
            .map_err(|error| AcpClientError::Transport(error.to_string()))
    }`,
  'rewrite cancel() out-of-band',
)

// 5) 创建共享槽 + 任务侧克隆
replaceOnce(
`    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Command>();
    let seq = Arc::new(AtomicU64::new(0));`,
`    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Command>();
    let seq = Arc::new(AtomicU64::new(0));

    // 带外取消通道:连接闭包就绪后写入 cx 克隆,供 AcpClientHandle::cancel 直接使用。
    let cancel_cx: Arc<Mutex<Option<ConnectionTo<Agent>>>> = Arc::new(Mutex::new(None));
    let cancel_cx_task = cancel_cx.clone();`,
  'create cancel_cx slot',
)

// 6) 连接建立后存入 cx 克隆
replaceOnce(
`                cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;

                while let Some(command) = cmd_rx.recv().await {`,
`                cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;

                // 连接已建立:把 cx 克隆存入共享槽,使带外取消在循环阻塞时仍能发出 session/cancel。
                if let Ok(mut slot) = cancel_cx_task.lock() {
                    *slot = Some(cx.clone());
                }

                while let Some(command) = cmd_rx.recv().await {`,
  'stash cx clone after init',
)

// 7) 删除 Command::Cancel 匹配臂 + 循环退出清空槽
replaceOnce(
`                        Command::AgentAskUserResume { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::Cancel { session_id } => {
                            if let Err(error) =
                                cx.send_notification(CancelNotification::new(session_id))
                            {
                                log::warn!("acp cancel notification failed: {error}");
                            }
                        }
                        Command::Shutdown => break,
                    }
                }

                Ok::<(), agent_client_protocol::Error>(())
            })`,
`                        Command::AgentAskUserResume { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::Shutdown => break,
                    }
                }

                // 循环退出(Shutdown 或命令通道关闭):清空带外取消槽,避免对已断连接再发通知。
                if let Ok(mut slot) = cancel_cx_task.lock() {
                    *slot = None;
                }

                Ok::<(), agent_client_protocol::Error>(())
            })`,
  'remove Cancel arm + clear slot on exit',
)

// 8) 返回带上 cancel_cx
replaceOnce(
`    Ok(AcpClientHandle { cmd_tx })
}`,
`    Ok(AcpClientHandle { cmd_tx, cancel_cx })
}`,
  'return handle with cancel_cx',
)

// 9) 回归测试
replaceOnce(
`        assert_eq!(value["optionIds"], serde_json::json!([]));
        assert!(value.get("text").is_none());
    }
}`,
`        assert_eq!(value["optionIds"], serde_json::json!([]));
        assert!(value.get("text").is_none());
    }

    // ---- 取消死锁回归测试 ----

    #[test]
    fn cancel_bypasses_serial_command_queue() {
        // 回归(带外取消):cancel() 必须绕过串行命令队列(cmd_tx)直接走连接句柄。
        // 旧实现把 Cancel 投进 cmd_tx,一旦 Prompt 把命令循环 .await 阻塞,
        // Cancel 永远排在队尾发不出去 → 死锁直到重启。
        //
        // 连接句柄尚未就绪(None)时,cancel 应立即返回 NotRunning,
        // 且绝不向命令队列投递任何命令(断言队列仍为空)。
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Command>();
        let handle = AcpClientHandle {
            cmd_tx,
            cancel_cx: Arc::new(Mutex::new(None)),
        };

        let result = handle.cancel(SessionId::from("sess_1".to_string()));
        assert!(matches!(result, Err(AcpClientError::NotRunning)));
        assert!(
            cmd_rx.try_recv().is_err(),
            "cancel 不得经由串行命令队列,否则会被阻塞的 Prompt 卡住"
        );
    }
}`,
  'add regression test',
)

writeFileSync(FILE, src, 'utf8')
console.log('\n全部 9 处替换完成,已写回', FILE)
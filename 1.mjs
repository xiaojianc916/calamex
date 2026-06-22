// scripts/fix-acp-approval-oob.mjs
// 根因修复 A:审批处理器带外作答,解除 SDK 单入站分发循环被人类决策阻塞导致的全局死锁。
// 在仓库根目录运行：  node scripts/fix-acp-approval-oob.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src-tauri/src/acp/client.rs';

const OLD = `                    async move {
                        let outcome = match resolver(req).await {
                            PermissionDecision::Selected(option_id) => {
                                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                                    option_id,
                                ))
                            }
                            PermissionDecision::Cancelled => RequestPermissionOutcome::Cancelled,
                        };
                        responder.respond(RequestPermissionResponse::new(outcome))?;
                        Ok::<(), agent_client_protocol::Error>(())
                    }`;

const NEW = `                    async move {
                        // 带外作答(根因修复):审批是人类决策,可阻塞任意长时间。SDK 单入站分发循环
                        // 按序 await 每个处理器 future,若在此内联 resolver(req).await,整个入站循环会被
                        // 人类卡死——连同同一回合 Prompt 的 StopReason 响应都无法被路由回去,使命令循环的
                        // block_task().await 永不返回,后续命令(含带外 session/cancel 触发的 Cancelled
                        // 响应)永久排队 → 必须重启。把「等裁决 + 回投响应」搬进独立任务,处理器立即返回:
                        // Responder 独占响应通道(SDK typed.rs/handlers.rs:返回 Handled::Yes 不会自动
                        // 应答,响应仅由 responder.respond 发出),延迟到独立任务里应答是安全的,且入站循环
                        // 瞬间空闲,可继续路由 Prompt / Cancelled 响应。
                        tokio::spawn(async move {
                            let outcome = match resolver(req).await {
                                PermissionDecision::Selected(option_id) => {
                                    RequestPermissionOutcome::Selected(
                                        SelectedPermissionOutcome::new(option_id),
                                    )
                                }
                                PermissionDecision::Cancelled => {
                                    RequestPermissionOutcome::Cancelled
                                }
                            };
                            if let Err(error) =
                                responder.respond(RequestPermissionResponse::new(outcome))
                            {
                                log::warn!("acp permission responder failed: {error}");
                            }
                        });
                        Ok::<(), agent_client_protocol::Error>(())
                    }`;

const MARKER = 'acp permission responder failed';

let src = readFileSync(FILE, 'utf8');

if (src.includes(MARKER)) {
  console.log('已是带外作答版本,跳过(幂等)。');
  process.exit(0);
}

const count = src.split(OLD).length - 1;
if (count !== 1) {
  console.error(
    `锚点匹配 ${count} 次(期望 1)。client.rs 已与预期字节不一致,中止;请回报当前 on_receive_request 块。`,
  );
  process.exit(1);
}

src = src.replace(OLD, NEW);
writeFileSync(FILE, src, 'utf8');
console.log('OK:审批处理器已改为带外作答(A)。');
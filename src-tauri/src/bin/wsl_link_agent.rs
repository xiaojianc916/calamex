#[cfg(target_os = "linux")]
#[path = "../wsl_link/mod.rs"]
mod wsl_link;

#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use std::{env, sync::Arc};

    use tokio_vsock::{VsockAddr, VsockListener, VMADDR_CID_ANY};
    use wsl_link::{
        agent::WslLinkAgentService,
        agent_runtime::{
            agent_help_text, resolve_agent_startup_action, WslLinkAgentStartupAction,
            AGENT_NOISE_CONFIG_ENV,
        },
        config::WslLinkTransportConfig,
        noise_handshake::perform_responder_handshake,
        noise_material::load_agent_material_from_file,
        noise_stream::NoiseStream,
        protocol::v1::wsl_link_server::WslLinkServer,
    };

    let startup =
        resolve_agent_startup_action(env::args(), env::var(AGENT_NOISE_CONFIG_ENV).ok())?;
    let startup_config = match startup {
        WslLinkAgentStartupAction::Run(config) => config,
        WslLinkAgentStartupAction::PrintHelp => {
            println!("{}", agent_help_text());
            return Ok(());
        }
    };

    let noise_material =
        Arc::new(load_agent_material_from_file(&startup_config.noise_config_path)?);
    let config = WslLinkTransportConfig::default();
    let mut listener =
        VsockListener::bind(VsockAddr::new(VMADDR_CID_ANY, config.vsock_grpc_port))?;

    // Stage 2 服务端核心改造:每个 VSOCK accept 后立即跑 Noise responder 握手,
    // 失败的连接静默丢弃 (日志记录,不毒化 listener)。握手成功后产出
    // NoiseStream<VsockStream>,所有 HTTP/2 流量在 vsock 线缆上是密文。
    //
    // 握手并发跑 (per-connection spawn),不阻塞后续 accept。
    let (incoming_tx, incoming_rx) =
        tokio::sync::mpsc::channel::<Result<NoiseStream<tokio_vsock::VsockStream>, std::io::Error>>(
            16,
        );
    let handshake_material = Arc::clone(&noise_material);
    tokio::spawn(async move {
        loop {
            let (stream, _addr) = match listener.accept().await {
                Ok(pair) => pair,
                Err(error) => {
                    eprintln!("WSL Link agent VSOCK accept 失败:{error}");
                    continue;
                }
            };
            let material = Arc::clone(&handshake_material);
            let tx = incoming_tx.clone();
            tokio::spawn(async move {
                let config = material.responder_config();
                match perform_responder_handshake(stream, &config).await {
                    Ok((stream, transport)) => {
                        let noise = NoiseStream::new(stream, transport);
                        // 发送失败 = serve_with_incoming 已退出,直接放弃即可
                        let _ = tx.send(Ok(noise)).await;
                    }
                    Err(error) => {
                        eprintln!("WSL Link agent Noise 握手失败:{error}");
                    }
                }
            });
        }
    });

    let incoming = tonic::codegen::tokio_stream::wrappers::ReceiverStream::new(incoming_rx);

    config
        .grpc_server_builder()
        .add_service(WslLinkServer::new(WslLinkAgentService::new()))
        .serve_with_incoming(incoming)
        .await?;

    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("wsl-link-agent 仅面向 Linux/WSL2 构建。");
    std::process::exit(2);
}
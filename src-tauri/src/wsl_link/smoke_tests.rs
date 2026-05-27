use super::{
    agent_distribution::{
        build_agent_distribution_bundle, install_agent_distribution_bundle,
        resolve_agent_binary_bytes, start_installed_agent, WslLinkAgentDistributionPlan,
    },
    noise_material::{KeyringWslLinkNoiseMaterialStore, WslLinkNoiseMaterialStore},
    primary_supervisor::WslLinkPrimarySupervisor,
    terminal_client::{open_interactive_terminal_over_wsl_link, run_terminal_script_over_wsl_link},
    terminal_exec::{
        WslLinkTerminalOpenInteractiveRequest, WslLinkTerminalRunScriptRequest,
        WslLinkTerminalServerPayload,
    },
    types::now_unix_ms,
};

use std::sync::{Arc, Mutex};
use tokio::time::{sleep, timeout, Duration};

#[tokio::test]
#[ignore = "需要本机 WSL2、Linux agent artifact 和 Windows 凭据容器；仅手动运行。"]
async fn real_wsl_agent_install_start_and_probe_primary() {
    let plan = WslLinkAgentDistributionPlan::user_default();
    let agent_binary = resolve_agent_binary_bytes().expect("需要先构建 Linux agent artifact");
    let bundle = build_agent_distribution_bundle(plan.clone(), agent_binary)
        .expect("agent 分发包应能生成 Noise 配对材料");

    let install = install_agent_distribution_bundle(&bundle, &KeyringWslLinkNoiseMaterialStore)
        .await
        .expect("agent 应能安装到默认 WSL 发行版");
    println!(
        "installed binary={} noise_config={} steps={}",
        install.binary_path,
        install.noise_config_path,
        install.outputs.len()
    );

    let start = start_installed_agent(&plan)
        .await
        .expect("agent 应能在默认 WSL 发行版后台启动");
    println!(
        "started binary={} pid_path={} log_path={} stdout={}",
        start.binary_path,
        start.pid_path,
        start.log_path,
        start.stdout.trim()
    );

    let desktop_material = KeyringWslLinkNoiseMaterialStore
        .load_desktop_material()
        .expect("桌面 Noise 密钥材料应能读取")
        .expect("安装后应保存桌面 Noise 密钥材料");
    let mut supervisor = WslLinkPrimarySupervisor::new(
        "calamex-desktop-smoke",
        super::config::WslLinkTransportConfig::default(),
    );
    let mut connection = supervisor
        .open_noise_connection(&desktop_material)
        .await
        .expect("主通道 Noise + OpenSession 应能连通 WSL agent");
    let heartbeat = supervisor
        .heartbeat(&mut connection)
        .await
        .expect("主通道 Heartbeat 应能连通 WSL agent");

    println!(
        "session id={} transport={:?} server_seq={} ack_client_seq={}",
        connection.session.session_id,
        connection.session.transport,
        heartbeat.server_seq,
        heartbeat.ack_client_seq
    );

    let script_path = format!("/tmp/calamex-wsl-link-smoke-{}.sh", now_unix_ms());
    let mut output = String::new();
    let mut exit_code = None;
    run_terminal_script_over_wsl_link(
        &desktop_material,
        WslLinkTerminalRunScriptRequest {
            run_id: "wsl-link-terminal-smoke".to_string(),
            working_directory: "/tmp".to_string(),
            execution_path: script_path.clone(),
            script_content: Some(
                "printf '__WSL_LINK_TERMINAL_OK__\\n你好\\n'\nexit 7\n".to_string(),
            ),
            cleanup_paths: vec![script_path],
            cols: 120,
            rows: 40,
        },
        |event| match event {
            WslLinkTerminalServerPayload::RunChunk(chunk) => output.push_str(&chunk.data),
            WslLinkTerminalServerPayload::RunCompleted(completed) => {
                exit_code = completed.exit_code;
            }
            WslLinkTerminalServerPayload::RunError(error) => {
                output.push_str(&error.message);
                exit_code = error.exit_code;
            }
            WslLinkTerminalServerPayload::RunStarted(_) => {}
            WslLinkTerminalServerPayload::InteractiveOpened(_)
            | WslLinkTerminalServerPayload::InteractiveData(_)
            | WslLinkTerminalServerPayload::InteractiveClosed(_)
            | WslLinkTerminalServerPayload::InteractiveAck(_)
            | WslLinkTerminalServerPayload::InteractiveError(_) => {}
        },
    )
    .await
    .expect("WSL Link terminal run 应能通过 Duplex 执行脚本");

    println!("terminal output={output:?} exit_code={exit_code:?}");
    assert_eq!(exit_code, Some(7), "{output}");
    assert!(output.contains("__WSL_LINK_TERMINAL_OK__"), "{output}");
    assert!(output.contains("你好"), "{output}");

    let interactive_output = Arc::new(Mutex::new(String::new()));
    let interactive_exit = Arc::new(Mutex::new(None));
    let output_ref = Arc::clone(&interactive_output);
    let exit_ref = Arc::clone(&interactive_exit);
    let interactive = open_interactive_terminal_over_wsl_link(
        &desktop_material,
        WslLinkTerminalOpenInteractiveRequest {
            session_id: "wsl-link-interactive-smoke".to_string(),
            working_directory: "/tmp".to_string(),
            cols: 120,
            rows: 40,
        },
        move |event| match event {
            WslLinkTerminalServerPayload::InteractiveData(chunk) => {
                output_ref
                    .lock()
                    .expect("output lock")
                    .push_str(&chunk.data);
            }
            WslLinkTerminalServerPayload::InteractiveClosed(closed) => {
                *exit_ref.lock().expect("exit lock") = closed.exit_code;
            }
            WslLinkTerminalServerPayload::InteractiveError(error) => {
                output_ref
                    .lock()
                    .expect("output lock")
                    .push_str(&error.message);
                *exit_ref.lock().expect("exit lock") = error.exit_code;
            }
            WslLinkTerminalServerPayload::InteractiveOpened(_)
            | WslLinkTerminalServerPayload::InteractiveAck(_)
            | WslLinkTerminalServerPayload::RunStarted(_)
            | WslLinkTerminalServerPayload::RunChunk(_)
            | WslLinkTerminalServerPayload::RunCompleted(_)
            | WslLinkTerminalServerPayload::RunError(_) => {}
        },
    )
    .await
    .expect("WSL Link interactive terminal 应能打开");
    interactive
    .write_input("printf '**WSL_LINK_INTERACTIVE_OK**\\n你好\\n'\nexit 9\n".to_string())
    .await
    .expect("interactive input 应能发送");

    timeout(Duration::from_secs(8), async {
        loop {
            let output = interactive_output.lock().expect("output lock").clone();
            let exit_code = *interactive_exit.lock().expect("exit lock");
            if output.contains("__WSL_LINK_INTERACTIVE_OK__") && exit_code == Some(9) {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("WSL Link interactive terminal 应返回输出和退出码");

    let output = interactive_output.lock().expect("output lock").clone();
    let exit_code = *interactive_exit.lock().expect("exit lock");
    println!("interactive output={output:?} exit_code={exit_code:?}");
    assert_eq!(exit_code, Some(9), "{output}");
    assert!(output.contains("__WSL_LINK_INTERACTIVE_OK__"), "{output}");
    assert!(output.contains("你好"), "{output}");
}

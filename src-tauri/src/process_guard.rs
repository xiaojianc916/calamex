//! 进程树崩溃兜底回收（Windows Job Object）。
//!
//! 既有退出清理（见 `main.rs` 的 `run_exit_cleanup`）只覆盖优雅退出路径（托盘退出 /
//! 窗口关闭 / `RunEvent::ExitRequested` / `Exit`）。本模块补充一层 OS 级兜底：把当前进程
//! 加入一个带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object。一旦本进程消失——
//! 包括崩溃、被任务管理器强杀等任意非优雅退出——OS 会连带终结其后派生的全部子孙进程
//! （node 边车 / wsl.exe / LSP / ssh 等），杜绝无人照管的孤儿进程。
//!
//! 子进程默认继承父进程的 Job 成员身份，故**无需改动任何子进程派生点**；只需在 `main()`
//! 早期、任何子进程派生之前安装一次即可。本工程所有子进程均为懒派生（首个 AI 请求经
//! `AcpRuntime::get_or_spawn`、开终端时建 PTY 等），因此调用时机足够早。
//!
//! 该兜底与既有优雅清理互补、不冲突：正常退出仍走 `run_exit_cleanup` 做有序收口，本机制
//! 仅在优雅路径未能执行时由 OS 接管。非 Windows 平台为空操作。

/// 安装「随本进程消亡而终结整棵进程树」的 OS 级兜底。
///
/// - Windows：创建 `KILL_ON_JOB_CLOSE` 的 Job Object 并把当前进程加入其中。
/// - 其它平台：空操作。
///
/// 仅应在 `main()` 早期调用一次。任何失败都只记日志并降级（退回既有优雅清理），绝不中断启动。
pub fn install_kill_on_close_job() {
    #[cfg(windows)]
    install_windows_job();
}

#[cfg(windows)]
fn install_windows_job() {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    // SAFETY: 均为标准 Win32 调用。`info` 为本地栈对象且按结构体大小传长度；句柄返回值
    // 逐一校验，失败即关闭并返回，不向外暴露裸句柄；`GetCurrentProcess` 返回伪句柄无需关闭。
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            tracing::warn!("process_guard: CreateJobObjectW 失败，跳过进程树崩溃兜底");
            return;
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let set_ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::addr_of!(info).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if set_ok == 0 {
            tracing::warn!("process_guard: SetInformationJobObject 失败，跳过进程树崩溃兜底");
            let _ = CloseHandle(job);
            return;
        }

        if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            // 良性失败：进程可能已处于一个不允许 breakaway 的 Job 中（某些 CI / 容器 /
            // 调试器场景）。此时退回既有优雅退出清理即可，不影响正常功能。
            tracing::warn!(
                "process_guard: AssignProcessToJobObject 失败（进程可能已属于其它 Job），跳过进程树崩溃兜底"
            );
            let _ = CloseHandle(job);
            return;
        }

        // 成功路径有意不调用 CloseHandle：内核 Job 对象需在本进程整个生命周期内保持至少
        // 一个打开句柄。`job` 仅是句柄值（Copy），变量离开作用域不会关闭内核句柄，故 Job
        // 持续存活，直至进程退出时随进程句柄表一并关闭，触发 KILL_ON_JOB_CLOSE。
        tracing::info!(scope = "startup", event = "process_guard.job-installed");
    }
}

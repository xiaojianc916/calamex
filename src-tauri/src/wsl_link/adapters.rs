use super::{
    manager::WslLinkTransportAdapter,
    types::{WslLinkTransportKind, DEFAULT_VSOCK_GRPC_PORT},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VsockGrpcEndpoint {
    pub port: u32,
}

impl Default for VsockGrpcEndpoint {
    fn default() -> Self {
        Self {
            port: DEFAULT_VSOCK_GRPC_PORT,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VsockGrpcAdapter {
    endpoint: VsockGrpcEndpoint,
    is_platform_available: bool,
}

impl VsockGrpcAdapter {
    pub fn new(endpoint: VsockGrpcEndpoint) -> Self {
        Self {
            endpoint,
            is_platform_available: cfg!(windows) || cfg!(target_os = "linux"),
        }
    }

    pub fn endpoint(&self) -> &VsockGrpcEndpoint {
        &self.endpoint
    }
}

impl WslLinkTransportAdapter for VsockGrpcAdapter {
    fn kind(&self) -> WslLinkTransportKind {
        WslLinkTransportKind::VsockGrpc
    }

    fn is_available(&self) -> bool {
        self.is_platform_available
    }
}

#[cfg(windows)]
pub mod windows_hyperv {
    use std::{
        fmt, io, mem, os::windows::io::FromRawSocket, process::Command, sync::OnceLock,
        time::Duration,
    };

    use thiserror::Error;
    use windows_sys::{
        core::GUID,
        Win32::{
            Networking::WinSock::{
                closesocket, connect, getsockopt, ioctlsocket, select, WSAGetLastError, WSASocketW,
                WSAStartup, AF_HYPERV, FD_SET, FIONBIO, INVALID_SOCKET, SOCKADDR, SOCKET,
                SOCKET_ERROR, SOCK_STREAM, SOL_SOCKET, SO_ERROR, TIMEVAL, WSADATA, WSAEALREADY,
                WSAEINPROGRESS, WSAEISCONN, WSAETIMEDOUT, WSAEWOULDBLOCK, WSA_FLAG_OVERLAPPED,
            },
            System::Hypervisor::{HV_PROTOCOL_RAW, SOCKADDR_HV},
        },
    };

    pub const WSL_LINK_AF_HYPERV: u16 = AF_HYPERV;
    pub const WSL_LINK_HV_PROTOCOL_RAW: u32 = HV_PROTOCOL_RAW;
    pub const WSL_LINK_HV_VSOCK_TEMPLATE_DATA2: u16 = 0xfacb;
    pub const WSL_LINK_HV_VSOCK_TEMPLATE_DATA3: u16 = 0x11e6;
    pub const WSL_LINK_HV_VSOCK_TEMPLATE_DATA4: [u8; 8] =
        [0xbd, 0x58, 0x64, 0x00, 0x6a, 0x79, 0x86, 0xd3];
    pub const WSL_LINK_HV_VSOCK_MAX_LISTEN_PORT: u32 = 0x7fff_ffff;

    #[derive(Debug, Error, PartialEq, Eq)]
    pub enum WslLinkHypervAddressError {
        #[error("WSL Link Hyper-V VM GUID 不能为空。")]
        EmptyVmGuid,
        #[error("WSL Link Hyper-V VM GUID 格式无效：{0}")]
        InvalidVmGuid(String),
        #[error("WSL Link Hyper-V vsock port 超过 Linux guest 可监听范围：{port} > {max}")]
        PortOutOfRange { port: u32, max: u32 },
        #[error("WSL Link 运行 hcsdiag list 失败：{0}")]
        HcsdiagIo(String),
        #[error("WSL Link hcsdiag list 退出失败：{0}")]
        HcsdiagFailed(String),
        #[error("WSL Link 未在 hcsdiag list 输出中找到运行中的 WSL2 VM GUID。")]
        WslVmGuidNotFound,
    }

    #[derive(Debug, Error)]
    pub enum WslLinkHypervConnectError {
        #[error("WSL Link Hyper-V 地址无效：{0}")]
        Address(#[from] WslLinkHypervAddressError),
        #[error("WSL Link WinSock 初始化失败：{0}")]
        Startup(i32),
        #[error("WSL Link 创建 AF_HYPERV socket 失败：{0}")]
        CreateSocket(i32),
        #[error("WSL Link 设置 AF_HYPERV socket 非阻塞失败：{0}")]
        SetNonBlocking(i32),
        #[error("WSL Link AF_HYPERV connect 失败：{0}")]
        Connect(i32),
        #[error("WSL Link AF_HYPERV connect 超时：{0:?}")]
        ConnectTimeout(Duration),
        #[error("WSL Link AF_HYPERV select 失败：{0}")]
        Select(i32),
        #[error("WSL Link AF_HYPERV getsockopt(SO_ERROR) 失败：{0}")]
        SocketOption(i32),
        #[error("WSL Link AF_HYPERV socket 转 Tokio stream 失败：{0}")]
        TokioStream(#[from] io::Error),
    }

    #[derive(Clone, Copy)]
    pub struct WslVmGuid(GUID);

    impl WslVmGuid {
        pub fn parse(value: &str) -> Result<Self, WslLinkHypervAddressError> {
            parse_guid(value).map(Self)
        }

        pub fn as_guid(&self) -> GUID {
            self.0
        }
    }

    impl fmt::Debug for WslVmGuid {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_tuple("WslVmGuid")
                .field(&format_guid(&self.0))
                .finish()
        }
    }

    #[derive(Clone, Copy)]
    pub struct WslHypervSocketAddress {
        vm_id: WslVmGuid,
        service_id: GUID,
        port: u32,
    }

    impl fmt::Debug for WslHypervSocketAddress {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("WslHypervSocketAddress")
                .field("vm_id", &format_guid(&self.vm_id.as_guid()))
                .field("service_id", &format_guid(&self.service_id))
                .field("port", &self.port)
                .finish()
        }
    }

    impl WslHypervSocketAddress {
        pub fn new(vm_id: WslVmGuid, port: u32) -> Result<Self, WslLinkHypervAddressError> {
            Ok(Self {
                vm_id,
                service_id: service_guid_for_vsock_port(port)?,
                port,
            })
        }

        pub fn port(&self) -> u32 {
            self.port
        }

        pub fn vm_id(&self) -> GUID {
            self.vm_id.as_guid()
        }

        pub fn service_id(&self) -> GUID {
            self.service_id
        }

        pub fn sockaddr(&self) -> SOCKADDR_HV {
            SOCKADDR_HV {
                Family: WSL_LINK_AF_HYPERV,
                Reserved: 0,
                VmId: self.vm_id.as_guid(),
                ServiceId: self.service_id,
            }
        }

        pub fn sockaddr_len(&self) -> i32 {
            mem::size_of::<SOCKADDR_HV>() as i32
        }
    }

    pub async fn connect_wsl_vsock_grpc_stream(
        port: u32,
        timeout: Duration,
    ) -> Result<tokio::net::TcpStream, WslLinkHypervConnectError> {
        let vm_id = resolve_running_wsl_vm_guid_with_hcsdiag()?;
        let address = WslHypervSocketAddress::new(vm_id, port)?;
        connect_hyperv_stream(address, timeout).await
    }

    pub async fn connect_hyperv_stream(
        address: WslHypervSocketAddress,
        timeout: Duration,
    ) -> Result<tokio::net::TcpStream, WslLinkHypervConnectError> {
        tokio::task::spawn_blocking(move || connect_hyperv_stream_blocking(address, timeout))
            .await
            .map_err(|error| WslLinkHypervConnectError::TokioStream(io::Error::other(error)))?
    }

    pub fn service_guid_for_vsock_port(port: u32) -> Result<GUID, WslLinkHypervAddressError> {
        if port > WSL_LINK_HV_VSOCK_MAX_LISTEN_PORT {
            return Err(WslLinkHypervAddressError::PortOutOfRange {
                port,
                max: WSL_LINK_HV_VSOCK_MAX_LISTEN_PORT,
            });
        }

        Ok(GUID {
            data1: port,
            data2: WSL_LINK_HV_VSOCK_TEMPLATE_DATA2,
            data3: WSL_LINK_HV_VSOCK_TEMPLATE_DATA3,
            data4: WSL_LINK_HV_VSOCK_TEMPLATE_DATA4,
        })
    }

    pub fn resolve_running_wsl_vm_guid_with_hcsdiag() -> Result<WslVmGuid, WslLinkHypervAddressError>
    {
        let output = Command::new("hcsdiag.exe")
            .arg("list")
            .output()
            .map_err(|error| WslLinkHypervAddressError::HcsdiagIo(error.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(WslLinkHypervAddressError::HcsdiagFailed(stderr));
        }

        parse_hcsdiag_list_wsl_vm_guid(&String::from_utf8_lossy(&output.stdout))
            .ok_or(WslLinkHypervAddressError::WslVmGuidNotFound)
    }

    pub fn parse_hcsdiag_list_wsl_vm_guid(output: &str) -> Option<WslVmGuid> {
        output
            .lines()
            .filter(|line| {
                let lower = line.to_ascii_lowercase();
                lower.contains("wsl") && lower.contains("running")
            })
            .find_map(extract_first_guid)
    }

    fn parse_guid(value: &str) -> Result<GUID, WslLinkHypervAddressError> {
        let normalized = value
            .trim()
            .trim_start_matches('{')
            .trim_end_matches('}')
            .to_ascii_lowercase();
        if normalized.is_empty() {
            return Err(WslLinkHypervAddressError::EmptyVmGuid);
        }

        let parts = normalized.split('-').collect::<Vec<_>>();
        if parts.len() != 5
            || parts[0].len() != 8
            || parts[1].len() != 4
            || parts[2].len() != 4
            || parts[3].len() != 4
            || parts[4].len() != 12
        {
            return Err(WslLinkHypervAddressError::InvalidVmGuid(value.to_string()));
        }

        let data1 = parse_hex_u32(parts[0], value)?;
        let data2 = parse_hex_u16(parts[1], value)?;
        let data3 = parse_hex_u16(parts[2], value)?;
        let data4_prefix = parse_hex_u16(parts[3], value)?.to_be_bytes();
        let data4_tail = parse_hex_u64_48(parts[4], value)?.to_be_bytes();

        Ok(GUID {
            data1,
            data2,
            data3,
            data4: [
                data4_prefix[0],
                data4_prefix[1],
                data4_tail[2],
                data4_tail[3],
                data4_tail[4],
                data4_tail[5],
                data4_tail[6],
                data4_tail[7],
            ],
        })
    }

    fn parse_hex_u16(value: &str, original: &str) -> Result<u16, WslLinkHypervAddressError> {
        u16::from_str_radix(value, 16)
            .map_err(|_| WslLinkHypervAddressError::InvalidVmGuid(original.to_string()))
    }

    fn parse_hex_u32(value: &str, original: &str) -> Result<u32, WslLinkHypervAddressError> {
        u32::from_str_radix(value, 16)
            .map_err(|_| WslLinkHypervAddressError::InvalidVmGuid(original.to_string()))
    }

    fn parse_hex_u64_48(value: &str, original: &str) -> Result<u64, WslLinkHypervAddressError> {
        u64::from_str_radix(value, 16)
            .map_err(|_| WslLinkHypervAddressError::InvalidVmGuid(original.to_string()))
    }

    fn extract_first_guid(line: &str) -> Option<WslVmGuid> {
        line.split(|item: char| item.is_whitespace() || item == ',')
            .map(|item| item.trim_matches(|ch| ch == '{' || ch == '}' || ch == '"' || ch == '\''))
            .find_map(|item| WslVmGuid::parse(item).ok())
    }

    fn format_guid(guid: &GUID) -> String {
        format!(
            "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            guid.data1,
            guid.data2,
            guid.data3,
            guid.data4[0],
            guid.data4[1],
            guid.data4[2],
            guid.data4[3],
            guid.data4[4],
            guid.data4[5],
            guid.data4[6],
            guid.data4[7]
        )
    }

    fn connect_hyperv_stream_blocking(
        address: WslHypervSocketAddress,
        timeout: Duration,
    ) -> Result<tokio::net::TcpStream, WslLinkHypervConnectError> {
        ensure_winsock_started()?;
        let socket = create_overlapped_hyperv_socket()?;
        set_socket_nonblocking(socket.as_socket())?;
        connect_socket_with_timeout(socket.as_socket(), &address, timeout)?;

        let raw_socket = socket.into_raw_socket();
        let std_stream = unsafe { std::net::TcpStream::from_raw_socket(raw_socket as _) };
        std_stream.set_nonblocking(true)?;
        tokio::net::TcpStream::from_std(std_stream).map_err(Into::into)
    }

    fn ensure_winsock_started() -> Result<(), WslLinkHypervConnectError> {
        static WSA_STARTUP_RESULT: OnceLock<i32> = OnceLock::new();
        let result = *WSA_STARTUP_RESULT.get_or_init(|| {
            let mut data = WSADATA::default();
            unsafe { WSAStartup(0x0202, &mut data) }
        });

        if result == 0 {
            Ok(())
        } else {
            Err(WslLinkHypervConnectError::Startup(result))
        }
    }

    fn create_overlapped_hyperv_socket() -> Result<OwnedWinsockSocket, WslLinkHypervConnectError> {
        let socket = unsafe {
            WSASocketW(
                i32::from(WSL_LINK_AF_HYPERV),
                SOCK_STREAM,
                WSL_LINK_HV_PROTOCOL_RAW as i32,
                std::ptr::null(),
                0,
                WSA_FLAG_OVERLAPPED,
            )
        };

        if socket == INVALID_SOCKET {
            return Err(WslLinkHypervConnectError::CreateSocket(last_wsa_error()));
        }

        Ok(OwnedWinsockSocket { socket })
    }

    fn set_socket_nonblocking(socket: SOCKET) -> Result<(), WslLinkHypervConnectError> {
        let mut enabled = 1_u32;
        let result = unsafe { ioctlsocket(socket, FIONBIO, &mut enabled) };
        if result == SOCKET_ERROR {
            return Err(WslLinkHypervConnectError::SetNonBlocking(last_wsa_error()));
        }
        Ok(())
    }

    fn connect_socket_with_timeout(
        socket: SOCKET,
        address: &WslHypervSocketAddress,
        timeout: Duration,
    ) -> Result<(), WslLinkHypervConnectError> {
        let sockaddr = address.sockaddr();
        let result = unsafe {
            connect(
                socket,
                (&sockaddr as *const SOCKADDR_HV).cast::<SOCKADDR>(),
                address.sockaddr_len(),
            )
        };
        if result == 0 {
            return Ok(());
        }

        let error = last_wsa_error();
        if !is_pending_connect_error(error) {
            return Err(WslLinkHypervConnectError::Connect(error));
        }

        wait_socket_connected(socket, timeout)
    }

    fn wait_socket_connected(
        socket: SOCKET,
        timeout: Duration,
    ) -> Result<(), WslLinkHypervConnectError> {
        let mut writefds = fd_set_with_socket(socket);
        let mut exceptfds = fd_set_with_socket(socket);
        let timeval = duration_to_timeval(timeout);
        let result = unsafe {
            select(
                0,
                std::ptr::null_mut(),
                &mut writefds,
                &mut exceptfds,
                &timeval,
            )
        };

        if result == 0 {
            return Err(WslLinkHypervConnectError::ConnectTimeout(timeout));
        }
        if result == SOCKET_ERROR {
            return Err(WslLinkHypervConnectError::Select(last_wsa_error()));
        }

        let socket_error = socket_error(socket)?;
        if socket_error == 0 || socket_error == WSAEISCONN {
            Ok(())
        } else if socket_error == WSAETIMEDOUT {
            Err(WslLinkHypervConnectError::ConnectTimeout(timeout))
        } else {
            Err(WslLinkHypervConnectError::Connect(socket_error))
        }
    }

    fn socket_error(socket: SOCKET) -> Result<i32, WslLinkHypervConnectError> {
        let mut value = 0_i32;
        let mut len = mem::size_of::<i32>() as i32;
        let result = unsafe {
            getsockopt(
                socket,
                SOL_SOCKET,
                SO_ERROR,
                (&mut value as *mut i32).cast::<u8>(),
                &mut len,
            )
        };
        if result == SOCKET_ERROR {
            return Err(WslLinkHypervConnectError::SocketOption(last_wsa_error()));
        }
        Ok(value)
    }

    fn is_pending_connect_error(error: i32) -> bool {
        matches!(error, WSAEWOULDBLOCK | WSAEINPROGRESS | WSAEALREADY)
    }

    fn fd_set_with_socket(socket: SOCKET) -> FD_SET {
        let mut set = FD_SET::default();
        set.fd_count = 1;
        set.fd_array[0] = socket;
        set
    }

    fn duration_to_timeval(duration: Duration) -> TIMEVAL {
        let seconds = duration.as_secs().min(i32::MAX as u64);
        TIMEVAL {
            tv_sec: seconds as i32,
            tv_usec: duration.subsec_micros() as i32,
        }
    }

    fn last_wsa_error() -> i32 {
        unsafe { WSAGetLastError() }
    }

    struct OwnedWinsockSocket {
        socket: SOCKET,
    }

    impl OwnedWinsockSocket {
        fn as_socket(&self) -> SOCKET {
            self.socket
        }

        fn into_raw_socket(self) -> SOCKET {
            let socket = self.socket;
            mem::forget(self);
            socket
        }
    }

    impl Drop for OwnedWinsockSocket {
        fn drop(&mut self) {
            unsafe {
                let _ = closesocket(self.socket);
            }
        }
    }
}

#[cfg(target_os = "linux")]
pub mod linux_vsock {
    pub use tokio_vsock::{VsockListener, VsockStream, VMADDR_CID_ANY, VMADDR_CID_HOST};
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wsl_link::manager::WslLinkTransportAdapter;

    #[test]
    fn vsock_grpc_adapter_uses_reserved_port() {
        let adapter = VsockGrpcAdapter::new(VsockGrpcEndpoint::default());

        assert_eq!(adapter.kind(), WslLinkTransportKind::VsockGrpc);
        assert_eq!(adapter.endpoint().port, DEFAULT_VSOCK_GRPC_PORT);
    }

    #[cfg(windows)]
    #[test]
    fn windows_service_guid_maps_vsock_port_to_hyperv_template() {
        let guid = windows_hyperv::service_guid_for_vsock_port(DEFAULT_VSOCK_GRPC_PORT)
            .expect("default port should map");

        assert_eq!(guid.data1, DEFAULT_VSOCK_GRPC_PORT);
        assert_eq!(guid.data2, windows_hyperv::WSL_LINK_HV_VSOCK_TEMPLATE_DATA2);
        assert_eq!(guid.data3, windows_hyperv::WSL_LINK_HV_VSOCK_TEMPLATE_DATA3);
        assert_eq!(guid.data4, windows_hyperv::WSL_LINK_HV_VSOCK_TEMPLATE_DATA4);
    }

    #[cfg(windows)]
    #[test]
    fn windows_service_guid_rejects_linux_guest_invalid_listen_port() {
        let result = windows_hyperv::service_guid_for_vsock_port(0x8000_0000);

        assert!(matches!(
            result,
            Err(windows_hyperv::WslLinkHypervAddressError::PortOutOfRange { .. })
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_hyperv_socket_address_uses_vm_guid_and_service_guid() {
        let vm_id = windows_hyperv::WslVmGuid::parse("{90db8b89-0d35-4f79-8ce9-49ea0ac8b7cd}")
            .expect("VM GUID should parse");
        let address = windows_hyperv::WslHypervSocketAddress::new(vm_id, DEFAULT_VSOCK_GRPC_PORT)
            .expect("address should build");
        let sockaddr = address.sockaddr();

        assert_eq!(address.port(), DEFAULT_VSOCK_GRPC_PORT);
        assert_eq!(address.service_id().data1, DEFAULT_VSOCK_GRPC_PORT);
        assert_eq!(address.vm_id().data1, 0x90db8b89);
        assert_eq!(sockaddr.Family, windows_hyperv::WSL_LINK_AF_HYPERV);
        assert_eq!(sockaddr.ServiceId.data1, DEFAULT_VSOCK_GRPC_PORT);
        assert!(address.sockaddr_len() > 0);
    }

    #[cfg(windows)]
    #[test]
    fn windows_hyperv_vm_guid_parser_rejects_invalid_text() {
        let result = windows_hyperv::WslVmGuid::parse("not-a-guid");

        assert!(matches!(
            result,
            Err(windows_hyperv::WslLinkHypervAddressError::InvalidVmGuid(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_hyperv_hcsdiag_parser_extracts_running_wsl_vm_guid() {
        let output = r#"
            VM, Running, AFD7952D-E55B-5EAD-A889-FC7922C6458D, WSL
            VM, Stopped, 11111111-2222-3333-4444-555555555555, Other
        "#;

        let vm_id = windows_hyperv::parse_hcsdiag_list_wsl_vm_guid(output)
            .expect("running WSL VM GUID should parse");

        assert_eq!(vm_id.as_guid().data1, 0xafd7952d);
    }

    #[cfg(windows)]
    #[test]
    fn windows_hyperv_hcsdiag_parser_ignores_non_wsl_vms() {
        let output = "VM, Running, 11111111-2222-3333-4444-555555555555, Docker";

        assert!(windows_hyperv::parse_hcsdiag_list_wsl_vm_guid(output).is_none());
    }
}

fn main() {
    // WSL Link 已移除，构建脚本不再需要 protoc / gRPC proto 代码生成。
    #[cfg(feature = "desktop")]
    {
        tauri_build::build();
    }
}

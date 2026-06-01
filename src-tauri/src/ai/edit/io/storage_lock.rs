use crate::ai::edit::errors;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::Path;

const LOCK_FILE_NAME: &str = "journal.lock";

pub fn with_storage_write_lock<T>(
    storage_root: &Path,
    action: &str,
    run: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let file = open_storage_lock(storage_root)?;
    file.try_lock().map_err(|error| match error {
        TryLockError::WouldBlock => errors::storage_locked(format!(
            "同一项目的另一个 Aster 进程正在写入 AED 存储，当前操作已拒绝（{action}）。"
        )),
        TryLockError::Error(error) => {
            errors::storage_locked(format!("获取 AED journal.lock 写锁失败：{error}"))
        }
    })?;
    let _guard = StorageLockGuard::new(file);

    run()
}

pub fn with_storage_read_lock<T>(
    storage_root: &Path,
    action: &str,
    run: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let file = open_storage_lock(storage_root)?;
    file.try_lock_shared().map_err(|error| match error {
        TryLockError::WouldBlock => errors::storage_locked(format!(
            "同一项目的另一个 Aster 进程正在写入 AED 存储，当前只读操作已拒绝（{action}）。"
        )),
        TryLockError::Error(error) => {
            errors::storage_locked(format!("获取 AED journal.lock 读锁失败：{error}"))
        }
    })?;
    let _guard = StorageLockGuard::new(file);

    run()
}

fn open_storage_lock(storage_root: &Path) -> Result<File, String> {
    fs::create_dir_all(storage_root).map_err(|error| {
        errors::storage_path_unavailable(format!("创建 AED 存储目录失败：{error}").as_str())
    })?;

    let lock_path = storage_root.join(LOCK_FILE_NAME);
    open_lock_file(&lock_path)
}

fn open_lock_file(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|error| {
            errors::storage_locked(format!(
                "打开 AED journal.lock 失败（{}）：{error}",
                path.display()
            ))
        })
}

struct StorageLockGuard {
    file: File,
}

impl StorageLockGuard {
    fn new(file: File) -> Self {
        Self { file }
    }
}

impl Drop for StorageLockGuard {
    fn drop(&mut self) {
        if let Err(error) = self.file.unlock() {
            tracing::warn!(
                target: "ai.edit",
                error = %error,
                "failed to unlock AED journal.lock"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{open_lock_file, with_storage_write_lock};
    use std::fs::{self, TryLockError};

    #[test]
    fn write_lock_rejects_second_holder() {
        let temp_dir = temp_dir("aed-storage-lock");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        let lock_path = temp_dir.join("journal.lock");

        let first_file = open_lock_file(&lock_path).expect("first lock file should open");
        let second_file = open_lock_file(&lock_path).expect("second lock file should open");

        first_file
            .try_lock()
            .expect("first lock should be acquired");
        let error = second_file
            .try_lock()
            .expect_err("second lock should be rejected");

        assert!(matches!(error, TryLockError::WouldBlock));
        first_file.unlock().expect("first lock should unlock");
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn with_storage_write_lock_runs_while_lock_is_available() {
        let temp_dir = temp_dir("aed-storage-lock-run");
        let value = with_storage_write_lock(&temp_dir, "测试操作", || Ok::<i32, String>(42))
            .expect("lock should allow operation");

        assert_eq!(value, 42);
        assert!(temp_dir.join("journal.lock").exists());
        let _ = fs::remove_dir_all(&temp_dir);
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ))
    }
}

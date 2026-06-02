use std::fmt;
use std::ops::Deref;

use serde::{Deserialize, Serialize};
use specta::Type;

// ============================================================================
// Secret newtype
// ----------------------------------------------------------------------------
// 用于在结构体中包裹敏感字符串（如 API Key），保证：
// - 在 JSON 上仍序列化/反序列化为普通字符串（serde transparent）；
// - {:?} / Debug 输出永远是 "***"，不会随 tracing/println 泄露；
// - 通过 Deref<Target = str> 与 AsRef<str>，调用方对原 `String` 字段的绝大多数
//   只读用法（如 `&req.api_key` 当作 `&str`、`req.api_key.is_empty()`、
//   `req.api_key.len()`、`req.api_key.to_string()`）保持源码级兼容。
// - 析构时清零内部明文（best-effort），缩短密钥在内存中的留存时间。
// ============================================================================
#[derive(Clone, Default, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct SecretString(String);

impl SecretString {
    /// 显式取出明文，命名上提醒调用点这是一次"暴露密钥"的动作，便于审计。
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// 消费 `SecretString` 取回内部 `String`。
    ///
    /// 由于实现了 `Drop`，不能直接移出 `self.0`，改用 `mem::take` 取走内容
    /// （留下的空串会在随后的析构里被清零，无副作用）。
    pub fn into_inner(mut self) -> String {
        std::mem::take(&mut self.0)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// 析构时尽力清零明文字节，避免密钥在释放后仍残留于堆内存。
impl Drop for SecretString {
    fn drop(&mut self) {
        unsafe {
            for b in self.0.as_bytes_mut() {
                *b = 0;
            }
        }
        self.0.clear();
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString(***)")
    }
}

impl fmt::Display for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

impl Deref for SecretString {
    type Target = str;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl AsRef<str> for SecretString {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for SecretString {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl From<SecretString> for String {
    fn from(mut value: SecretString) -> Self {
        std::mem::take(&mut value.0)
    }
}

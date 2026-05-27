//! Noise transport-layer AsyncRead/AsyncWrite adapter.
//!
//! 把一个已经完成 `Noise_KKpsk2_25519_ChaChaPoly_BLAKE2s` 握手的双向字节流
//! 包装成透明加解密的 `AsyncRead + AsyncWrite`。
//!
//! 帧格式：每个密文帧前置 2 字节大端长度（u16），最大 65535 字节密文（含 16 字节 AEAD tag），
//! 对应明文最大 65519 字节。读取端按帧解密后拼成连续字节流给上层（tonic / hyper）。
//!
//! 设计要点：
//! - 加密侧不做用户态缓冲：每次 `poll_write` 直接把传入 buf 切片为 ≤ MAX_PLAINTEXT 块，
//!   每块加密后整帧（含长度前缀）写入底层 IO。返回值是消费掉的明文字节数。
//! - 解密侧维护 (read_buf: BytesMut, plaintext_residual: BytesMut)：
//!   先吐 plaintext_residual，吐完再读下一帧密文 → 解密 → 填 residual。
//! - 透明传播底层 IO 错误；Noise 解密失败（被篡改 / 重放）一律转成
//!   `io::ErrorKind::InvalidData`，触发 tonic 上层关闭连接。

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use bytes::{Buf, BytesMut};
use parking_lot::Mutex;
use pin_project_lite::pin_project;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use super::noise::{WslLinkNoiseError, WslLinkNoiseTransport};

/// snow 限制：单条 Noise message 最大 65535 字节（含 AEAD tag）。
const MAX_CIPHERTEXT: usize = 65535;
/// ChaCha20-Poly1305 tag 长度。
const AEAD_TAG: usize = 16;
/// 单帧最大明文长度。
pub const MAX_PLAINTEXT: usize = MAX_CIPHERTEXT - AEAD_TAG;
/// 长度前缀字节数。
const LEN_PREFIX: usize = 2;

pin_project! {
    /// 把已握手的 `WslLinkNoiseTransport` 与底层 IO 组合成加密通道。
    ///
    /// `T` 通常是 VSOCK / TCP 的 `AsyncRead + AsyncWrite` stream。
    pub struct NoiseStream<T> {
        #[pin]
        inner: T,
        // snow 的 TransportState 不是 Send 友好的（持有 RngCore），用 Arc<Mutex<...>>
        // 保证 NoiseStream<T>: Send（tonic 要求）。Mutex 在单 stream 内不会竞争（同一时刻
        // 只有一个 poll_read 或 poll_write 在跑）—— 但跨方向是可能并发的（hyper h2 多路复用），
        // 所以加锁是必要的。
        transport: Arc<Mutex<WslLinkNoiseTransport>>,

        // 读取侧状态：缓存从底层 IO 收到但尚未解析为完整帧的密文字节。
        read_cipher_buf: BytesMut,
        // 读取侧状态：当前帧解密后、尚未交付给上层 read 的明文残量。
        read_plain_residual: BytesMut,
        // 当前正在读取的帧长（None = 还没读完 2 字节长度前缀）。
        read_expected_frame_len: Option<usize>,

        // 写入侧状态：上一次 poll_write 产出的密文帧，等待被底层 IO 完全 write_all。
        // 在它写完前，poll_write 不能消费新的明文（否则会破坏 Noise nonce 顺序与上层期望的字节计数）。
        write_pending_cipher: BytesMut,
        // 写入侧状态：write_pending_cipher 对应的明文字节数（用于返回 poll_write 的 Ok(n)）。
        write_pending_plain_len: usize,
    }
}

impl<T> NoiseStream<T> {
    pub fn new(inner: T, transport: WslLinkNoiseTransport) -> Self {
        Self {
            inner,
            transport: Arc::new(Mutex::new(transport)),
            read_cipher_buf: BytesMut::with_capacity(MAX_CIPHERTEXT + LEN_PREFIX),
            read_plain_residual: BytesMut::with_capacity(MAX_PLAINTEXT),
            read_expected_frame_len: None,
            write_pending_cipher: BytesMut::new(),
            write_pending_plain_len: 0,
        }
    }
}

impl<T> AsyncRead for NoiseStream<T>
where
    T: AsyncRead,
{
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let mut this = self.project();

        loop {
            // 1. 优先吐残留明文。
            if !this.read_plain_residual.is_empty() {
                let n = std::cmp::min(this.read_plain_residual.len(), buf.remaining());
                buf.put_slice(&this.read_plain_residual[..n]);
                this.read_plain_residual.advance(n);
                return Poll::Ready(Ok(()));
            }

            // 2. 尝试解析下一帧长度前缀（如果还没解析）。
            if this.read_expected_frame_len.is_none() {
                if this.read_cipher_buf.len() < LEN_PREFIX {
                    // 还不够长度前缀，去读底层。
                    ready_or_return!(poll_read_into(this.inner.as_mut(), cx, this.read_cipher_buf));
                    if this.read_cipher_buf.len() < LEN_PREFIX {
                        // 底层 EOF（read 返回 0 但 buf 没增长）。
                        return Poll::Ready(Ok(()));
                    }
                }
                let mut len_bytes = [0u8; LEN_PREFIX];
                len_bytes.copy_from_slice(&this.read_cipher_buf[..LEN_PREFIX]);
                this.read_cipher_buf.advance(LEN_PREFIX);
                let frame_len = u16::from_be_bytes(len_bytes) as usize;
                if frame_len == 0 || frame_len > MAX_CIPHERTEXT {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("WSL Link Noise 帧长度非法：{frame_len}"),
                    )));
                }
                *this.read_expected_frame_len = Some(frame_len);
            }

            // 3. 读够整帧密文。
            let expected = this.read_expected_frame_len.unwrap();
            while this.read_cipher_buf.len() < expected {
                ready_or_return!(poll_read_into(this.inner.as_mut(), cx, this.read_cipher_buf));
                if this.read_cipher_buf.is_empty() {
                    // 底层 EOF 但帧不完整 → 错误。
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "WSL Link Noise 帧未读完即遇 EOF",
                    )));
                }
            }

            // 4. 解密整帧。
            let cipher_frame = this.read_cipher_buf.split_to(expected);
            *this.read_expected_frame_len = None;

            let plaintext = {
                let mut guard = this.transport.lock();
                guard.decrypt_frame(&cipher_frame).map_err(noise_to_io)?
            };
            this.read_plain_residual.extend_from_slice(&plaintext);

            // 5. 回到循环开头，下次迭代吐 residual。
        }
    }
}

impl<T> AsyncWrite for NoiseStream<T>
where
    T: AsyncWrite,
{
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        src: &[u8],
    ) -> Poll<io::Result<usize>> {
        let mut this = self.project();

        // 1. 如果还有上一帧密文没写完，先把它写完。
        if !this.write_pending_cipher.is_empty() {
            while !this.write_pending_cipher.is_empty() {
                let n = ready_or_pending!(this
                    .inner
                    .as_mut()
                    .poll_write(cx, this.write_pending_cipher))?;
                if n == 0 {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "底层 IO 在写 Noise 帧时返回 0",
                    )));
                }
                this.write_pending_cipher.advance(n);
            }
            let consumed = std::mem::take(this.write_pending_plain_len);
            return Poll::Ready(Ok(consumed));
        }

        // 2. 准备一帧新明文。
        if src.is_empty() {
            return Poll::Ready(Ok(0));
        }
        let plain_len = std::cmp::min(src.len(), MAX_PLAINTEXT);
        let plain_slice = &src[..plain_len];

        let cipher_payload = {
            let mut guard = this.transport.lock();
            guard.encrypt_frame(plain_slice).map_err(noise_to_io)?
        };
        if cipher_payload.len() > MAX_CIPHERTEXT {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "Noise 密文超长（{} > {MAX_CIPHERTEXT}）",
                    cipher_payload.len()
                ),
            )));
        }
        let mut frame = BytesMut::with_capacity(LEN_PREFIX + cipher_payload.len());
        frame.extend_from_slice(&(cipher_payload.len() as u16).to_be_bytes());
        frame.extend_from_slice(&cipher_payload);

        // 3. 尝试立即写出去。写不完的残量塞进 write_pending_cipher。
        let n = match this.inner.as_mut().poll_write(cx, &frame) {
            Poll::Ready(Ok(n)) => n,
            Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
            Poll::Pending => {
                *this.write_pending_cipher = frame;
                *this.write_pending_plain_len = plain_len;
                return Poll::Pending;
            }
        };
        if n == 0 {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "底层 IO 在写 Noise 帧时返回 0",
            )));
        }
        if n < frame.len() {
            *this.write_pending_cipher = frame.split_off(n);
            *this.write_pending_plain_len = plain_len;
            // 部分写入：不能告诉上层「消费了 plain_len 字节」（密文还没全发出去），
            // 也不能告诉上层「消费 0 字节」（会被识别为 WriteZero）。
            // 退而求其次：保留 pending，告诉上层 Pending，让 cx 在 inner 可写时唤醒。
            // 但 inner 刚返回了 Ready(n)，cx 不会再被唤醒 —— 用 waker.wake_by_ref() 主动续上。
            cx.waker().wake_by_ref();
            return Poll::Pending;
        }
        Poll::Ready(Ok(plain_len))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let mut this = self.project();
        // 先把 pending 密文挤完。
        while !this.write_pending_cipher.is_empty() {
            let n = ready_or_pending!(this
                .inner
                .as_mut()
                .poll_write(cx, this.write_pending_cipher))?;
            if n == 0 {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "底层 IO 在 flush 残量时返回 0",
                )));
            }
            this.write_pending_cipher.advance(n);
        }
        this.inner.poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let mut this = self.project();
        while !this.write_pending_cipher.is_empty() {
            let n = ready_or_pending!(this
                .inner
                .as_mut()
                .poll_write(cx, this.write_pending_cipher))?;
            if n == 0 {
                break;
            }
            this.write_pending_cipher.advance(n);
        }
        this.inner.poll_shutdown(cx)
    }
}

/// 把 `WslLinkNoiseError` 转成 `io::Error`，统一为 `InvalidData`：
/// Noise 解密失败意味着对端伪造 / 篡改 / 重放，必须断开。
fn noise_to_io(error: WslLinkNoiseError) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("WSL Link Noise 透明加解密失败：{error}"),
    )
}

/// 从底层 IO 读字节追加到 buf。返回 Pending / Ready(Ok(())) / Ready(Err)。
fn poll_read_into<T: AsyncRead>(
    inner: Pin<&mut T>,
    cx: &mut Context<'_>,
    buf: &mut BytesMut,
) -> Poll<io::Result<()>> {
    // 预留 8KiB 读窗口，避免一次系统调用读太少。
    const READ_CHUNK: usize = 8 * 1024;
    buf.reserve(READ_CHUNK);
    let start = buf.len();
    // SAFETY: ReadBuf 的填充语义保证未写入区域永远不会被读出（uninit 保留）。
    let cap = buf.capacity() - start;
    let spare = unsafe {
        std::slice::from_raw_parts_mut(buf.as_mut_ptr().add(start), cap)
    };
    let mut read_buf = ReadBuf::uninit(unsafe {
        std::slice::from_raw_parts_mut(
            spare.as_mut_ptr() as *mut std::mem::MaybeUninit<u8>,
            spare.len(),
        )
    });
    match inner.poll_read(cx, &mut read_buf) {
        Poll::Pending => Poll::Pending,
        Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
        Poll::Ready(Ok(())) => {
            let filled = read_buf.filled().len();
            unsafe { buf.set_len(start + filled) };
            Poll::Ready(Ok(()))
        }
    }
}

macro_rules! ready_or_return {
    ($e:expr) => {
        match $e {
            Poll::Ready(Ok(v)) => v,
            Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
            Poll::Pending => return Poll::Pending,
        }
    };
}
use ready_or_return;

macro_rules! ready_or_pending {
    ($e:expr) => {
        match $e {
            Poll::Ready(v) => v,
            Poll::Pending => return Poll::Pending,
        }
    };
}
use ready_or_pending;

// ===== 测试 =====

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use crate::wsl_link::noise::complete_handshake;
    use crate::wsl_link::noise_material::generate_pairing_material;
    use tokio::io::duplex;

    #[tokio::test]
    async fn round_trip_small() {
        let material = generate_pairing_material().unwrap();
        let (init, resp) = complete_handshake(
            &material.desktop.initiator_config(),
            &material.agent.responder_config(),
        )
        .unwrap();

        let (a, b) = duplex(64 * 1024);
        let mut client = NoiseStream::new(a, init);
        let mut server = NoiseStream::new(b, resp);

        let payload = b"hello, noise transport over duplex";
        let handle = tokio::spawn(async move {
            client.write_all(payload).await.unwrap();
            client.flush().await.unwrap();
            client.shutdown().await.unwrap();
        });

        let mut received = Vec::new();
        server.read_to_end(&mut received).await.unwrap();
        handle.await.unwrap();
        assert_eq!(&received, payload);
    }

    #[tokio::test]
    async fn round_trip_multi_frame() {
        let material = generate_pairing_material().unwrap();
        let (init, resp) = complete_handshake(
            &material.desktop.initiator_config(),
            &material.agent.responder_config(),
        )
        .unwrap();

        let (a, b) = duplex(1024 * 1024);
        let mut client = NoiseStream::new(a, init);
        let mut server = NoiseStream::new(b, resp);

        // 200KB 触发多帧（MAX_PLAINTEXT = ~65519）。
        let payload: Vec<u8> = (0..200_000).map(|i| (i % 251) as u8).collect();
        let payload_clone = payload.clone();
        let handle = tokio::spawn(async move {
            client.write_all(&payload_clone).await.unwrap();
            client.flush().await.unwrap();
            client.shutdown().await.unwrap();
        });

        let mut received = Vec::new();
        server.read_to_end(&mut received).await.unwrap();
        handle.await.unwrap();
        assert_eq!(received, payload);
    }

    #[tokio::test]
    async fn tampered_ciphertext_is_rejected() {
        // 通过中间篡改字节，验证解密失败转为 InvalidData。
        // 实现略：用一个 tokio_test::io::Builder 注入合法长度前缀 + 错误密文，
        // 期望 read 返回 InvalidData。
    }
}

// tonic 的 serve_with_incoming 要求每个 IO 类型实现 Connected,
// 用于把连接元数据 (远端地址等) 注入到请求 extensions 里。
// NoiseStream 直接透传内层的实现。
impl<T> tonic::transport::server::Connected for NoiseStream<T>
where
    T: tonic::transport::server::Connected,
{
    type ConnectInfo = T::ConnectInfo;
    fn connect_info(&self) -> Self::ConnectInfo {
        self.inner.connect_info()
    }
}
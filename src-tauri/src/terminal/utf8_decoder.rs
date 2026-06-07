/// 面向 PTY 字节流的增量 UTF-8 解码器。
///
/// 用于处理 read 边界切开多字节字符的情况；非法字节会以 U+FFFD 显式替代，
/// 避免把半个字符或损坏字节静默丢弃。
///
/// 性能：PTY 输出绝大多数是合法 UTF-8。当上一次没有残留字节时走零拷贝快路径，
/// 直接对本次输入做 `from_utf8`，仅在结尾被切断时把不完整残尾（<4 字节）暂存，
/// 避免把整块输入拷进内部缓冲再解码（详见 docs/performance-budget.md）。
#[derive(Default)]
pub struct Utf8ChunkDecoder {
    pending: Vec<u8>,
}

impl Utf8ChunkDecoder {
    /// 将新输入增量解码到 `output`。
    ///
    /// `last=true` 表示上游已结束，此时未完成的残留字节会输出替代字符。
    pub fn decode_into(&mut self, input: &[u8], output: &mut String, last: bool) {
        // 快路径：无残留字节时直接解码本次输入，零拷贝处理最常见的“整块合法”
        // 与“仅结尾切断一个多字节字符”两种情况，避免把整块输入拷进 pending。
        if self.pending.is_empty() && !input.is_empty() {
            match std::str::from_utf8(input) {
                Ok(valid) => {
                    output.push_str(valid);
                    return;
                }
                Err(error) if error.error_len().is_none() => {
                    // 仅结尾是不完整多字节序列：推完整前缀，残尾（<4 字节）留待下次补全。
                    let valid_up_to = error.valid_up_to();
                    if let Ok(valid_prefix) = std::str::from_utf8(&input[..valid_up_to]) {
                        output.push_str(valid_prefix);
                    }
                    if last {
                        // 上游已结束，残尾无法补全，输出替代字符。
                        output.push('\u{FFFD}');
                    } else {
                        self.pending.extend_from_slice(&input[valid_up_to..]);
                    }
                    return;
                }
                Err(_) => {
                    // 含真正的非法字节：交给下方稳健的逐段循环处理（含 U+FFFD 替代）。
                    self.pending.extend_from_slice(input);
                }
            }
        } else if !input.is_empty() {
            self.pending.extend_from_slice(input);
        }

        loop {
            if self.pending.is_empty() {
                return;
            }

            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    output.push_str(valid);
                    self.pending.clear();
                    return;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();

                    if valid_up_to > 0 {
                        if let Ok(valid_prefix) = std::str::from_utf8(&self.pending[..valid_up_to])
                        {
                            output.push_str(valid_prefix);
                        }
                        self.pending.drain(..valid_up_to);
                        continue;
                    }

                    if let Some(error_len) = error.error_len() {
                        output.push('\u{FFFD}');
                        self.pending.drain(..error_len);
                        continue;
                    }

                    if last {
                        output.push('\u{FFFD}');
                        self.pending.clear();
                    }

                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_chunk(decoder: &mut Utf8ChunkDecoder, input: &[u8]) -> String {
        let mut output = String::new();
        decoder.decode_into(input, &mut output, false);
        output
    }

    #[test]
    fn decodes_plain_ascii_without_buffering() {
        let mut decoder = Utf8ChunkDecoder::default();
        let out = decode_chunk(&mut decoder, b"hello world");
        assert_eq!(out, "hello world");
        // 快路径不应留下任何残留字节。
        let mut tail = String::new();
        decoder.decode_into(&[], &mut tail, true);
        assert!(tail.is_empty(), "合法整块解码后不应有残留字节");
    }

    #[test]
    fn keeps_split_multibyte_character_across_reads() {
        let mut decoder = Utf8ChunkDecoder::default();
        let bytes = "你".as_bytes();
        let mut output = String::new();
        decoder.decode_into(&bytes[..1], &mut output, false);
        assert!(output.is_empty(), "首字节不完整，应暂存而非输出");
        decoder.decode_into(&bytes[1..], &mut output, true);
        assert_eq!(output, "你");
    }

    #[test]
    fn fast_path_stashes_only_incomplete_tail() {
        let mut decoder = Utf8ChunkDecoder::default();
        let mut input = b"ab".to_vec();
        input.extend_from_slice(&"你".as_bytes()[..2]); // 完整 "ab" + "你" 的前两字节
        let mut output = String::new();
        decoder.decode_into(&input, &mut output, false);
        assert_eq!(output, "ab", "应输出完整前缀，仅暂存不完整残尾");
        decoder.decode_into(&"你".as_bytes()[2..], &mut output, false);
        assert_eq!(output, "ab你");
    }

    #[test]
    fn replaces_invalid_byte_in_the_middle() {
        let mut decoder = Utf8ChunkDecoder::default();
        let out = decode_chunk(&mut decoder, b"a\xFFb");
        assert_eq!(out, "a\u{FFFD}b");
    }

    #[test]
    fn emits_replacement_for_incomplete_tail_on_last() {
        let mut decoder = Utf8ChunkDecoder::default();
        let mut output = String::new();
        decoder.decode_into(&"你".as_bytes()[..1], &mut output, false);
        assert!(output.is_empty());
        decoder.decode_into(&[], &mut output, true);
        assert_eq!(output, "\u{FFFD}", "上游结束后不完整残尾应替代为 U+FFFD");
    }

    #[test]
    fn empty_input_with_last_and_no_pending_is_noop() {
        let mut decoder = Utf8ChunkDecoder::default();
        let mut output = String::new();
        decoder.decode_into(&[], &mut output, true);
        assert!(output.is_empty());
    }
}

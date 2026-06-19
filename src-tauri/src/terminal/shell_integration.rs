//! 终端 Shell Integration（对照 VSCode shellIntegration-bash.sh）。
//!
//! 通过 bash --init-file 注入的集成脚本会在交互 shell 中发出 OSC 133 生命周期标记
//! （A=提示符开始，B=提示符结束/命令行开始，C=命令输出开始，D=命令结束[;exit]）以及
//! OSC 633;P;Cwd 工作目录上报、OSC 633;P;ShellPid 交互 shell 自身 PID 上报。shell 自己绘制
//! 真实提示符，宿主不再抓取/合成提示符。
//!
//! 本模块提供：
//! - ShellIntegrationMark：解析出的标记。
//! - ShellIntegrationFilter：流式过滤器，从输出流中剥离上述标记序列（可跨多次读取拼接），
//!   返回干净文本 + 解析出的标记；其它任意转义序列（标题、颜色、OSC 7 等）原样保留。
//! - build_bash_integration_script：生成注入用 bash 集成脚本。
//!
//! Batch 1 仅铺管线：调用方剥离标记但暂不消费（丢弃），从而保持现有可视输出与行为完全不变；
//! 后续批次再把标记接入运行生命周期，并删除旧的合成提示符路径。

const BEL: char = '\u{0007}';
const ESC: char = '\u{001b}';

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellIntegrationMark {
    /// OSC 133;A —— 提示符开始。
    PromptStart,
    /// OSC 133;B —— 提示符结束、命令行输入开始。
    CommandStart,
    /// OSC 133;C —— 命令开始执行（输出开始）。
    CommandExecuted,
    /// OSC 133;D[;exit] —— 命令执行完成。
    CommandFinished { exit_code: Option<i32> },
    /// OSC 633;P;Cwd=<path> —— 工作目录上报。
    Cwd(String),
    /// OSC 633;P;ShellPid=<pid> —— 交互 shell 自身 PID 上报（供带外取消时读
    /// `/proc/<shellpid>/stat` 定位前台进程组）。
    ShellPid(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FilterState {
    Normal,
    Escape,
    Osc,
    OscEscape,
}

/// 流式 OSC 标记过滤器：从终端输出中剥离我们注入的 OSC 133 / OSC 633 序列。
///
/// 维护跨调用状态：被切分到两次 read 的转义序列会缓存到下次；EOF 时用 flush_remaining 吐回残尾。
#[derive(Debug)]
pub struct ShellIntegrationFilter {
    state: FilterState,
    /// 进行中的转义序列原文（自 ESC 起累加），用于在非目标 OSC 时原样回写。
    pending: String,
}

impl Default for ShellIntegrationFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl ShellIntegrationFilter {
    pub fn new() -> Self {
        Self {
            state: FilterState::Normal,
            pending: String::new(),
        }
    }

    /// 过滤一段输入：剥离注入的 OSC 133 / OSC 633 序列，返回 (干净文本, 标记列表)。
    /// 不完整的尾部序列会被缓存到下次调用；非目标转义序列原样保留。
    pub fn filter(&mut self, input: &str) -> (String, Vec<ShellIntegrationMark>) {
        let mut out = String::with_capacity(input.len());
        let mut marks = Vec::new();
        for c in input.chars() {
            match self.state {
                FilterState::Normal => {
                    if c == ESC {
                        self.state = FilterState::Escape;
                        self.pending.push(c);
                    } else {
                        out.push(c);
                    }
                }
                FilterState::Escape => {
                    if c == ']' {
                        self.state = FilterState::Osc;
                        self.pending.push(c);
                    } else {
                        // 非 OSC 引导（CSI 等）：原样吐回缓存的 ESC，再按 Normal 处理当前字符。
                        out.push_str(&self.pending);
                        self.pending.clear();
                        if c == ESC {
                            self.state = FilterState::Escape;
                            self.pending.push(c);
                        } else {
                            self.state = FilterState::Normal;
                            out.push(c);
                        }
                    }
                }
                FilterState::Osc => {
                    self.pending.push(c);
                    if c == BEL {
                        self.finish_osc(&mut out, &mut marks);
                    } else if c == ESC {
                        self.state = FilterState::OscEscape;
                    }
                }
                FilterState::OscEscape => {
                    self.pending.push(c);
                    if c == '\\' {
                        self.finish_osc(&mut out, &mut marks);
                    } else if c == ESC {
                        self.state = FilterState::OscEscape;
                    } else {
                        self.state = FilterState::Osc;
                    }
                }
            }
        }
        (out, marks)
    }

    /// 流结束（EOF）时调用：把缓存中的不完整序列原样吐回，避免吞字节，并复位状态。
    pub fn flush_remaining(&mut self) -> String {
        let remaining = std::mem::take(&mut self.pending);
        self.state = FilterState::Normal;
        remaining
    }

    fn finish_osc(&mut self, out: &mut String, marks: &mut Vec<ShellIntegrationMark>) {
        let seq = std::mem::take(&mut self.pending);
        self.state = FilterState::Normal;
        let body = strip_osc_envelope(&seq);
        // 仅 133 / 633 命名空间由本集成注入：识别即剥离（即使子格式略有出入也不外泄为可见文本）。
        if body.starts_with("133") || body.starts_with("633") {
            if let Some(mark) = parse_mark(body) {
                marks.push(mark);
            }
        } else {
            out.push_str(&seq);
        }
    }
}

/// 去掉 OSC 包络：前导 "ESC ]" 与结尾终止符（BEL 或 ST=ESC \）。
fn strip_osc_envelope(seq: &str) -> &str {
    let s = seq.strip_prefix(ESC).unwrap_or(seq);
    let s = s.strip_prefix(']').unwrap_or(s);
    if let Some(stripped) = s.strip_suffix(BEL) {
        stripped
    } else if let Some(stripped) = s.strip_suffix("\u{001b}\\") {
        stripped
    } else {
        s
    }
}

fn parse_mark(body: &str) -> Option<ShellIntegrationMark> {
    let mut parts = body.split(';');
    match parts.next()? {
        "133" => match parts.next()? {
            "A" => Some(ShellIntegrationMark::PromptStart),
            "B" => Some(ShellIntegrationMark::CommandStart),
            "C" => Some(ShellIntegrationMark::CommandExecuted),
            "D" => {
                let exit_code = parts.next().and_then(|v| v.parse::<i32>().ok());
                Some(ShellIntegrationMark::CommandFinished { exit_code })
            }
            _ => None,
        },
        "633" => {
            if parts.next()? != "P" {
                return None;
            }
            let joined = parts.collect::<Vec<_>>().join(";");
            if let Some(cwd) = joined.strip_prefix("Cwd=") {
                Some(ShellIntegrationMark::Cwd(cwd.to_string()))
            } else if let Some(pid) = joined.strip_prefix("ShellPid=") {
                // 非法 / 非数字 PID 视为无效标记丢弃（与其它子格式不匹配即 None 的策略一致）。
                pid.parse::<u32>().ok().map(ShellIntegrationMark::ShellPid)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// 生成注入用 bash 集成脚本（对照 VSCode shellIntegration-bash.sh，精简掉 nonce/env 上报）。
///
/// 经 bash --init-file 注入：--init-file 隐含交互非登录 shell 且不认 -l，故脚本在被宿主注入时
/// 自行 source 登录启动文件（/etc/profile + 首个 profile），等价于原 bash -il 的环境；随后用
/// PROMPT_COMMAND + PS1 包裹 + DEBUG trap 发出 OSC 133 生命周期标记与 OSC 633;P;Cwd，并在启动时
/// 经 OSC 633;P;ShellPid 上报自身 PID 一次。
pub fn build_bash_integration_script() -> String {
    String::from(SHELL_INTEGRATION_BASH)
}

const SHELL_INTEGRATION_BASH: &str = r##"# Calamex shell integration (modeled on VSCode shellIntegration-bash.sh).
# Injected via: bash --init-file <this> -i

if [ -n "$CALAMEX_SHELL_INTEGRATION" ]; then
	builtin return
fi
CALAMEX_SHELL_INTEGRATION=1

# --init-file implies interactive non-login and ignores -l. Imitate the previous
# "bash -il" by sourcing login startup files ourselves, only when host-injected.
if [ "$CALAMEX_SHELL_INTEGRATION_INJECTION" = "1" ]; then
	if [ -r /etc/profile ]; then
		. /etc/profile
	fi
	if [ -r ~/.bash_profile ]; then
		. ~/.bash_profile
	elif [ -r ~/.bash_login ]; then
		. ~/.bash_login
	elif [ -r ~/.profile ]; then
		. ~/.profile
	fi
	builtin unset CALAMEX_SHELL_INTEGRATION_INJECTION
fi

# Report this interactive shell's own PID once so the host can locate its
# foreground process group (/proc/<pid>/stat) for out-of-band cancellation.
builtin printf '\e]633;P;ShellPid=%s\a' "$$"

__calamex_first_prompt=0
__calamex_in_execution=0
__calamex_status=0

__calamex_prompt_start() {
	builtin printf '\e]133;A\a'
}

__calamex_prompt_end() {
	builtin printf '\e]133;B\a'
}

__calamex_update_cwd() {
	builtin printf '\e]633;P;Cwd=%s\a' "$PWD"
}

# preexec: a command is about to run -> output start.
__calamex_preexec() {
	builtin printf '\e]133;C\a'
}

# precmd: previous command finished -> emit D with exit status, report cwd.
__calamex_precmd() {
	builtin printf '\e]133;D;%s\a' "$__calamex_status"
	__calamex_update_cwd
}

__calamex_original_prompt_command="$PROMPT_COMMAND"

__calamex_prompt_cmd() {
	__calamex_status="$?"
	if [ -n "$__calamex_original_prompt_command" ]; then
		builtin eval "$__calamex_original_prompt_command"
	fi
	if [ "$__calamex_first_prompt" = "1" ]; then
		__calamex_precmd
	else
		__calamex_first_prompt=1
		__calamex_update_cwd
	fi
	__calamex_in_execution=0
}

# Wrap PS1 with zero-width prompt-start / prompt-end markers.
__calamex_original_PS1="$PS1"
PS1="\[$(__calamex_prompt_start)\]$__calamex_original_PS1\[$(__calamex_prompt_end)\]"

PROMPT_COMMAND=__calamex_prompt_cmd

# preexec via DEBUG trap; skip our own internal machinery.
__calamex_debug_trap() {
	case "$BASH_COMMAND" in
		__calamex_*) builtin return ;;
	esac
	if [ "$__calamex_in_execution" = "0" ]; then
		__calamex_in_execution=1
		__calamex_preexec
	fi
}
trap '__calamex_debug_trap' DEBUG
"##;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_prompt_marks_and_keeps_text() {
        let mut f = ShellIntegrationFilter::new();
        let (clean, marks) = f.filter("\u{001b}]133;A\u{0007}$ \u{001b}]133;B\u{0007}");
        assert_eq!(clean, "$ ");
        assert_eq!(
            marks,
            vec![
                ShellIntegrationMark::PromptStart,
                ShellIntegrationMark::CommandStart
            ]
        );
    }

    #[test]
    fn keeps_unrelated_osc() {
        let mut f = ShellIntegrationFilter::new();
        let input = "\u{001b}]0;title\u{0007}hello";
        let (clean, marks) = f.filter(input);
        assert_eq!(clean, input);
        assert!(marks.is_empty());
    }

    #[test]
    fn keeps_csi_sequences() {
        let mut f = ShellIntegrationFilter::new();
        let input = "x\u{001b}[31mred\u{001b}[0m";
        let (clean, marks) = f.filter(input);
        assert_eq!(clean, input);
        assert!(marks.is_empty());
        assert_eq!(f.flush_remaining(), "");
    }

    #[test]
    fn parses_command_finished_exit() {
        let mut f = ShellIntegrationFilter::new();
        let (_clean, marks) = f.filter("\u{001b}]133;D;3\u{0007}");
        assert_eq!(
            marks,
            vec![ShellIntegrationMark::CommandFinished { exit_code: Some(3) }]
        );
    }

    #[test]
    fn parses_cwd_633() {
        let mut f = ShellIntegrationFilter::new();
        let (clean, marks) = f.filter("\u{001b}]633;P;Cwd=/home/x\u{0007}");
        assert_eq!(clean, "");
        assert_eq!(
            marks,
            vec![ShellIntegrationMark::Cwd("/home/x".to_string())]
        );
    }

    #[test]
    fn parses_shell_pid_633() {
        let mut f = ShellIntegrationFilter::new();
        let (clean, marks) = f.filter("\u{001b}]633;P;ShellPid=4242\u{0007}");
        assert_eq!(clean, "");
        assert_eq!(marks, vec![ShellIntegrationMark::ShellPid(4242)]);
    }

    #[test]
    fn ignores_invalid_shell_pid_633() {
        let mut f = ShellIntegrationFilter::new();
        // 非数字 PID 既不外泄为可见文本，也不产出标记。
        let (clean, marks) = f.filter("\u{001b}]633;P;ShellPid=abc\u{0007}");
        assert_eq!(clean, "");
        assert!(marks.is_empty());
    }

    #[test]
    fn handles_split_sequence_across_reads() {
        let mut f = ShellIntegrationFilter::new();
        let (c1, m1) = f.filter("abc\u{001b}]133;A");
        assert_eq!(c1, "abc");
        assert!(m1.is_empty());
        let (c2, m2) = f.filter("\u{0007}def");
        assert_eq!(c2, "def");
        assert_eq!(m2, vec![ShellIntegrationMark::PromptStart]);
    }

    #[test]
    fn handles_st_terminator() {
        let mut f = ShellIntegrationFilter::new();
        let (clean, marks) = f.filter("\u{001b}]133;C\u{001b}\\rest");
        assert_eq!(clean, "rest");
        assert_eq!(marks, vec![ShellIntegrationMark::CommandExecuted]);
    }

    #[test]
    fn build_script_contains_markers() {
        let s = build_bash_integration_script();
        assert!(s.contains("]133;A"));
        assert!(s.contains("]633;P;ShellPid="));
        assert!(s.contains("PROMPT_COMMAND=__calamex_prompt_cmd"));
        assert!(s.contains("trap '__calamex_debug_trap' DEBUG"));
    }
}

/**
 * Compact elapsed-time formatting for the run status bar.
 *
 * Mirrors Codex CLI's `fmt_elapsed_compact`
 * (codex-rs/tui/src/status_indicator_widget.rs). Examples:
 * `0s`, `59s`, `1m 00s`, `59m 59s`, `1h 00m 00s`, `25h 02m 03s`.
 */
export const formatElapsedCompact = (elapsedSeconds: number): string => {
  const totalSeconds = Number.isFinite(elapsedSeconds)
    ? Math.max(0, Math.floor(elapsedSeconds))
    : 0;

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const pad = (value: number): string => String(value).padStart(2, '0');

  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${pad(seconds)}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
};

const DEFAULT_TERMINAL_FONT_FAMILY =
  "Berkeley Mono, JetBrains Mono, 'SFMono-Regular', Consolas, 'Courier New', monospace";

export const resolveTerminalFontFamily = (fontFamily: string): string => {
  const normalized = fontFamily.trim();
  return normalized.length > 0
    ? `${normalized}, ${DEFAULT_TERMINAL_FONT_FAMILY}`
    : DEFAULT_TERMINAL_FONT_FAMILY;
};

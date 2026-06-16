/**
 * L2 Variant: dark
 *
 * 将 Primer Dark functional color tokens 映射为 IRoles 语义角色。
 * 此文件是本系统中唯一允许 import primitives 的地方（variants/ 目录）。
 */
import { P } from '../tokens/primitives';
import type { IRoles } from '../tokens/types';

export const dark: IRoles = {
  surface: {
    app: P.darkBgDefault,
    chrome: P.darkBgMuted,
    activity: P.darkBgInset,
    sidebar: P.darkBgMuted,
    editor: P.darkBgDefault,
    editorGutter: P.darkBgDefault,
    editorWidget: P.darkControlBgRest,
    panel: P.darkBgMuted,
    panelDepth: P.darkControlBgRest,
    tabbar: P.darkBgMuted,
    tabActive: P.darkBgDefault,
    tabHover: P.darkControlBgRest,
    overlay: P.darkControlBgRest,
    overlayDepth: P.darkControlBgHover,
    hover: P.darkBgNeutralMuted,
    soft: P.darkBgAccentMuted,
    softStrong: P.darkBorderAccentMuted,
    selection: P.darkBgAccentMuted,
  },

  text: {
    primary: P.darkFgDefault,
    secondary: P.darkFgMuted,
    tertiary: P.darkFgDisabled,
    quaternary: P.darkBorderDefault,
    onAccent: P.darkFgOnEmphasis,
    placeholder: P.darkFgMuted,
  },

  border: {
    subtle: P.darkBorderMuted,
    strong: P.darkBorderDefault,
    divider: P.darkBorderMuted,
  },

  accent: {
    default: P.darkBgAccentEmphasis,
    strong: P.darkBgAccentEmphasis,
    muted: P.darkBgAccentMuted,
    soft: P.darkBorderAccentMuted,
    statusbar: P.darkBgAccentEmphasis,
  },

  status: {
    success: P.darkFgSuccess,
    successMuted: P.darkBgSuccessMuted,
    warning: P.darkFgAttention,
    warningMuted: P.darkBgAttentionMuted,
    danger: P.darkFgDanger,
    dangerMuted: P.darkBgDangerMuted,
    info: P.darkFgAccent,
    infoMuted: P.darkBgAccentMuted,
  },

  syntax: {
    comment: P.darkSyntaxComment,
    keyword: P.darkSyntaxKeyword,
    string: P.darkSyntaxString,
    number: P.darkSyntaxConstant,
    delimiter: P.darkFgMuted,
    variable: P.darkSyntaxVariable,
    type: P.darkSyntaxEntity,
    operator: P.darkFgMuted,
    cursor: P.darkFgDefault,
    lineNumber: P.darkFgDisabled,
    lineNumberActive: P.darkFgMuted,
  },

  diff: {
    modified: P.darkBgAccentEmphasis,
    added: P.darkFgSuccess,
    deleted: P.darkFgDanger,
    addedSubtle: P.darkBgSuccessMuted,
    deletedSubtle: P.darkBgDangerMuted,
    modifiedSubtle: P.darkBgAccentMuted,
    divider: P.darkBorderDefault,
  },

  terminal: {
    background: P.darkBgDefault,
    foreground: P.darkFgDefault,
    cursor: P.darkFgDefault,
    cursorAccent: P.darkBgDefault,
    selectionBackground: P.darkBgAccentMuted,
    scrollbarBackground: P.darkBgNeutralMuted,
    scrollbarHoverBackground: P.darkBorderAccentMuted,
    scrollbarActiveBackground: P.darkBorderEmphasis,
    black: P.darkAnsiBlack,
    red: P.darkAnsiRed,
    green: P.darkAnsiGreen,
    yellow: P.darkAnsiYellow,
    blue: P.darkAnsiBlue,
    magenta: P.darkAnsiMagenta,
    cyan: P.darkAnsiCyan,
    white: P.darkAnsiWhite,
    brightBlack: P.darkAnsiBrightBlack,
    brightRed: P.darkAnsiBrightRed,
    brightGreen: P.darkAnsiBrightGreen,
    brightYellow: P.darkAnsiBrightYellow,
    brightBlue: P.darkAnsiBrightBlue,
    brightMagenta: P.darkAnsiBrightMagenta,
    brightCyan: P.darkAnsiBrightCyan,
    brightWhite: P.darkAnsiBrightWhite,
  },
};

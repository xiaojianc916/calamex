/**
 * L2 Variant: light
 *
 * 将 Primer Light functional color tokens 映射为 IRoles 语义角色（浅色主题）。
 * 此文件是本系统中唯一允许 import primitives 的地方（variants/ 目录）。
 */
import { P } from '../primitives';
import type { IRoles } from '../types';

export const light: IRoles = {

    surface: {
        app: P.lightBgMuted,
        chrome: P.lightBgDefault,
        activity: P.lightBgMuted,
        sidebar: P.lightBgMuted,
        editor: P.lightBgMuted,
        editorGutter: P.lightBgMuted,
        editorWidget: P.lightControlBgRest,
        panel: P.lightBgMuted,
        panelDepth: P.lightControlBgHover,
        tabbar: P.lightBgMuted,
        tabActive: P.lightBgDefault,
        tabHover: P.lightControlBgHover,
        overlay: P.lightBgDefault,
        overlayDepth: P.lightBgMuted,
        hover: P.lightBgNeutralMuted,
        soft: P.lightBgNeutralMuted,
        softStrong: P.lightBorderMuted,
        selection: P.lightBgAccentMuted,
    },

    text: {
        primary: P.lightFgDefault,
        secondary: P.lightFgMuted,
        tertiary: P.lightFgDisabled,
        quaternary: P.lightBorderEmphasis,
        onAccent: P.lightFgOnEmphasis,
        placeholder: P.lightFgMuted,
    },

    border: {
        subtle: P.lightBorderMuted,
        strong: P.lightBorderDefault,
        divider: P.lightBorderMuted,
    },

    accent: {
        default: P.lightBgAccentEmphasis,
        strong: P.lightBgAccentEmphasis,
        muted: P.lightBgAccentMuted,
        soft: P.lightBorderAccentMuted,
        statusbar: P.lightBgAccentEmphasis,
    },

    status: {
        success: P.lightFgSuccess,
        successMuted: P.lightBgSuccessMuted,
        warning: P.lightFgAttention,
        warningMuted: P.lightBgAttentionMuted,
        danger: P.lightFgDanger,
        dangerMuted: P.lightBgDangerMuted,
        info: P.lightFgAccent,
        infoMuted: P.lightBgAccentMuted,
    },

    syntax: {
        comment: P.lightSyntaxComment,
        keyword: P.lightSyntaxKeyword,
        string: P.lightSyntaxString,
        number: P.lightSyntaxConstant,
        delimiter: P.lightFgMuted,
        variable: P.lightSyntaxVariable,
        type: P.lightSyntaxEntity,
        operator: P.lightFgMuted,
        cursor: P.lightFgDefault,
        lineNumber: P.lightFgMuted,
        lineNumberActive: P.lightFgDefault,
    },

    diff: {
        modified: P.lightBgAccentEmphasis,
        added: P.lightFgSuccess,
        deleted: P.lightFgDanger,
        addedSubtle: P.lightBgSuccessMuted,
        deletedSubtle: P.lightBgDangerMuted,
        modifiedSubtle: P.lightBgAccentMuted,
    },

    terminal: {
        background: P.lightBgDefault,
        foreground: P.lightFgDefault,
        cursor: P.lightFgDefault,
        cursorAccent: P.lightBgDefault,
        selectionBackground: P.lightBgAccentMuted,
        scrollbarBackground: P.lightBgNeutralMuted,
        scrollbarHoverBackground: P.lightBorderMuted,
        scrollbarActiveBackground: P.lightBorderEmphasis,
        black: P.lightAnsiBlack,
        red: P.lightAnsiRed,
        green: P.lightAnsiGreen,
        yellow: P.lightAnsiYellow,
        blue: P.lightAnsiBlue,
        magenta: P.lightAnsiMagenta,
        cyan: P.lightAnsiCyan,
        white: P.lightAnsiWhite,
        brightBlack: P.lightAnsiBrightBlack,
        brightRed: P.lightAnsiBrightRed,
        brightGreen: P.lightAnsiBrightGreen,
        brightYellow: P.lightAnsiBrightYellow,
        brightBlue: P.lightAnsiBrightBlue,
        brightMagenta: P.lightAnsiBrightMagenta,
        brightCyan: P.lightAnsiBrightCyan,
        brightWhite: P.lightAnsiBrightWhite,
    },
};
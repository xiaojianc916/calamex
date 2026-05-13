/**
 * L1 Primitives — Primer 官方 functional color tokens
 *
 * 来源：@primer/primitives@11.7.1 dist/css/functional/themes/{light,dark}.css。
 * 规则：
 *  - 每个官方值只在此文件出现一次；新增颜色在此追加，不在别处散落字面量
 *  - 命名保留 Primer functional token 语义，便于与官方文档核对
 *  - 此文件只供 variants/ 引用；禁止 derive/、components.ts、UI 代码直接 import
 */

export const P = {
    transparentDark: '#00000000',
    transparentLight: '#ffffff00',
    white: '#ffffff',
    black: '#010409',

    // ─────────────────────────────────────────────
    // Primer Light — Functional colors
    // ─────────────────────────────────────────────
    lightBgDefault: '#ffffff',              // --bgColor-default
    lightBgMuted: '#f6f8fa',                // --bgColor-muted
    lightBgInset: '#f6f8fa',                // --bgColor-inset
    lightBgEmphasis: '#25292e',             // --bgColor-emphasis
    lightBgNeutralMuted: '#818b981f',       // --bgColor-neutral-muted
    lightBgAccentEmphasis: '#0969da',       // --bgColor-accent-emphasis
    lightBgAccentMuted: '#ddf4ff',          // --bgColor-accent-muted
    lightBgSuccessEmphasis: '#1f883d',      // --bgColor-success-emphasis
    lightBgSuccessMuted: '#dafbe1',         // --bgColor-success-muted
    lightBgAttentionEmphasis: '#9a6700',    // --bgColor-attention-emphasis
    lightBgAttentionMuted: '#fff8c5',       // --bgColor-attention-muted
    lightBgDangerEmphasis: '#cf222e',       // --bgColor-danger-emphasis
    lightBgDangerMuted: '#ffebe9',          // --bgColor-danger-muted
    lightBgDoneEmphasis: '#8250df',         // --bgColor-done-emphasis
    lightBgDoneMuted: '#fbefff',            // --bgColor-done-muted
    lightDiffInsertedLineBackground: '#e7f4e7',
    lightDiffRemovedLineBackground: '#fbe6e2',
    lightDiffDivider: '#f0f2f3',
    lightControlBgRest: '#f6f8fa',          // --control-bgColor-rest
    lightControlBgHover: '#eff2f5',         // --control-bgColor-hover
    lightControlBgActive: '#e6eaef',        // --control-bgColor-active

    lightFgDefault: '#1f2328',              // --fgColor-default
    lightTerminalForeground: '#1a1c1f',     // 终端默认前景色
    lightTerminalCursor: '#000000',         // 终端光标色
    lightFgMuted: '#59636e',                // --fgColor-muted
    lightFgDisabled: '#818b98',             // --fgColor-disabled
    lightFgOnEmphasis: '#ffffff',           // --fgColor-onEmphasis
    lightFgAccent: '#0969da',               // --fgColor-accent
    lightFgSuccess: '#1a7f37',              // --fgColor-success
    lightFgAttention: '#9a6700',            // --fgColor-attention
    lightFgDanger: '#d1242f',               // --fgColor-danger
    lightFgDone: '#8250df',                 // --fgColor-done

    lightBorderDefault: '#d1d9e0',          // --borderColor-default
    lightBorderMuted: '#d1d9e0b3',          // --borderColor-muted
    lightBorderEmphasis: '#818b98',         // --borderColor-emphasis
    lightBorderAccentMuted: '#54aeff66',    // --borderColor-accent-muted
    lightBorderSuccessMuted: '#4ac26b66',   // --borderColor-success-muted
    lightBorderAttentionMuted: '#d4a72c66', // --borderColor-attention-muted
    lightBorderDangerMuted: '#ff818266',    // --borderColor-danger-muted

    // ─────────────────────────────────────────────
    // Primer Dark — Functional colors
    // ─────────────────────────────────────────────
    darkBgDefault: '#0d1117',               // --bgColor-default
    darkBgMuted: '#151b23',                 // --bgColor-muted
    darkBgInset: '#010409',                 // --bgColor-inset
    darkBgEmphasis: '#3d444d',              // --bgColor-emphasis
    darkBgNeutralMuted: '#656c7633',        // --bgColor-neutral-muted
    darkBgAccentEmphasis: '#dcdee0',        // --bgColor-accent-emphasis
    darkBgAccentMuted: '#388bfd1a',         // --bgColor-accent-muted
    darkBgSuccessEmphasis: '#238636',       // --bgColor-success-emphasis
    darkBgSuccessMuted: '#2ea04326',        // --bgColor-success-muted
    darkBgAttentionEmphasis: '#9e6a03',     // --bgColor-attention-emphasis
    darkBgAttentionMuted: '#bb800926',      // --bgColor-attention-muted
    darkBgDangerEmphasis: '#da3633',        // --bgColor-danger-emphasis
    darkBgDangerMuted: '#f851491a',         // --bgColor-danger-muted
    darkBgDoneEmphasis: '#8957e5',          // --bgColor-done-emphasis
    darkBgDoneMuted: '#ab7df826',           // --bgColor-done-muted
    darkControlBgRest: '#FAFAFA',           // --control-bgColor-rest
    darkControlBgHover: '#262c36',          // --control-bgColor-hover
    darkControlBgActive: '#2a313c',         // --control-bgColor-active

    darkFgDefault: '#f0f6fc',               // --fgColor-default
    darkFgMuted: '#9198a1',                 // --fgColor-muted
    darkFgDisabled: '#656c76',              // --fgColor-disabled
    darkFgOnEmphasis: '#ffffff',            // --fgColor-onEmphasis
    darkFgAccent: '#4493f8',                // --fgColor-accent
    darkFgSuccess: '#3fb950',               // --fgColor-success
    darkFgAttention: '#d29922',             // --fgColor-attention
    darkFgDanger: '#f85149',                // --fgColor-danger
    darkFgDone: '#ab7df8',                  // --fgColor-done

    darkBorderDefault: '#3d444d',           // --borderColor-default
    darkBorderMuted: '#3d444db3',           // --borderColor-muted
    darkBorderEmphasis: '#656c76',          // --borderColor-emphasis
    darkBorderAccentMuted: '#388bfd66',     // --borderColor-accent-muted
    darkBorderSuccessMuted: '#2ea04366',    // --borderColor-success-muted
    darkBorderAttentionMuted: '#bb800966',  // --borderColor-attention-muted
    darkBorderDangerMuted: '#f8514966',     // --borderColor-danger-muted

    // ─────────────────────────────────────────────
    // Primer syntax — Prettylights
    // ─────────────────────────────────────────────
    lightSyntaxComment: '#59636e',
    lightSyntaxConstant: '#0550ae',
    lightSyntaxString: '#0a3069',
    lightSyntaxEntity: '#6639ba',
    lightSyntaxKeyword: '#cf222e',
    lightSyntaxVariable: '#953800',
    lightSyntaxMarkupList: '#3b2300',

    darkSyntaxComment: '#9198a1',
    darkSyntaxConstant: '#79c0ff',
    darkSyntaxString: '#a5d6ff',
    darkSyntaxEntity: '#d2a8ff',
    darkSyntaxEntityTag: '#7ee787',
    darkSyntaxKeyword: '#ff7b72',
    darkSyntaxVariable: '#ffa657',
    darkSyntaxMarkupList: '#f2cc60',

    // ─────────────────────────────────────────────
    // Primer ANSI colors
    // ─────────────────────────────────────────────
    lightAnsiBlack: '#1f2328',
    lightAnsiBrightBlack: '#393f46',
    lightAnsiRed: '#cf222e',
    lightAnsiBrightRed: '#a40e26',
    lightAnsiGreen: '#116329',
    lightAnsiBrightGreen: '#1a7f37',
    lightAnsiYellow: '#4d2d00',
    lightAnsiBrightYellow: '#633c01',
    lightAnsiBlue: '#0969da',
    lightAnsiBrightBlue: '#218bff',
    lightAnsiMagenta: '#8250df',
    lightAnsiBrightMagenta: '#a475f9',
    lightAnsiCyan: '#1b7c83',
    lightAnsiBrightCyan: '#3192aa',
    lightAnsiWhite: '#59636e',
    lightAnsiBrightWhite: '#818b98',

    darkAnsiBlack: '#2f3742',
    darkAnsiBrightBlack: '#656c76',
    darkAnsiRed: '#ff7b72',
    darkAnsiBrightRed: '#ffa198',
    darkAnsiGreen: '#3fb950',
    darkAnsiBrightGreen: '#56d364',
    darkAnsiYellow: '#d29922',
    darkAnsiBrightYellow: '#e3b341',
    darkAnsiBlue: '#58a6ff',
    darkAnsiBrightBlue: '#79c0ff',
    darkAnsiMagenta: '#be8fff',
    darkAnsiBrightMagenta: '#d2a8ff',
    darkAnsiCyan: '#39c5cf',
    darkAnsiBrightCyan: '#56d4dd',
    darkAnsiWhite: '#f0f6fc',
    darkAnsiBrightWhite: '#ffffff',
} as const satisfies Record<string, string>;

export type TPrimitive = (typeof P)[keyof typeof P];

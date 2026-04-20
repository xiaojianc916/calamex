import type {
    TAccentColor,
    TRadiusPreset,
    TThemePreference,
    TUiDensity,
} from './app';

export type TSettingsSectionId =
    | 'general'
    | 'appearance'
    | 'editor'
    | 'terminal'
    | 'run'
    | 'style'
    | 'keybinds'
    | 'integrations'
    | 'about';

export type TStartupBehavior = 'restore' | 'empty';
export type TUpdateChannel = 'stable' | 'beta' | 'nightly';
export type TIndentStyle = 'spaces' | 'tabs';
export type TAutoSaveMode = 'off' | 'focus';
export type TWordWrapMode = 'off' | 'viewport';
export type TWhitespaceMode = 'never' | 'selection' | 'always';
export type TTerminalWorkingDirectoryMode = 'current-file' | 'workspace-root';
export type TTerminalCursorStyle = 'block' | 'underline' | 'bar';
export type TTerminalRightClickBehavior = 'paste' | 'menu' | 'copy-paste';
export type TTerminalBellMode = 'off' | 'flash' | 'sound';
export type TRunWorkingDirectoryMode = 'script-dir' | 'workspace-root';
export type TFunctionBraceStyle = 'same-line' | 'next-line';
export type TDiagnosticLevel = 'error' | 'warning' | 'info' | 'style';
export type TShellDialect = 'bash' | 'sh' | 'ksh';
export type TKeyboardLayoutPreset = 'windows' | 'macos';

export interface ISettingsEnvironmentVariable {
    id: string;
    key: string;
    value: string;
}

export interface IGeneralSettings {
    language: 'zh-CN';
    dateFormat: 'YYYY-MM-DD';
    use24HourClock: boolean;
    startupBehavior: TStartupBehavior;
    recentFileLimit: number;
    autoCheckUpdates: boolean;
    updateChannel: TUpdateChannel;
    telemetryEnabled: boolean;
    crashReportsEnabled: boolean;
}

export interface IAppearanceSettings {
    themePreference: TThemePreference;
    accentColor: TAccentColor;
    uiDensity: TUiDensity;
    interfaceFontSize: number;
    radiusPreset: TRadiusPreset;
    reduceMotion: boolean;
}

export interface IEditorSettings {
    fontFamily: string;
    fontSize: number;
    lineHeight: '1.4' | '1.6' | '1.8';
    fontLigatures: boolean;
    indentation: TIndentStyle;
    tabSize: number;
    detectIndentation: boolean;
    autoSave: TAutoSaveMode;
    formatOnSave: boolean;
    shellcheckOnSave: boolean;
    autoClosingPairs: boolean;
    trimTrailingWhitespace: boolean;
    insertFinalNewline: boolean;
    lineNumbers: boolean;
    wordWrap: TWordWrapMode;
    whitespace: TWhitespaceMode;
    indentGuides: boolean;
    minimap: boolean;
    commandCompletion: boolean;
    completionTriggers: string[];
    suggestionDelay: number;
    defaultShebang: string;
    strictModeByDefault: boolean;
}

export interface ITerminalSettings {
    defaultShell: string;
    shellArgs: string;
    workingDirectory: TTerminalWorkingDirectoryMode;
    inheritEnvironment: boolean;
    fontFamily: string;
    fontSize: number;
    lineHeight: '1.2' | '1.4' | '1.6';
    cursorStyle: TTerminalCursorStyle;
    cursorBlink: boolean;
    scrollback: number;
    trimFinalNewlineOnCopy: boolean;
    copyOnSelect: boolean;
    rightClickBehavior: TTerminalRightClickBehavior;
    bellMode: TTerminalBellMode;
    clickableLinks: boolean;
}

export interface IRunSettings {
    defaultInterpreter: string;
    workingDirectory: TRunWorkingDirectoryMode;
    saveBeforeRun: boolean;
    clearTerminalBeforeRun: boolean;
    revealTerminalOnRun: boolean;
    stopTimeoutSeconds: number;
    environmentVariables: ISettingsEnvironmentVariable[];
    notifyOnFinish: boolean;
    highlightNonZeroExit: boolean;
    preservedTerminalCount: number;
}

export interface IStyleSettings {
    enableShfmt: boolean;
    shfmtIndentSize: number;
    binaryOperatorLineBreak: boolean;
    functionBraceStyle: TFunctionBraceStyle;
    caseIndent: boolean;
    simplifyCase: boolean;
    languageVariant: 'bash' | 'posix';
    enableShellcheck: boolean;
    minimumDiagnosticLevel: TDiagnosticLevel;
    shellDialect: TShellDialect;
    ignoredRules: string[];
    autoFix: boolean;
    rulerColumn: number;
}

export interface IKeybindingSettings {
    keyboardLayoutPreset: TKeyboardLayoutPreset;
}

export interface IIntegrationSettings {
    gitEnabled: boolean;
    gitUserName: string;
    gitUserEmail: string;
    gitDefaultBranch: string;
    gitAutoFetch: boolean;
    gitSignedCommit: boolean;
    sshIdentityPath: string;
    sshUseAgent: boolean;
    sshConnectTimeoutSeconds: number;
    sshStrictHostKeyChecking: 'ask' | 'yes' | 'no';
}

export interface IAppSettings {
    general: IGeneralSettings;
    appearance: IAppearanceSettings;
    editor: IEditorSettings;
    terminal: ITerminalSettings;
    run: IRunSettings;
    style: IStyleSettings;
    keybinds: IKeybindingSettings;
    integrations: IIntegrationSettings;
}

export type TAppSettingsSectionKey = keyof IAppSettings;

const createUniqueId = (prefix: string): string => {
    const cryptoRef =
        typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined;

    if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
        return `${prefix}-${cryptoRef.randomUUID()}`;
    }

    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export const createSettingsEnvironmentVariable = (
    key = '',
    value = '',
): ISettingsEnvironmentVariable => ({
    id: createUniqueId('env'),
    key,
    value,
});

export const createDefaultAppSettings = (): IAppSettings => ({
    general: {
        language: 'zh-CN',
        dateFormat: 'YYYY-MM-DD',
        use24HourClock: true,
        startupBehavior: 'restore',
        recentFileLimit: 20,
        autoCheckUpdates: true,
        updateChannel: 'stable',
        telemetryEnabled: false,
        crashReportsEnabled: true,
    },
    appearance: {
        themePreference: 'dark',
        accentColor: 'indigo',
        uiDensity: 'default',
        interfaceFontSize: 13,
        radiusPreset: 'default',
        reduceMotion: false,
    },
    editor: {
        fontFamily: 'JetBrains Mono',
        fontSize: 13,
        lineHeight: '1.6',
        fontLigatures: true,
        indentation: 'spaces',
        tabSize: 4,
        detectIndentation: true,
        autoSave: 'focus',
        formatOnSave: true,
        shellcheckOnSave: false,
        autoClosingPairs: true,
        trimTrailingWhitespace: true,
        insertFinalNewline: true,
        lineNumbers: true,
        wordWrap: 'viewport',
        whitespace: 'selection',
        indentGuides: true,
        minimap: false,
        commandCompletion: true,
        completionTriggers: ['$', '/', '-', '.'],
        suggestionDelay: 120,
        defaultShebang: '#!/usr/bin/env bash',
        strictModeByDefault: true,
    },
    terminal: {
        defaultShell: '/bin/bash',
        shellArgs: '-il',
        workingDirectory: 'current-file',
        inheritEnvironment: true,
        fontFamily: 'JetBrains Mono',
        fontSize: 13,
        lineHeight: '1.4',
        cursorStyle: 'block',
        cursorBlink: true,
        scrollback: 5000,
        trimFinalNewlineOnCopy: true,
        copyOnSelect: false,
        rightClickBehavior: 'paste',
        bellMode: 'flash',
        clickableLinks: true,
    },
    run: {
        defaultInterpreter: '/usr/bin/env bash',
        workingDirectory: 'script-dir',
        saveBeforeRun: true,
        clearTerminalBeforeRun: false,
        revealTerminalOnRun: true,
        stopTimeoutSeconds: 3,
        environmentVariables: [
            createSettingsEnvironmentVariable('LANG', 'zh_CN.UTF-8'),
            createSettingsEnvironmentVariable('EDITOR', 'sh-editor --wait'),
        ],
        notifyOnFinish: true,
        highlightNonZeroExit: true,
        preservedTerminalCount: 5,
    },
    style: {
        enableShfmt: true,
        shfmtIndentSize: 2,
        binaryOperatorLineBreak: false,
        functionBraceStyle: 'same-line',
        caseIndent: true,
        simplifyCase: false,
        languageVariant: 'bash',
        enableShellcheck: true,
        minimumDiagnosticLevel: 'warning',
        shellDialect: 'bash',
        ignoredRules: ['SC2086', 'SC1091'],
        autoFix: false,
        rulerColumn: 100,
    },
    keybinds: {
        keyboardLayoutPreset: 'windows',
    },
    integrations: {
        gitEnabled: true,
        gitUserName: 'xiaojianc',
        gitUserEmail: 'xiaojianc125@gmail.com',
        gitDefaultBranch: 'main',
        gitAutoFetch: true,
        gitSignedCommit: false,
        sshIdentityPath: '~/.ssh/id_ed25519',
        sshUseAgent: true,
        sshConnectTimeoutSeconds: 10,
        sshStrictHostKeyChecking: 'ask',
    },
});
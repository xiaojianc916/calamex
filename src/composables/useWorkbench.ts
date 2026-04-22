import { useDocumentLifecycle } from '@/composables/useDocumentLifecycle';
import { useDocumentPersistence } from '@/composables/useDocumentPersistence';
import { useMessage } from '@/composables/useMessage';
import { useTerminalRun } from '@/composables/useTerminalRun';
import { tauriService } from '@/services/tauri';
import { useAppStore } from '@/store/app';
import { useEditorStore } from '@/store/editor';
import { useGitStore } from '@/store/git';
import type {
    ICommandTemplate,
    IEditorDocument,
    IExecutionEnvironment,
    IWorkspaceDirectoryPayload,
    TDocumentEncoding,
} from '@/types/editor';
import { desktopRuntimeReady, waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { toErrorMessage } from '@/utils/error';
import { getFileBaseName, isImageAssetPath } from '@/utils/file-assets';
import { getPathBaseName } from '@/utils/path';
import { COMMAND_TEMPLATES, COMMENT_TEMPLATES, DEFAULT_EXECUTOR } from '@/utils/templates';
import { computed } from 'vue';

const buildLogDetail = (title: string, detail: string): string => `${title}：${detail}`;

const EMPTY_ENVIRONMENT: IExecutionEnvironment = {
    recommended: DEFAULT_EXECUTOR,
    hasAny: false,
    executors: [],
};

const isTextDocument = (document: IEditorDocument): boolean => document.kind === 'text';

const getPathName = (path: string): string => getPathBaseName(path);

export const useWorkbench = () => {
    const appStore = useAppStore();
    const editorStore = useEditorStore();
    const gitStore = useGitStore();

    const canRun = computed(() => {
        if (!editorStore.hasActiveDocument || !isTextDocument(editorStore.document)) {
            return false;
        }

        if (editorStore.document.content.trim().length <= 0) {
            return false;
        }

        return editorStore.environment.hasAny;
    });

    const canSave = computed(
        () => editorStore.hasActiveDocument && isTextDocument(editorStore.document),
    );

    const refreshGitRepositoryStatus = async (
        workspaceRootPath: string | null = editorStore.workspaceRootPath,
    ): Promise<void> => {
        if (!workspaceRootPath) {
            gitStore.reset();
            return;
        }

        try {
            await gitStore.refreshRepositoryStatus(workspaceRootPath);
        } catch (error) {
            const message = toErrorMessage(error, '刷新 Git 状态失败');
            editorStore.appendLog('error', '刷新 Git 状态失败', message);
        }
    };

    const {
        buildDefaultScriptContent,
        formatDocumentWithShfmt,
        formatWorkspaceFileByPath,
        saveDocument,
        saveDocumentAs,
        saveDirtyDocuments,
    } = useDocumentPersistence({
        appStore,
        editorStore,
        refreshGitRepositoryStatus,
    });

    const {
        confirmCloseForDirtyDocuments,
        requestCloseDocument,
        requestCloseWorkspace,
        requestCloseApplication,
    } = useDocumentLifecycle({
        editorStore,
        gitStore,
        saveDocument,
        saveDirtyDocuments,
    });

    const {
        runScript,
        appendTerminalOutput,
        handleIntegratedTerminalRunComplete,
    } = useTerminalRun({
        canRun,
        editorStore,
    });

    const loadDocumentFromPath = async (path: string, scene: string): Promise<void> => {
        if (isImageAssetPath(path)) {
            const imageName = getFileBaseName(path);
            const result = editorStore.openImageDocument(path, imageName);

            if (result.reusedExisting) {
                editorStore.appendLog('info', scene, buildLogDetail('切换到已打开图片', path));
                useMessage().success(`已切换到 ${imageName}`);
                return;
            }

            editorStore.appendLog('success', scene, buildLogDetail('已加载图片', path));
            useMessage().success(`已打开图片 ${imageName}`);
            return;
        }

        const payload = await tauriService.loadScript(path);
        const result = editorStore.openDocumentTab(payload);

        if (result.reusedExisting) {
            editorStore.appendLog('info', scene, buildLogDetail('切换到已打开文件', payload.path));
            useMessage().success(`已切换到 ${payload.name}`);
            return;
        }

        editorStore.appendLog('success', scene, buildLogDetail('已加载文件', payload.path));
        useMessage().success(`已打开 ${payload.name}`);
    };

    const initialize = async (): Promise<{
        startupWorkspaceDirectory: IWorkspaceDirectoryPayload | null;
    }> => {
        let startupWorkspaceDirectory: IWorkspaceDirectoryPayload | null = null;

        const runtimeReady = await waitForDesktopRuntime();
        if (!runtimeReady) {
            gitStore.reset();
            editorStore.setEnvironment(EMPTY_ENVIRONMENT);
            editorStore.selectedExecutor = DEFAULT_EXECUTOR;
            editorStore.appendLog(
                'info',
                '浏览器预览模式',
                '当前界面运行在浏览器预览环境，默认执行方案为 WSL2，打开、保存与执行脚本仅在 Tauri 桌面端可用。',
            );
            return {
                startupWorkspaceDirectory,
            };
        }

        try {
            const environment = await tauriService.detectEnvironment();
            editorStore.setEnvironment(environment);
            editorStore.selectedExecutor = DEFAULT_EXECUTOR;
            editorStore.appendLog(
                environment.hasAny ? 'success' : 'error',
                '执行环境检测',
                environment.hasAny
                    ? '已检测到可用的 WSL2 运行环境。'
                    : '当前系统未发现可用的 WSL2 运行环境，建议先安装或启用 WSL2。',
            );
        } catch (error) {
            const message = toErrorMessage(error, '执行环境检测失败');
            editorStore.appendLog('error', '执行环境检测失败', message);
            useMessage().error(message);
        }

        try {
            const startupWorkspace = await tauriService.getStartupWorkspace();
            editorStore.setProtectedWorkspaceRootPaths(startupWorkspace.protectedRootPaths);

            try {
                startupWorkspaceDirectory = await tauriService.listWorkspaceEntries(
                    undefined,
                    startupWorkspace.rootPath,
                );
            } catch (error) {
                const message = toErrorMessage(error, '加载默认文件夹目录结构失败');
                editorStore.appendLog('error', '加载默认文件夹目录结构失败', message);
            }

            editorStore.setWorkspaceRootPath(startupWorkspace.rootPath);
            void refreshGitRepositoryStatus(startupWorkspace.rootPath);

            if (startupWorkspace.defaultFilePath) {
                await loadDocumentFromPath(startupWorkspace.defaultFilePath, '加载默认工作区');
            }
        } catch (error) {
            const message = toErrorMessage(error, '加载默认工作区失败');
            editorStore.appendLog('error', '加载默认工作区失败', message);
            useMessage().error(message);
        }

        return {
            startupWorkspaceDirectory,
        };
    };

    const createNewDocument = (): void => {
        const nextDocument = editorStore.createDocumentTab({
            content: buildDefaultScriptContent(),
        });
        editorStore.appendLog('info', '新建脚本', `已创建新的脚本草稿：${nextDocument.name}。`);
        useMessage().success('已创建新的脚本草稿');
    };

    const openDocument = async (): Promise<void> => {
        try {
            const path = await tauriService.pickOpenPath();
            if (!path) {
                return;
            }

            await loadDocumentFromPath(path, '打开脚本');
        } catch (error) {
            const message = toErrorMessage(error, '打开脚本失败');
            editorStore.appendLog('error', '打开脚本失败', message);
            useMessage().error(message);
        }
    };

    const openFolder = async (): Promise<void> => {
        try {
            const path = await tauriService.pickOpenFolderPath();
            if (!path) {
                return;
            }

            const dirtyDocuments = editorStore.dirtyDocuments;
            const action = await confirmCloseForDirtyDocuments(dirtyDocuments, 'switch-workspace');
            if (action === 'cancel') {
                return;
            }

            if (action === 'save') {
                const saved = await saveDirtyDocuments(dirtyDocuments.map((item) => item.id));
                if (!saved) {
                    return;
                }
            }

            editorStore.clearDocuments();
            editorStore.setWorkspaceRootPath(path);
            void refreshGitRepositoryStatus(path);
            editorStore.appendLog('success', '打开文件夹', buildLogDetail('资源目录', path));
            useMessage().success(`已打开文件夹 ${getPathName(path)}`);
        } catch (error) {
            const message = toErrorMessage(error, '打开文件夹失败');
            editorStore.appendLog('error', '打开文件夹失败', message);
            useMessage().error(message);
        }
    };

    const openDocumentByPath = async (path: string): Promise<void> => {
        try {
            const existingDocument = editorStore.findDocumentByPath(path);
            if (existingDocument) {
                editorStore.setActiveDocument(existingDocument.id);
                useMessage().success(`已切换到 ${existingDocument.name}`);
                return;
            }

            await loadDocumentFromPath(path, '资源管理器打开文件');
        } catch (error) {
            const message = toErrorMessage(error, '打开资源文件失败');
            editorStore.appendLog('error', '打开资源文件失败', message);
            useMessage().error(message);
        }
    };

    const activateDocument = (documentId: string): void => {
        editorStore.setActiveDocument(documentId);
    };

    const updateContent = (value: string): void => {
        editorStore.updateActiveDocumentContent(value);
    };

    const updateEncoding = (value: TDocumentEncoding): void => {
        if (!editorStore.hasActiveDocument) {
            return;
        }

        editorStore.updateActiveDocumentEncoding(value);
        editorStore.appendLog('info', '切换编码', `当前编码已切换为 ${value.toUpperCase()}。`);
    };

    const toggleTheme = (): void => {
        appStore.applyTheme(appStore.theme === 'dark' ? 'light' : 'dark');
    };

    const notifyTemplateInserted = (template: ICommandTemplate): void => {
        editorStore.appendLog('info', '插入模板', `已插入模板：${template.title}`);
        useMessage().success(`已插入 ${template.title}`);
    };

    return {
        appStore,
        editorStore,
        isDesktopRuntime: computed(() => desktopRuntimeReady.value),
        canRun,
        canSave,
        commandTemplates: COMMAND_TEMPLATES,
        commentTemplates: COMMENT_TEMPLATES,
        initialize,
        createNewDocument,
        openDocument,
        openFolder,
        openDocumentByPath,
        formatDocumentWithShfmt,
        formatWorkspaceFileByPath,
        saveDocument,
        saveDocumentAs,
        requestCloseDocument,
        requestCloseWorkspace,
        requestCloseApplication,
        activateDocument,
        runScript,
        handleIntegratedTerminalRunComplete,
        updateContent,
        appendTerminalOutput,
        updateEncoding,
        toggleTheme,
        notifyTemplateInserted,
    };
};

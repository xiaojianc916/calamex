#!/usr/bin/env node
// apply-git-fixes.mjs — git 相关精读修复
// 用法:
//   node apply-git-fixes.mjs "<工作区根目录>" --dry   # 预演,不写文件
//   node apply-git-fixes.mjs "<工作区根目录>"          # 实际写入(自动生成 .bak)
//
// 覆盖:
//   G1  误报成功 toast(并发被 runWithPending 跳过仍提示成功)
//   G2  写操作未让 in-flight refreshRepositoryStatus 作废,可能被旧 payload 覆盖
//   G3  handleInitRepository 三重校验 + 冗余二次刷新,删除重复断言
//   G4  移除 no-op 的 markStatusSynced(接口 + 全部调用点)
//   G5b stage/unstage/discard 批量处理函数去重
//   G6  全局 window 监听器从 setup 顶层移入 onMounted
//   G7  重复 computed(discardableEntries === stageableEntries)复用
//   G8  tauri.git 写操作统一 timeoutMs

import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const dryRun = process.argv.includes('--dry');

if (!root || root.startsWith('--')) {
  console.error('用法: node apply-git-fixes.mjs "<工作区根目录>" [--dry]');
  process.exit(1);
}

const edits = [
  {
    file: 'src/composables/useSourceControlActions.ts',
    blocks: [
      {
        id: 'G3-imports',
        find: [
          "import type { IGitFileStatusPayload, IGitRepositoryStatusPayload } from '@/types/git';",
          "import { toErrorMessage } from '@/utils/error';",
          "import { areFileSystemPathsEqual } from '@/utils/path';",
          "import type { TGitSectionKey } from './useSourceControlContextMenu';",
        ].join('\n'),
        replace: [
          "import type { IGitFileStatusPayload } from '@/types/git';",
          "import { toErrorMessage } from '@/utils/error';",
          "import type { TGitSectionKey } from './useSourceControlContextMenu';",
        ].join('\n'),
      },
      {
        id: 'G3-remove-assert',
        find: [
          'const collectPaths = (entries: IGitFileStatusPayload[]): string[] =>',
          '  entries.map((entry) => entry.path);',
          '',
          'const assertWorkspaceRepositoryReady = (',
          '  payload: IGitRepositoryStatusPayload,',
          '  workspaceRootPath: string,',
          '): void => {',
          '  if (!payload.available || !payload.repositoryRootPath) {',
          "    throw new Error(payload.message ?? 'Git 初始化后仍未检测到仓库。');",
          '  }',
          '',
          '  if (!areFileSystemPathsEqual(payload.repositoryRootPath, workspaceRootPath)) {',
          '    throw new Error(',
          '      `Git 仓库根目录与当前工作区不一致：当前工作区 ${workspaceRootPath}，检测到 ${payload.repositoryRootPath}。`,',
          '    );',
          '  }',
          '};',
          '',
          'export const useSourceControlActions = (options: IUseSourceControlActionsOptions) => {',
        ].join('\n'),
        replace: [
          'const collectPaths = (entries: IGitFileStatusPayload[]): string[] =>',
          '  entries.map((entry) => entry.path);',
          '',
          'export const useSourceControlActions = (options: IUseSourceControlActionsOptions) => {',
        ].join('\n'),
      },
      {
        id: 'G4-interface',
        find: [
          '  runWithPending: (key: string, task: () => Promise<void>) => Promise<boolean>;',
          '  markStatusSynced: () => void;',
          '  setSourceControlActionError: (value: string | null) => void;',
        ].join('\n'),
        replace: [
          '  runWithPending: (key: string, task: () => Promise<void>) => Promise<boolean>;',
          '  setSourceControlActionError: (value: string | null) => void;',
        ].join('\n'),
      },
      {
        id: 'G1-G5b-bulk-handlers',
        find: [
          '  const handleStageAll = async (): Promise<void> => {',
          '    const paths = collectPaths(options.getStageableEntries());',
          '    if (paths.length === 0) {',
          "      options.message.info('没有可暂存的变更。');",
          '      return;',
          '    }',
          '',
          '    try {',
          "      await options.runWithPending('stage-all', async () => {",
          '        await options.gitStore.stagePaths(paths);',
          '      });',
          '      options.markStatusSynced();',
          '      options.message.success(`已暂存 ${paths.length} 项变更`);',
          '    } catch (error) {',
          "      options.message.error(toErrorMessage(error, '暂存全部变更失败'));",
          '    }',
          '  };',
          '',
          '  const handleUnstageAll = async (): Promise<void> => {',
          '    const paths = options.getStagedPaths();',
          '    if (paths.length === 0) {',
          "      options.message.info('没有已暂存的变更。');",
          '      return;',
          '    }',
          '',
          '    try {',
          "      await options.runWithPending('unstage-all', async () => {",
          '        await options.gitStore.unstagePaths(paths);',
          '      });',
          '      options.markStatusSynced();',
          '      options.message.success(`已取消暂存 ${paths.length} 项变更`);',
          '    } catch (error) {',
          "      options.message.error(toErrorMessage(error, '取消暂存全部变更失败'));",
          '    }',
          '  };',
          '',
          '  const handleDiscardAll = async (): Promise<void> => {',
          '    const paths = collectPaths(options.getDiscardableEntries());',
          '    if (paths.length === 0) {',
          "      options.message.info('没有可放弃的未暂存更改。');",
          '      return;',
          '    }',
          '',
          '    const confirmed = await confirmDangerAction({',
          "      title: '放弃所有未暂存更改？',",
          '      description: `将丢弃 ${paths.length} 项工作区更改；未跟踪文件会被删除。此操作无法撤销。`,',
          "      confirmText: '放弃更改',",
          '    });',
          '    if (!confirmed) {',
          '      return;',
          '    }',
          '',
          '    try {',
          "      await options.runWithPending('discard-all', async () => {",
          '        await options.gitStore.discardPaths(paths);',
          '      });',
          '      options.markStatusSynced();',
          '      options.message.success(`已放弃 ${paths.length} 项未暂存更改`);',
          '    } catch (error) {',
          "      options.message.error(toErrorMessage(error, '放弃未暂存更改失败'));",
          '    }',
          '  };',
          '',
          '  const handleInitRepository',
        ].join('\n'),
        replace: [
          '  const runBulkPathsAction = async (config: {',
          '    paths: string[];',
          '    emptyMessage: string;',
          '    pendingKey: string;',
          '    mutate: (paths: string[]) => Promise<unknown>;',
          '    successMessage: (count: number) => string;',
          '    errorMessage: string;',
          '    confirm?: () => Promise<boolean>;',
          '  }): Promise<void> => {',
          '    if (config.paths.length === 0) {',
          '      options.message.info(config.emptyMessage);',
          '      return;',
          '    }',
          '',
          '    if (config.confirm && !(await config.confirm())) {',
          '      return;',
          '    }',
          '',
          '    try {',
          '      const didRun = await options.runWithPending(config.pendingKey, async () => {',
          '        await config.mutate(config.paths);',
          '      });',
          '      if (!didRun) {',
          '        return;',
          '      }',
          '      options.message.success(config.successMessage(config.paths.length));',
          '    } catch (error) {',
          '      options.message.error(toErrorMessage(error, config.errorMessage));',
          '    }',
          '  };',
          '',
          '  const handleStageAll = (): Promise<void> =>',
          '    runBulkPathsAction({',
          '      paths: collectPaths(options.getStageableEntries()),',
          "      emptyMessage: '没有可暂存的变更。',",
          "      pendingKey: 'stage-all',",
          '      mutate: (paths) => options.gitStore.stagePaths(paths),',
          '      successMessage: (count) => `已暂存 ${count} 项变更`,',
          "      errorMessage: '暂存全部变更失败',",
          '    });',
          '',
          '  const handleUnstageAll = (): Promise<void> =>',
          '    runBulkPathsAction({',
          '      paths: options.getStagedPaths(),',
          "      emptyMessage: '没有已暂存的变更。',",
          "      pendingKey: 'unstage-all',",
          '      mutate: (paths) => options.gitStore.unstagePaths(paths),',
          '      successMessage: (count) => `已取消暂存 ${count} 项变更`,',
          "      errorMessage: '取消暂存全部变更失败',",
          '    });',
          '',
          '  const handleDiscardAll = (): Promise<void> => {',
          '    const paths = collectPaths(options.getDiscardableEntries());',
          '    return runBulkPathsAction({',
          '      paths,',
          "      emptyMessage: '没有可放弃的未暂存更改。',",
          "      pendingKey: 'discard-all',",
          '      mutate: (entries) => options.gitStore.discardPaths(entries),',
          '      successMessage: (count) => `已放弃 ${count} 项未暂存更改`,',
          "      errorMessage: '放弃未暂存更改失败',",
          '      confirm: () =>',
          '        confirmDangerAction({',
          "          title: '放弃所有未暂存更改？',",
          '          description: `将丢弃 ${paths.length} 项工作区更改；未跟踪文件会被删除。此操作无法撤销。`,',
          "          confirmText: '放弃更改',",
          '        }),',
          '    });',
          '  };',
          '',
          '  const handleInitRepository',
        ].join('\n'),
      },
      {
        id: 'G3-G4-initRepository',
        find: [
          '    try {',
          "      const didRun = await options.runWithPending('init-repository', async () => {",
          '        const initializedStatus = await options.gitStore.initRepository(workspaceRootPath);',
          '        assertWorkspaceRepositoryReady(initializedStatus, workspaceRootPath);',
          '',
          '        const refreshedStatus = await options.gitStore.refreshRepositoryStatus(workspaceRootPath);',
          '        assertWorkspaceRepositoryReady(refreshedStatus, workspaceRootPath);',
          '      });',
          '',
          '      if (!didRun) {',
          '        return;',
          '      }',
          '',
          '      options.markStatusSynced();',
          "      options.message.success('Git 仓库已初始化');",
        ].join('\n'),
        replace: [
          '    try {',
          "      const didRun = await options.runWithPending('init-repository', async () => {",
          '        // gitStore.initRepository 内部已通过 assertInitializedRepositoryStatus 校验,',
          '        // 并返回最新仓库状态,无需再次刷新或在此重复断言。',
          '        await options.gitStore.initRepository(workspaceRootPath);',
          '      });',
          '',
          '      if (!didRun) {',
          '        return;',
          '      }',
          '',
          "      options.message.success('Git 仓库已初始化');",
        ].join('\n'),
      },
      {
        id: 'G4-commit',
        find: [
          "      await options.runWithPending('commit', async () => {",
          '        const result = await options.gitStore.commitIndex(nextCommitMessage);',
          "        options.setCommitMessage('');",
          '        options.markStatusSynced();',
          "        options.message.success(`已创建提交 ${result.commitId?.slice(0, 7) ?? ''}`);",
          '      });',
        ].join('\n'),
        replace: [
          "      await options.runWithPending('commit', async () => {",
          '        const result = await options.gitStore.commitIndex(nextCommitMessage);',
          "        options.setCommitMessage('');",
          "        options.message.success(`已创建提交 ${result.commitId?.slice(0, 7) ?? ''}`);",
          '      });',
        ].join('\n'),
      },
      {
        id: 'G1-discardEntry',
        find: [
          '    try {',
          '      await options.runWithPending(`discard:${entry.path}`, async () => {',
          '        await options.gitStore.discardPaths([entry.path]);',
          '      });',
          '      options.markStatusSynced();',
          '      options.message.success(`已放弃更改 ${entry.fileName}`);',
          '    } catch (error) {',
          '      options.message.error(toErrorMessage(error, `放弃更改 ${entry.fileName} 失败`));',
          '    }',
        ].join('\n'),
        replace: [
          '    try {',
          '      const didRun = await options.runWithPending(`discard:${entry.path}`, async () => {',
          '        await options.gitStore.discardPaths([entry.path]);',
          '      });',
          '      if (!didRun) {',
          '        return;',
          '      }',
          '      options.message.success(`已放弃更改 ${entry.fileName}`);',
          '    } catch (error) {',
          '      options.message.error(toErrorMessage(error, `放弃更改 ${entry.fileName} 失败`));',
          '    }',
        ].join('\n'),
      },
      {
        id: 'G1-sectionAction',
        find: [
          '    try {',
          "      if (sectionKey === 'staged') {",
          '        await options.runWithPending(`unstage:${entry.path}`, async () => {',
          '          await options.gitStore.unstagePaths([entry.path]);',
          '        });',
          '        options.markStatusSynced();',
          '        options.message.success(`已取消暂存 ${entry.fileName}`);',
          '        return;',
          '      }',
          '',
          '      await options.runWithPending(`stage:${entry.path}`, async () => {',
          '        await options.gitStore.stagePaths([entry.path]);',
          '      });',
          '      options.markStatusSynced();',
          '      options.message.success(`已暂存 ${entry.fileName}`);',
          '    } catch (error) {',
          "      options.message.error(toErrorMessage(error, 'Git 变更操作失败'));",
          '    }',
        ].join('\n'),
        replace: [
          '    try {',
          "      if (sectionKey === 'staged') {",
          '        const didRun = await options.runWithPending(`unstage:${entry.path}`, async () => {',
          '          await options.gitStore.unstagePaths([entry.path]);',
          '        });',
          '        if (!didRun) {',
          '          return;',
          '        }',
          '        options.message.success(`已取消暂存 ${entry.fileName}`);',
          '        return;',
          '      }',
          '',
          '      const didRun = await options.runWithPending(`stage:${entry.path}`, async () => {',
          '        await options.gitStore.stagePaths([entry.path]);',
          '      });',
          '      if (!didRun) {',
          '        return;',
          '      }',
          '      options.message.success(`已暂存 ${entry.fileName}`);',
          '    } catch (error) {',
          "      options.message.error(toErrorMessage(error, 'Git 变更操作失败'));",
          '    }',
        ].join('\n'),
      },
    ],
  },
  {
    file: 'src/store/git.ts',
    blocks: [
      {
        id: 'G2-helper',
        find: [
          '  const applyStatus = (payload: IGitRepositoryStatusPayload): IGitRepositoryStatusPayload => {',
          '    const previousRepositoryRoot = normalizeFileSystemPath(status.value.repositoryRootPath);',
          '    const nextRepositoryRoot = normalizeFileSystemPath(payload.repositoryRootPath);',
          '    status.value = payload;',
          '    if (previousRepositoryRoot !== nextRepositoryRoot || !payload.available) {',
          '      clearBaselineCache();',
          '      resetSupplementaryData();',
          '    }',
          '    return payload;',
          '  };',
        ].join('\n'),
        replace: [
          '  const applyStatus = (payload: IGitRepositoryStatusPayload): IGitRepositoryStatusPayload => {',
          '    const previousRepositoryRoot = normalizeFileSystemPath(status.value.repositoryRootPath);',
          '    const nextRepositoryRoot = normalizeFileSystemPath(payload.repositoryRootPath);',
          '    status.value = payload;',
          '    if (previousRepositoryRoot !== nextRepositoryRoot || !payload.available) {',
          '      clearBaselineCache();',
          '      resetSupplementaryData();',
          '    }',
          '    return payload;',
          '  };',
          '',
          '  /**',
          '   * 写操作(stage/unstage/discard/commit/branch/stash)落盘的状态即最新真值。',
          '   * 通过 ++statusRequestId 把任何 in-flight 的 refreshRepositoryStatus 标记为 stale,',
          '   * 防止其稍后 resolve 时用过期 payload 覆盖刚写入的状态;同时把可能残留的',
          '   * isLoading 归位(被作废的那次 refresh 不会再进入自己的 finally 重置分支)。',
          '   */',
          '  const applyStatusFromMutation = (',
          '    payload: IGitRepositoryStatusPayload,',
          '  ): IGitRepositoryStatusPayload => {',
          '    statusRequestId += 1;',
          '    isLoading.value = false;',
          '    return applyStatus(payload);',
          '  };',
        ].join('\n'),
      },
      {
        id: 'G2-pathsMutation',
        find: [
          '    onSuccess?.(deduplicatedPaths);',
          '    return applyStatus(payload);',
        ].join('\n'),
        replace: [
          '    onSuccess?.(deduplicatedPaths);',
          '    return applyStatusFromMutation(payload);',
        ].join('\n'),
      },
      {
        id: 'G2-commitIndex',
        find: '      applyStatus(payload.status);',
        replace: '      applyStatusFromMutation(payload.status);',
      },
      {
        id: 'G2-checkoutBranch',
        find: [
          '    clearBaselineCache();',
          '    resetBranches();',
          '    return applyStatus(payload);',
        ].join('\n'),
        replace: [
          '    clearBaselineCache();',
          '    resetBranches();',
          '    return applyStatusFromMutation(payload);',
        ].join('\n'),
      },
      {
        id: 'G2-createBranch',
        find: [
          '    if (checkout) {',
          '      clearBaselineCache();',
          '    }',
          '    resetBranches();',
          '    return applyStatus(payload);',
        ].join('\n'),
        replace: [
          '    if (checkout) {',
          '      clearBaselineCache();',
          '    }',
          '    resetBranches();',
          '    return applyStatusFromMutation(payload);',
        ].join('\n'),
      },
      {
        id: 'G2-saveStash',
        find: [
          '      includeUntracked,',
          '    });',
          '    clearBaselineCache();',
          '    resetStashes();',
          '    return applyStatus(payload);',
        ].join('\n'),
        replace: [
          '      includeUntracked,',
          '    });',
          '    clearBaselineCache();',
          '    resetStashes();',
          '    return applyStatusFromMutation(payload);',
        ].join('\n'),
      },
      {
        id: 'G2-applyStash',
        find: [
          '      pop,',
          '    });',
          '    clearBaselineCache();',
          '    resetStashes();',
          '    return applyStatus(payload);',
        ].join('\n'),
        replace: [
          '      pop,',
          '    });',
          '    clearBaselineCache();',
          '    resetStashes();',
          '    return applyStatusFromMutation(payload);',
        ].join('\n'),
      },
      {
        id: 'G2-dropStash',
        find: [
          '      stashIndex,',
          '    });',
          '    resetStashes();',
          '    return applyStatus(payload);',
        ].join('\n'),
        replace: [
          '      stashIndex,',
          '    });',
          '    resetStashes();',
          '    return applyStatusFromMutation(payload);',
        ].join('\n'),
      },
    ],
  },
  {
    file: 'src/services/tauri.git.ts',
    blocks: [
      {
        id: 'G8-stage',
        find: [
          "        command: 'stage_git_paths',",
          "        guardHint: '暂存 Git 变更',",
          '        input: payload,',
        ].join('\n'),
        replace: [
          "        command: 'stage_git_paths',",
          "        guardHint: '暂存 Git 变更',",
          '        timeoutMs: 20_000,',
          '        input: payload,',
        ].join('\n'),
      },
      {
        id: 'G8-unstage',
        find: [
          "        command: 'unstage_git_paths',",
          "        guardHint: '取消暂存 Git 变更',",
          '        input: payload,',
        ].join('\n'),
        replace: [
          "        command: 'unstage_git_paths',",
          "        guardHint: '取消暂存 Git 变更',",
          '        timeoutMs: 20_000,',
          '        input: payload,',
        ].join('\n'),
      },
      {
        id: 'G8-discard',
        find: [
          "        command: 'discard_git_paths',",
          "        guardHint: '放弃 Git 工作区更改',",
          "        audit: 'sensitive',",
          '        input: payload,',
        ].join('\n'),
        replace: [
          "        command: 'discard_git_paths',",
          "        guardHint: '放弃 Git 工作区更改',",
          "        audit: 'sensitive',",
          '        timeoutMs: 20_000,',
          '        input: payload,',
        ].join('\n'),
      },
      {
        id: 'G8-commit',
        find: [
          "        command: 'commit_git_index',",
          "        guardHint: '创建 Git 提交',",
          "        audit: 'sensitive',",
          '        input: payload,',
        ].join('\n'),
        replace: [
          "        command: 'commit_git_index',",
          "        guardHint: '创建 Git 提交',",
          "        audit: 'sensitive',",
          '        timeoutMs: 20_000,',
          '        input: payload,',
        ].join('\n'),
      },
    ],
  },
  {
    file: 'src/components/workbench/SourceControlPanel.vue',
    blocks: [
      {
        id: 'G6-import',
        find: "import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';",
        replace: "import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';",
      },
      {
        id: 'G4-def',
        find: [
          'const markStatusSynced = (): void => {',
          '  // no-op: keep callback contract with action/composable layers',
          '};',
          '',
          'const runWithPending = async (key: string, task: () => Promise<void>): Promise<boolean> => {',
        ].join('\n'),
        replace: 'const runWithPending = async (key: string, task: () => Promise<void>): Promise<boolean> => {',
      },
      {
        id: 'G4-sync',
        find: [
          '    if (!didRun) {',
          '      return;',
          '    }',
          '',
          '    markStatusSynced();',
          '',
          "    if (hasRepository.value && activeTab.value !== 'changes') {",
        ].join('\n'),
        replace: [
          '    if (!didRun) {',
          '      return;',
          '    }',
          '',
          "    if (hasRepository.value && activeTab.value !== 'changes') {",
        ].join('\n'),
      },
      {
        id: 'G4-options',
        find: [
          '  runWithPending,',
          '  markStatusSynced,',
          '  setSourceControlActionError: (value) => {',
        ].join('\n'),
        replace: [
          '  runWithPending,',
          '  setSourceControlActionError: (value) => {',
        ].join('\n'),
      },
      {
        id: 'G4-createBranch',
        find: [
          '    markStatusSynced();',
          '    message.success(`已创建并切换到 ${branchName}`);',
        ].join('\n'),
        replace: '    message.success(`已创建并切换到 ${branchName}`);',
      },
      {
        id: 'G4-checkout',
        find: [
          '    markStatusSynced();',
          '    message.success(`已切换到 ${entry.shorthand}`);',
        ].join('\n'),
        replace: '    message.success(`已切换到 ${entry.shorthand}`);',
      },
      {
        id: 'G4-saveStash',
        find: [
          '    markStatusSynced();',
          "    message.success('当前改动已保存到 Git 贮藏');",
        ].join('\n'),
        replace: "    message.success('当前改动已保存到 Git 贮藏');",
      },
      {
        id: 'G4-applyStash',
        find: [
          '    markStatusSynced();',
          '    message.success(pop ? `已弹出 ${entry.stashId}` : `已应用 ${entry.stashId}`);',
        ].join('\n'),
        replace: '    message.success(pop ? `已弹出 ${entry.stashId}` : `已应用 ${entry.stashId}`);',
      },
      {
        id: 'G4-dropStash',
        find: [
          '    markStatusSynced();',
          '    message.success(`已删除 ${entry.stashId}`);',
        ].join('\n'),
        replace: '    message.success(`已删除 ${entry.stashId}`);',
      },
      {
        id: 'G7-dedup-computed',
        find: [
          'const stageableEntries = computed(() => [...changedEntries.value, ...untrackedEntries.value]);',
          'const discardableEntries = computed(() => [...changedEntries.value, ...untrackedEntries.value]);',
        ].join('\n'),
        replace: [
          'const stageableEntries = computed(() => [...changedEntries.value, ...untrackedEntries.value]);',
          '// 放弃全部的目标集合与可暂存集合完全一致(已跟踪改动 + 未跟踪文件),复用同一个 computed。',
          'const discardableEntries = stageableEntries;',
        ].join('\n'),
      },
      {
        id: 'G6-listeners',
        find: [
          "if (typeof window !== 'undefined') {",
          "  window.addEventListener('pointerdown', handleWindowPointerDown, true);",
          "  window.addEventListener('keydown', handleWindowKeydown);",
          "  window.addEventListener('resize', handleWindowResize);",
          "  window.addEventListener('blur', handleWindowResize);",
          '}',
          '',
          'onBeforeUnmount(() => {',
        ].join('\n'),
        replace: [
          'onMounted(() => {',
          "  if (typeof window === 'undefined') {",
          '    return;',
          '  }',
          '',
          "  window.addEventListener('pointerdown', handleWindowPointerDown, true);",
          "  window.addEventListener('keydown', handleWindowKeydown);",
          "  window.addEventListener('resize', handleWindowResize);",
          "  window.addEventListener('blur', handleWindowResize);",
          '});',
          '',
          'onBeforeUnmount(() => {',
        ].join('\n'),
      },
    ],
  },
];

let totalHit = 0;
let totalMiss = 0;
const failures = [];

for (const { file, blocks } of edits) {
  const abs = path.join(root, ...file.split('/'));
  if (!fs.existsSync(abs)) {
    console.error(`✗ ${file}: 文件不存在`);
    for (const b of blocks) failures.push(`${file} :: ${b.id}`);
    totalMiss += blocks.length;
    continue;
  }

  const original = fs.readFileSync(abs, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const normalized = eol === '\n' ? original : original.replace(/\r\n/g, '\n');
  let working = normalized;
  let fileHit = 0;
  let fileMiss = 0;

  console.log(`\n# ${file} (EOL=${eol === '\r\n' ? 'CRLF' : 'LF'})`);
  for (const block of blocks) {
    const occurrences = working.split(block.find).length - 1;
    if (occurrences === 0) {
      console.error(`  ✗ [${block.id}] 未找到匹配`);
      failures.push(`${file} :: ${block.id}`);
      fileMiss += 1;
      continue;
    }
    if (occurrences > 1 && !block.all) {
      console.error(`  ✗ [${block.id}] 匹配到 ${occurrences} 处,需唯一,已跳过`);
      failures.push(`${file} :: ${block.id} (${occurrences} 处)`);
      fileMiss += 1;
      continue;
    }
    working = working.split(block.find).join(block.replace);
    console.log(`  ✓ [${block.id}] 命中 ${occurrences} 处`);
    fileHit += 1;
  }

  totalHit += fileHit;
  totalMiss += fileMiss;

  if (working !== normalized) {
    const output = eol === '\n' ? working : working.replace(/\n/g, eol);
    if (dryRun) {
      console.log(`  〔dry〕将更新(${fileHit} 命中 / ${fileMiss} 失败)`);
    } else {
      fs.writeFileSync(`${abs}.bak`, original, 'utf8');
      fs.writeFileSync(abs, output, 'utf8');
      console.log(`  ✔ 已写入(${fileHit} 命中 / ${fileMiss} 失败,备份 ${path.basename(abs)}.bak)`);
    }
  } else {
    console.log(`  — 无改动(${fileHit} 命中 / ${fileMiss} 失败)`);
  }
}

console.log(`\n=== 汇总: 命中 ${totalHit} / 失败 ${totalMiss} ===`);
if (failures.length > 0) {
  console.log('失败块:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(dryRun ? 0 : 1);
}
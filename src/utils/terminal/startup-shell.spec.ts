import { describe, expect, it } from 'vitest';
import type { TSessionSnapshot } from '@/types/session';
import { createStartupShellState } from '@/utils/terminal/startup-shell';

const createSnapshot = (overrides: Partial<TSessionSnapshot> = {}): TSessionSnapshot => ({
  schemaVersion: 1,
  workspaceRoot: null,
  openTabs: [],
  activeTabPath: null,
  viewStates: [],
  workbench: {
    activeSidebarView: 'explorer',
    explorerExpandedPaths: [],
    explorerSelectedPath: null,
    isTerminalVisible: true,
  },
  recentWorkspaces: [],
  recentFiles: [],
  savedAt: '2026-05-07T00:00:00.000Z',
  ...overrides,
});

describe('createStartupShellState', () => {
  it('从会话快照生成首帧结构状态', () => {
    const state = createStartupShellState(
      createSnapshot({
        workspaceRoot: 'D:/workspace/demo',
        workbench: {
          activeSidebarView: 'source-control',
          explorerExpandedPaths: ['D:/workspace/demo', 'D:/workspace/demo/src'],
          explorerSelectedPath: 'D:/workspace/demo/src/main.sh',
          isTerminalVisible: false,
        },
        openTabs: [
          { path: 'D:/workspace/demo/b.png', pinned: false, order: 1, kind: 'image' },
          { path: 'D:/workspace/demo/a.sh', pinned: false, order: 0, kind: 'text' },
        ],
        activeTabPath: 'D:/workspace/demo/b.png',
      }),
    );

    expect(state).toEqual({
      schemaVersion: 1,
      workspaceRoot: 'D:/workspace/demo',
      workspaceName: 'demo',
      activeSidebarView: 'source-control',
      explorerExpandedPaths: ['D:/workspace/demo', 'D:/workspace/demo/src'],
      explorerSelectedPath: 'D:/workspace/demo/src/main.sh',
      isTerminalVisible: false,
      activeTabPath: 'D:/workspace/demo/b.png',
      openTabs: [
        {
          id: '0-d:/workspace/demo/a.sh',
          path: 'D:/workspace/demo/a.sh',
          title: 'a.sh',
          kind: 'text',
          order: 0,
          isActive: false,
        },
        {
          id: '1-d:/workspace/demo/b.png',
          path: 'D:/workspace/demo/b.png',
          title: 'b.png',
          kind: 'image',
          order: 1,
          isActive: true,
        },
      ],
    });
  });

  it('活动标签失效时回退到排序后的第一个标签', () => {
    const state = createStartupShellState(
      createSnapshot({
        openTabs: [
          { path: '/tmp/z.sh', pinned: false, order: 9 },
          { path: '/tmp/a.sh', pinned: false, order: 1 },
        ],
        activeTabPath: '/tmp/missing.sh',
      }),
    );

    expect(state?.activeTabPath).toBe('/tmp/a.sh');
    expect(state?.explorerSelectedPath).toBe('/tmp/a.sh');
    expect(state?.openTabs.map((tab) => [tab.title, tab.isActive])).toEqual([
      ['a.sh', true],
      ['z.sh', false],
    ]);
  });

  it('没有工作区和标签时生成默认启动骨架', () => {
    expect(createStartupShellState(createSnapshot())).toEqual({
      schemaVersion: 1,
      workspaceRoot: null,
      workspaceName: null,
      activeSidebarView: 'explorer',
      explorerExpandedPaths: [],
      explorerSelectedPath: null,
      isTerminalVisible: true,
      openTabs: [],
      activeTabPath: null,
    });
  });
});

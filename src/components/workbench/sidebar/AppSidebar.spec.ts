import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { TWorkbenchSidebarView } from '@/types/app';
import type { IEditorDocument } from '@/types/editor';
import AppSidebar from './AppSidebar.vue';

const panelMounts = vi.hoisted(() => ({
  explorer: 0,
  search: 0,
  sourceControl: 0,
  run: 0,
  ssh: 0,
}));

vi.mock('@/components/workbench/sidebar/explorer/WorkspaceExplorerPanel.vue', () => ({
  default: {
    name: 'WorkspaceExplorerPanel',
    props: ['isActive'],
    mounted() {
      panelMounts.explorer += 1;
    },
    template:
      '<section data-testid="explorer-panel" :data-active="String(isActive)" :style="{ display: isActive === false ? \'none\' : \'\' }">Explorer</section>',
  },
}));

vi.mock('@/components/workbench/sidebar/source-control/SourceControlPanel.vue', () => ({
  default: {
    name: 'SourceControlPanel',
    props: ['isActive'],
    mounted() {
      panelMounts.sourceControl += 1;
    },
    template:
      '<section data-testid="source-control-panel" :data-active="String(isActive)" :style="{ display: isActive === false ? \'none\' : \'\' }">Source Control</section>',
  },
}));

vi.mock('@/components/workbench/sidebar/search/SearchSidebarPanel.vue', () => ({
  default: {
    name: 'SearchSidebarPanel',
    props: ['isActive'],
    data() {
      return { query: '' };
    },
    mounted() {
      panelMounts.search += 1;
    },
    template:
      '<section data-testid="search-panel" :data-active="String(isActive)" :style="{ display: isActive === false ? \'none\' : \'\' }"><input data-testid="search-query" v-model="query" /></section>',
  },
}));

vi.mock('@/components/workbench/sidebar/run/RunSidebarPanel.vue', () => ({
  default: {
    name: 'RunSidebarPanel',
    props: ['isActive'],
    mounted() {
      panelMounts.run += 1;
    },
    template:
      '<section data-testid="run-panel" :data-active="String(isActive)" :style="{ display: isActive === false ? \'none\' : \'\' }">Run</section>',
  },
}));

vi.mock('@/components/workbench/sidebar/ssh/SshSidebarPanel.vue', () => ({
  default: {
    name: 'SshSidebarPanel',
    props: ['isActive'],
    mounted() {
      panelMounts.ssh += 1;
    },
    template:
      '<section data-testid="ssh-panel" :data-active="String(isActive)" :style="{ display: isActive === false ? \'none\' : \'\' }">SSH</section>',
  },
}));

const createDocument = (): IEditorDocument => ({
  id: 'doc-1',
  kind: 'text',
  name: 'script.sh',
  path: '/workspace/script.sh',
  content: '#!/bin/bash\necho ok',
  savedContent: '#!/bin/bash\necho ok',
  encoding: 'utf-8',
  savedEncoding: 'utf-8',
  lineCount: 2,
  charCount: 19,
  isDirty: false,
  bufferLoaded: true,
});

const createProps = (view: TWorkbenchSidebarView) => ({
  document: createDocument(),
  view,
  isDesktopRuntime: true,
  workspaceRootPath: '/workspace',
  preloadedWorkspaceRoot: null,
  startupExplorerExpandedPaths: [],
  startupExplorerSelectedPath: null,
  canRun: true,
  isRunning: false,
  hasRunArtifacts: false,
  activeRun: null,
  runHistory: [],
  commandTemplates: [],
  executor: 'wsl' as const,
});

const mountSidebar = async (view: TWorkbenchSidebarView = 'explorer') => {
  const wrapper = mount(AppSidebar, {
    props: createProps(view),
  });
  await flushPromises();
  await nextTick();
  return wrapper;
};

const expectOnlyPanelVisible = (
  wrapper: ReturnType<typeof mount>,
  active: TWorkbenchSidebarView,
) => {
  const visibilityByView: Record<Exclude<TWorkbenchSidebarView, 'ai'>, string> = {
    explorer: 'explorer-panel',
    search: 'search-panel',
    'source-control': 'source-control-panel',
    run: 'run-panel',
    extensions: 'ssh-panel',
  };

  for (const [view, testId] of Object.entries(visibilityByView) as Array<
    [Exclude<TWorkbenchSidebarView, 'ai'>, string]
  >) {
    const panel = wrapper.find(`[data-testid="${testId}"]`);
    expect(panel.exists(), `${view} panel should stay mounted`).toBe(true);
    expect(panel.attributes('data-active'), `${view} panel active flag`).toBe(
      String(view === active),
    );
  }
};

describe('AppSidebar persistent panel switching', () => {
  beforeEach(() => {
    panelMounts.explorer = 0;
    panelMounts.search = 0;
    panelMounts.sourceControl = 0;
    panelMounts.run = 0;
    panelMounts.ssh = 0;
  });

  it('mounts all sidebar panels once so switching is v-show only', async () => {
    const wrapper = await mountSidebar('explorer');
    expect(panelMounts).toEqual({
      explorer: 1,
      search: 1,
      sourceControl: 1,
      run: 1,
      ssh: 1,
    });
    expectOnlyPanelVisible(wrapper, 'explorer');
  });

  it('does not remount heavy panels during repeated sidebar switches', async () => {
    const wrapper = await mountSidebar('explorer');
    const sequence: TWorkbenchSidebarView[] = [
      'search',
      'source-control',
      'run',
      'extensions',
      'explorer',
      'search',
      'extensions',
      'source-control',
      'explorer',
    ];

    for (const view of sequence) {
      await wrapper.setProps({ view });
      await flushPromises();
      await nextTick();
      expectOnlyPanelVisible(wrapper, view);
    }

    expect(panelMounts).toEqual({
      explorer: 1,
      search: 1,
      sourceControl: 1,
      run: 1,
      ssh: 1,
    });
  });

  it('preserves hidden panel local state when switching away and back', async () => {
    const wrapper = await mountSidebar('search');
    const searchInput = wrapper.find<HTMLInputElement>('[data-testid="search-query"]');
    await searchInput.setValue('error handling');

    await wrapper.setProps({ view: 'explorer' });
    await nextTick();
    expectOnlyPanelVisible(wrapper, 'explorer');

    await wrapper.setProps({ view: 'search' });
    await nextTick();
    expectOnlyPanelVisible(wrapper, 'search');

    expect(wrapper.find<HTMLInputElement>('[data-testid="search-query"]').element.value).toBe(
      'error handling',
    );
    expect(panelMounts.search).toBe(1);
  });
});

import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineComponent } from 'vue';
import AiWorkspaceSurface from '@/components/business/ai/shell/AiWorkspaceSurface.vue';

const createDocument = () => ({
  id: 'doc-1',
  path: 'src/app.ts',
  name: 'app.ts',
  kind: 'text' as const,
  content: 'const ready = true;',
  encoding: 'utf-8',
  savedContent: 'const ready = true;',
  savedEncoding: 'utf-8',
  isDirty: false,
  lineCount: 1,
  charCount: 19,
});

const createAnalysis = () => ({
  available: true,
  message: null,
  dialect: 'typescript',
  diagnostics: [],
});

const createGitStatus = () => ({
  available: false,
  message: null,
  repositoryRootPath: null,
  repositoryName: null,
  gitDirPath: null,
  headBranchName: null,
  headShortName: null,
  headShortOid: null,
  isDetached: false,
  isClean: true,
  ahead: 0,
  behind: 0,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  conflictedCount: 0,
  files: [],
  lastCommit: null,
});

const mountSurface = () =>
  mount(AiWorkspaceSurface, {
    props: {
      document: createDocument(),
      activeRun: null,
      analysis: createAnalysis(),
      selection: null,
      gitStatus: createGitStatus(),
      workspaceRootPath: 'd:/com.xiaojianc/my_desktop_app',
    },
    global: {
      stubs: {
        AiAssistantPanel: defineComponent({
          template:
            '<section class="ai-assistant-panel-stub"><header><slot name="header-actions-after" /></header></section>',
        }),
        AiWebPreviewSidebar: defineComponent({
          emits: ['close-sidebar'],
          template: '<section class="ai-web-preview-sidebar-stub">preview</section>',
        }),
      },
    },
  });

describe('AiWorkspaceSurface', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1200,
      writable: true,
    });
  });

  afterEach(() => {
    window.dispatchEvent(new MouseEvent('mouseup'));
  });

  it('opens the right sidebar with a 50% larger default width', async () => {
    const wrapper = mountSurface();

    await wrapper.get('[aria-label="展开右侧面板"]').trigger('click');

    expect(wrapper.get('.ai-workspace-right-sidebar').attributes('style')).toContain('width: 480px');
  });

  it('supports horizontal resizing of the right sidebar', async () => {
    const wrapper = mountSurface();

    await wrapper.get('[aria-label="展开右侧面板"]').trigger('click');
    await wrapper.get('[data-testid="ai-right-sidebar-resize-handle"]').trigger('mousedown', {
      button: 0,
      clientX: 720,
    });

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 560 }));
    await wrapper.vm.$nextTick();

    expect(wrapper.get('.ai-workspace-right-sidebar').attributes('style')).toContain('width: 640px');
  });
});

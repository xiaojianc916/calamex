import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { useGitStore } from '@/store/git';

import { useGitRepositoryStatusBootstrap } from './useGitRepositoryStatusBootstrap';

// git store 在实例化时会 import @/services/tauri；测试中以最小桩替身避免触达 Tauri 运行时。
// 实际的 refreshRepositoryStatus 通过 spy 接管，因此其内部不会真正调用该服务。
vi.mock('@/services/tauri', () => ({
  tauriService: {
    getGitRepositoryStatus: vi.fn(),
  },
}));

describe('useGitRepositoryStatusBootstrap', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('桌面端工作区变化时驱动 gitStore.refreshRepositoryStatus（与侧边栏解耦）', async () => {
    const gitStore = useGitStore();
    const refreshSpy = vi
      .spyOn(gitStore, 'refreshRepositoryStatus')
      .mockResolvedValue(gitStore.status);

    const isDesktopRuntime = ref(true);
    const workspaceRootPath = ref<string | null>(null);

    const scope = effectScope();
    scope.run(() => {
      useGitRepositoryStatusBootstrap(isDesktopRuntime, workspaceRootPath);
    });

    // immediate：无工作区时也会同步（传 null → store 内部 reset）。
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenLastCalledWith(null);

    // 打开工作区后立即刷新仓库状态，无需点击左侧 git 侧边栏。
    workspaceRootPath.value = 'D:/repo';
    await nextTick();
    expect(refreshSpy).toHaveBeenCalledTimes(2);
    expect(refreshSpy).toHaveBeenLastCalledWith('D:/repo');

    scope.stop();
  });

  it('浏览器预览（非桌面端）不触发仓库状态刷新', async () => {
    const gitStore = useGitStore();
    const refreshSpy = vi
      .spyOn(gitStore, 'refreshRepositoryStatus')
      .mockResolvedValue(gitStore.status);

    const isDesktopRuntime = ref(false);
    const workspaceRootPath = ref<string | null>('D:/repo');

    const scope = effectScope();
    scope.run(() => {
      useGitRepositoryStatusBootstrap(isDesktopRuntime, workspaceRootPath);
    });

    await nextTick();
    expect(refreshSpy).not.toHaveBeenCalled();

    workspaceRootPath.value = 'D:/another';
    await nextTick();
    expect(refreshSpy).not.toHaveBeenCalled();

    scope.stop();
  });

  it('桌面端运行时就绪后（false→true）刷新当前工作区状态', async () => {
    const gitStore = useGitStore();
    const refreshSpy = vi
      .spyOn(gitStore, 'refreshRepositoryStatus')
      .mockResolvedValue(gitStore.status);

    const isDesktopRuntime = ref(false);
    const workspaceRootPath = ref<string | null>('D:/repo');

    const scope = effectScope();
    scope.run(() => {
      useGitRepositoryStatusBootstrap(isDesktopRuntime, workspaceRootPath);
    });

    expect(refreshSpy).not.toHaveBeenCalled();

    isDesktopRuntime.value = true;
    await nextTick();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenLastCalledWith('D:/repo');

    scope.stop();
  });
});

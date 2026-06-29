import { type ComputedRef, type Ref, watch } from 'vue';
import { useGitStore } from '@/domains/git/state/git';

type TReactiveValue<T> = Ref<T> | ComputedRef<T>;

/**
 * 工作台层级 Git 仓库状态初始化。
 *
 * 打开工作区时即加载 Git 仓库状态，使其与左侧「源代码管理（git）」侧边栏是否激活
 * 完全解耦。这样标题栏右上角的 GitHub 登录控件（其仓库路径来源于
 * gitStore.status.repositoryRootPath）在工作区打开后即可立即使用，无需先点击左侧
 * git 侧边栏标签来触发仓库状态加载。
 *
 * - 仅在桌面端（Tauri）运行时执行；浏览器预览模式没有可用的 Git 运行时，跳过。
 * - 工作区为 null（未打开）时，gitStore.refreshRepositoryStatus 内部会重置为初始状态，
 *   从而清空右上角登录控件的认证态。
 */
export const useGitRepositoryStatusBootstrap = (
  isDesktopRuntime: TReactiveValue<boolean>,
  workspaceRootPath: TReactiveValue<string | null>,
): void => {
  const gitStore = useGitStore();

  watch(
    [isDesktopRuntime, workspaceRootPath],
    ([isDesktop, rootPath]) => {
      if (!isDesktop) {
        return;
      }

      void gitStore.refreshRepositoryStatus(rootPath ?? null);
    },
    { immediate: true },
  );
};

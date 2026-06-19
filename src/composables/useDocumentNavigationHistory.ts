import { ref } from 'vue';

/**
 * 文档导航历史（后退/前进栈）。
 *
 * 从 useShellWorkbenchView 抽取为独立 composable，提升可测试性。
 * 行为与原内联实现完全一致：
 * - 后退栈记录用户离开的文档 ID
 * - 后退时将当前文档压入前进栈
 * - 前进时将当前文档压入后退栈
 * - 新导航（非前进/后退触发的切换）清空前进栈
 * - 文档关闭时从两个栈中清理引用
 * - 栈有最大长度限制
 */
const MAX_HISTORY_SIZE = 120;

export const useDocumentNavigationHistory = () => {
  const backStack = ref<string[]>([]);
  const forwardStack = ref<string[]>([]);
  const isNavigating = ref(false);

  const canGoBack = (): boolean => backStack.value.length > 0;
  const canGoForward = (): boolean => forwardStack.value.length > 0;

  const getBackStack = () => backStack;
  const getForwardStack = () => forwardStack;

  /** 检查导航栈中是否有可用的目标（跳过已关闭的文档）。 */
  const pickNavigableFromStack = (
    stack: ReturnType<typeof backStack>,
    checkExists: (id: string) => boolean,
    currentId: string,
  ): string | null => {
    while (stack.value.length > 0) {
      const candidate = stack.value.pop();
      if (!candidate || candidate === currentId) {
        continue;
      }
      if (checkExists(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  /** 记录一次文档切换（非导航触发的）。 */
  const recordNavigation = (
    previousDocumentId: string | null,
    nextDocumentId: string,
    checkExists: (id: string) => boolean,
  ): void => {
    if (isNavigating.value) {
      isNavigating.value = false;
      return;
    }
    if (previousDocumentId && checkExists(previousDocumentId)) {
      backStack.value = [...backStack.value, previousDocumentId].slice(
        Math.max(0, backStack.value.length + 1 - MAX_HISTORY_SIZE),
      );
    }
    forwardStack.value = [];
  };

  /**
   * 执行后退/前进导航。
   * 返回目标文档 ID（或 null），调用方负责实际切换文档并随后调用 finishNavigation()。
   * 如果导航栈为空，返回 null（调用方可自行处理 adjacent fallback）。
   */
  const navigate = (
    direction: 'back' | 'forward',
    currentDocumentId: string,
    checkExists: (id: string) => boolean,
  ): string | null => {
    const sourceStack = direction === 'back' ? backStack : forwardStack;
    const targetStack = direction === 'back' ? forwardStack : backStack;

    const targetId = pickNavigableFromStack(sourceStack, checkExists, currentDocumentId);
    if (!targetId) {
      return null;
    }

    targetStack.value = [...targetStack.value, currentDocumentId].slice(
      Math.max(0, targetStack.value.length + 1 - MAX_HISTORY_SIZE),
    );

    isNavigating.value = true;
    return targetId;
  };

  /** 导航完成后的标志复位（在 activateDocument 之后调用）。 */
  const finishNavigation = (): void => {
    isNavigating.value = false;
  };

  /** 文档关闭时从两个栈中清理引用。 */
  const removeClosedDocument = (documentId: string): void => {
    backStack.value = backStack.value.filter((id) => id !== documentId);
    forwardStack.value = forwardStack.value.filter((id) => id !== documentId);
  };

  return {
    backStack,
    forwardStack,
    isNavigating,
    canGoBack,
    canGoForward,
    recordNavigation,
    navigate,
    finishNavigation,
    removeClosedDocument,
  };
};

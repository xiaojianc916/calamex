import { computed, onScopeDispose, watch } from 'vue';
import { setWindowBackground } from '@/services/ipc/window.service';
import { useAppStore } from '@/store/app';
import { applyResolvedThemeEffect } from '@/themes/runtime/effects';
import { resolveTheme } from '@/themes/runtime/manager';
import { readCssVarAsRgba } from '@/utils/color';
import { logger } from '@/utils/logger';

export const useTheme = () => {
  const appStore = useAppStore();
  let lastNativeBackground = '';

  const syncNativeWindowBackground = async (): Promise<void> => {
    try {
      const { r, g, b, a } = readCssVarAsRgba('--window-underlay-bg');
      const nextKey = `${r}:${g}:${b}:${a}`;
      if (nextKey === lastNativeBackground) {
        return;
      }

      lastNativeBackground = nextKey;
      await setWindowBackground({ r, g, b, a });
    } catch (err) {
      logger.warn({
        event: 'window.set_background.failed',
        err,
      });
    }
  };

  // appStore.settings 在 patchSettings/replaceSettings 时整体替换引用,
  // effectiveTheme 是计算后的字符串;两者用浅比较即可捕获变化,无需 deep 遍历。
  const stop = watch(
    () => [appStore.settings, appStore.effectiveTheme] as const,
    ([settings, effectiveTheme]) => {
      const resolved = resolveTheme(effectiveTheme);
      applyResolvedThemeEffect(settings, resolved.variant);
      void syncNativeWindowBackground();
    },
    { immediate: true, flush: 'post' },
  );

  onScopeDispose(stop);

  return {
    resolvedTheme: computed(() => resolveTheme(appStore.effectiveTheme)),
  };
};

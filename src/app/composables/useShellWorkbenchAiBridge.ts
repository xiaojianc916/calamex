import { ref } from 'vue';

export type TTitlebarExpose = {
  openCommandPalette: () => void;
};

export const useShellWorkbenchAiBridge = () => {
  const titlebarRef = ref<TTitlebarExpose | null>(null);

  const handleOpenCommandPalette = (): void => {
    titlebarRef.value?.openCommandPalette();
  };

  return {
    titlebarRef,
    handleOpenCommandPalette,
  };
};

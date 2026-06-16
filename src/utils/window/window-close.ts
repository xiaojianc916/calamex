type TWindowWithProgrammaticCloseFlag = Window & {
  __SH_EDITOR_ALLOW_WINDOW_CLOSE__?: boolean;
};

const PROGRAMMATIC_CLOSE_FLAG = '__SH_EDITOR_ALLOW_WINDOW_CLOSE__';

const getFlagWindow = (): TWindowWithProgrammaticCloseFlag | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  return window as TWindowWithProgrammaticCloseFlag;
};

export const allowNextProgrammaticWindowClose = (): void => {
  const flagWindow = getFlagWindow();
  if (!flagWindow) {
    return;
  }

  flagWindow[PROGRAMMATIC_CLOSE_FLAG] = true;
};

export const clearProgrammaticWindowCloseAllowance = (): void => {
  const flagWindow = getFlagWindow();
  if (!flagWindow) {
    return;
  }

  flagWindow[PROGRAMMATIC_CLOSE_FLAG] = false;
};

export const consumeProgrammaticWindowCloseAllowance = (): boolean => {
  const flagWindow = getFlagWindow();
  if (!flagWindow?.[PROGRAMMATIC_CLOSE_FLAG]) {
    return false;
  }

  flagWindow[PROGRAMMATIC_CLOSE_FLAG] = false;
  return true;
};

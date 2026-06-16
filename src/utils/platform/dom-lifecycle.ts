export type DomDisposable = () => void;

export const addDisposableEventListener = (
  target: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): DomDisposable => {
  let disposed = false;
  target.addEventListener(type, listener, options);

  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    target.removeEventListener(type, listener, options);
  };
};

export const requestDisposableAnimationFrame = (
  callback: FrameRequestCallback,
  targetWindow: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'> = window,
): DomDisposable => {
  let frameId: number | null = targetWindow.requestAnimationFrame((time) => {
    const scheduledFrameId = frameId;
    frameId = null;

    if (scheduledFrameId !== null) {
      callback(time);
    }
  });

  return () => {
    if (frameId === null) {
      return;
    }

    targetWindow.cancelAnimationFrame(frameId);
    frameId = null;
  };
};

export const requestDisposableTimeout = (
  callback: () => void,
  delayMs: number,
  targetWindow: Pick<Window, 'setTimeout' | 'clearTimeout'> = window,
): DomDisposable => {
  let timeoutId: number | null = targetWindow.setTimeout(() => {
    const scheduledTimeoutId = timeoutId;
    timeoutId = null;

    if (scheduledTimeoutId !== null) {
      callback();
    }
  }, delayMs);

  return () => {
    if (timeoutId === null) {
      return;
    }

    targetWindow.clearTimeout(timeoutId);
    timeoutId = null;
  };
};

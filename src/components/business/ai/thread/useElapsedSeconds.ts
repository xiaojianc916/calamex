import { onScopeDispose, type Ref, ref, watch } from 'vue';

/**
 * 计算并按秒滴答更新「自 startedAt 起的已用秒数」。
 *
 * 设计取向(对齐 Codex `codex-rs/tui` `status_indicator_widget`:运行态显示自本轮
 * 开始以来的已用时长,非运行态冻结):仅在 isActive 为真时启动 1s 周期重算,基于
 * 权威的 startedAt 时间戳(可跨重挂载恢复),停止时冻结在最后一次取值;effect scope
 * 销毁时清理定时器,避免泄漏。
 *
 * @param startedAt 取本轮起始时间(ISO-8601);为 null 或不可解析时已用秒数为 0。
 * @param isActive 是否处于计时(运行)态;为假时停止滴答并冻结。
 */
export const useElapsedSeconds = (
  startedAt: () => string | null,
  isActive: () => boolean,
): Ref<number> => {
  const elapsedSeconds = ref(0);
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const recompute = (): void => {
    const startedAtValue = startedAt();
    if (startedAtValue === null) {
      elapsedSeconds.value = 0;
      return;
    }

    const startedMs = Date.parse(startedAtValue);
    if (Number.isNaN(startedMs)) {
      elapsedSeconds.value = 0;
      return;
    }

    const deltaSeconds = Math.floor((Date.now() - startedMs) / 1000);
    elapsedSeconds.value = deltaSeconds > 0 ? deltaSeconds : 0;
  };

  const stopTicking = (): void => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const startTicking = (): void => {
    recompute();
    if (intervalId === null) {
      intervalId = setInterval(recompute, 1000);
    }
  };

  watch(
    [() => isActive(), () => startedAt()],
    ([active]) => {
      if (active) {
        startTicking();
      } else {
        stopTicking();
        recompute();
      }
    },
    { immediate: true },
  );

  onScopeDispose(stopTicking);

  return elapsedSeconds;
};

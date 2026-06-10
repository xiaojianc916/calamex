import { commands, type SetWindowBackgroundInput, type WindowStage } from '@/bindings/tauri';
import { callSpectaCommand } from '@/services/tauri.ipc-runtime';

export type TSetWindowBackgroundRequest = Omit<SetWindowBackgroundInput, 'label' | 'a'> &
  Partial<Pick<SetWindowBackgroundInput, 'a'>> & {
    readonly label?: string | null;
  };

export type TWindowStageRequest = {
  readonly stage: WindowStage;
};

const toWindowBackgroundInput = (input: TSetWindowBackgroundRequest): SetWindowBackgroundInput => ({
  label: input.label ?? null,
  r: input.r,
  g: input.g,
  b: input.b,
  a: input.a ?? 255,
});

export const setWindowBackground = (input: TSetWindowBackgroundRequest): Promise<void> => {
  const commandInput = toWindowBackgroundInput(input);
  return callSpectaCommand<void>(
    {
      command: 'set_window_background',
      guardHint: 'sync native window background',
      timeoutMs: 1_000,
      idempotent: true,
      audit: 'none',
      input: commandInput,
    },
    async ({ traceId }) => {
      await commands.setWindowBackground(commandInput, traceId);
    },
  );
};

export const applyWindowStage = (input: TWindowStageRequest): Promise<void> =>
  callSpectaCommand<void>(
    {
      command: 'apply_window_stage',
      guardHint: 'apply window stage',
      timeoutMs: 1_000,
      idempotent: true,
      audit: 'info',
      input: { stage: input.stage },
    },
    async () => {
      await commands.applyWindowStage(input.stage);
    },
  );

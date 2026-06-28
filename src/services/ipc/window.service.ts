import { commands, type SetWindowBackgroundInput, type WindowStage } from '@/bindings/tauri';
import { type ICommandMeta, runCommand } from '@/services/tauri/core/ipc-define';

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

/**
 * 窗口 Tauri 命令的声明式包装元数据表。语义与原手写 callSpectaCommand 逐字段对齐。
 */
const WINDOW_COMMAND_META = {
  setWindowBackground: {
    command: 'set_window_background',
    guardHint: 'sync native window background',
    timeoutMs: 1_000,
    idempotent: true,
    audit: 'none',
  },
  applyWindowStage: {
    command: 'apply_window_stage',
    guardHint: 'apply window stage',
    timeoutMs: 1_000,
    idempotent: true,
    audit: 'info',
  },
} satisfies Record<string, ICommandMeta>;

export const setWindowBackground = (input: TSetWindowBackgroundRequest): Promise<void> => {
  const commandInput = toWindowBackgroundInput(input);
  return runCommand(
    WINDOW_COMMAND_META.setWindowBackground,
    commandInput,
    undefined,
    async ({ traceId }) => {
      await commands.setWindowBackground(commandInput, traceId);
    },
  );
};

export const applyWindowStage = (input: TWindowStageRequest): Promise<void> =>
  runCommand(WINDOW_COMMAND_META.applyWindowStage, { stage: input.stage }, undefined, async () => {
    await commands.applyWindowStage(input.stage);
  });

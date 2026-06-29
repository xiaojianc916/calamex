import type { ComputedRef } from 'vue';
import { useMessage } from '@/composables/useMessage';
import {
  getTerminalRunOrchestrator,
  type TTerminalRunNotifier,
} from '@/domains/terminal/services/runOrchestrator';
import type { useEditorStore } from '@/store/editor';
import type { ITerminalRunCompletedPayload } from '@/types/terminal';

type TEditorStore = ReturnType<typeof useEditorStore>;

type TUseTerminalRunOptions = {
  canRun: ComputedRef<boolean>;
  editorStore: TEditorStore;
};

export const shouldKeepTerminalRunScopeAlive = (
  isRunning: boolean,
  currentRunId: string | null,
): boolean => isRunning || (currentRunId?.trim().length ?? 0) > 0;

export const useTerminalRun = ({ canRun, editorStore }: TUseTerminalRunOptions) => {
  const notifier = useMessage() as TTerminalRunNotifier;
  const orchestrator = getTerminalRunOrchestrator();

  orchestrator.bind({
    canRun,
    editorStore,
    notifier,
  });

  return {
    runScript: (): Promise<void> => orchestrator.runScript(),
    handleIntegratedTerminalRunCompleted: (payload: ITerminalRunCompletedPayload): void =>
      orchestrator.handleIntegratedTerminalRunCompleted(payload),
  };
};

export type TTerminalShadowCompareChannel = 'legacy' | 'shadow';

export interface ITerminalShadowCompareLane {
  startedAt: number | null;
  finishedAt: number | null;
  output: string;
  states: string[];
}

export interface ITerminalShadowCompareRun {
  runId: string;
  legacy: ITerminalShadowCompareLane;
  shadow: ITerminalShadowCompareLane;
}

const createLane = (): ITerminalShadowCompareLane => ({
  startedAt: null,
  finishedAt: null,
  output: '',
  states: [],
});

export const createTerminalShadowCompareStore = () => {
  const runs = new Map<string, ITerminalShadowCompareRun>();

  const ensureRun = (runId: string): ITerminalShadowCompareRun => {
    const existing = runs.get(runId);
    if (existing) return existing;

    const created: ITerminalShadowCompareRun = {
      runId,
      legacy: createLane(),
      shadow: createLane(),
    };
    runs.set(runId, created);
    return created;
  };

  return {
    runs,

    start(runId: string, channel: TTerminalShadowCompareChannel, startedAt: number): void {
      ensureRun(runId)[channel].startedAt = startedAt;
    },

    appendOutput(runId: string, channel: TTerminalShadowCompareChannel, output: string): void {
      ensureRun(runId)[channel].output += output;
    },

    pushState(runId: string, channel: TTerminalShadowCompareChannel, state: string): void {
      ensureRun(runId)[channel].states.push(state);
    },

    finish(runId: string, channel: TTerminalShadowCompareChannel, finishedAt: number): void {
      ensureRun(runId)[channel].finishedAt = finishedAt;
    },

    getComparison(runId: string) {
      const run = ensureRun(runId);
      return {
        runId,
        legacy: run.legacy,
        shadow: run.shadow,
        outputMatches: run.legacy.output === run.shadow.output,
        stateMatches: run.legacy.states.join('\n') === run.shadow.states.join('\n'),
        durationDelta:
          run.legacy.startedAt === null ||
          run.legacy.finishedAt === null ||
          run.shadow.startedAt === null ||
          run.shadow.finishedAt === null
            ? null
            : run.shadow.finishedAt -
              run.shadow.startedAt -
              (run.legacy.finishedAt - run.legacy.startedAt),
      };
    },

    reset(): void {
      runs.clear();
    },
  };
};

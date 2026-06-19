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

  const compareRun = (runId: string) => {
    const run = ensureRun(runId);
    const encoder = new TextEncoder();
    const legacyDuration =
      run.legacy.startedAt === null || run.legacy.finishedAt === null
        ? null
        : run.legacy.finishedAt - run.legacy.startedAt;
    const shadowDuration =
      run.shadow.startedAt === null || run.shadow.finishedAt === null
        ? null
        : run.shadow.finishedAt - run.shadow.startedAt;
    return {
      runId,
      outputEqual: run.legacy.output === run.shadow.output,
      byteDiff: encoder.encode(run.shadow.output).length - encoder.encode(run.legacy.output).length,
      durationDeltaMs:
        legacyDuration === null || shadowDuration === null ? 0 : shadowDuration - legacyDuration,
      stateSequenceEqual:
        run.legacy.states.length === run.shadow.states.length &&
        run.legacy.states.every((state, index) => state === run.shadow.states[index]),
    };
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

    complete(runId: string, channel: TTerminalShadowCompareChannel, finishedAt: number): void {
      ensureRun(runId)[channel].finishedAt = finishedAt;
    },

    compare(runId: string) {
      return compareRun(runId);
    },

    listComparisons() {
      return Array.from(runs.keys()).map((runId) => compareRun(runId));
    },

    reset(): void {
      runs.clear();
    },
  };
};

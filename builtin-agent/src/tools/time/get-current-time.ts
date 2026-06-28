import { createTool } from '@mastra/core/tools';

import {
  createTimeSnapshot,
  looseModelToolInputSchema,
  parseCurrentTimeInput,
  resolveTimezone,
  timeSnapshotSchema,
  type IMastraTimeToolContext,
} from './shared.js';

const getCurrentTimeDescription = [
  'Get current time in a timezone. If the user does not specify one, use the local timezone.',
  '',
  'Examples:',
  '  {}                              → current time in local timezone',
  '  { "timezone": "Asia/Shanghai" } → current time in Shanghai',
  '  { "timezone": "America/New_York" } → current time in New York',
].join('\n');

export const createGetCurrentTimeTool = (
  context: IMastraTimeToolContext,
): ReturnType<typeof createTool> =>
  createTool({
    id: 'get_current_time',
    description: getCurrentTimeDescription,
    inputSchema: looseModelToolInputSchema,
    outputSchema: timeSnapshotSchema,
    execute: async (inputData) => {
      const { timezone } = parseCurrentTimeInput(inputData);
      return createTimeSnapshot(context.currentZonedDateTime(resolveTimezone(timezone, context.localTimezone)));
    },
  });

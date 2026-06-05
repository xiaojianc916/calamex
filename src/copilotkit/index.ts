export { default as CopilotKitProvider } from './CopilotKitProvider.vue';
export type { ISidecarEventAdapter, ISidecarUiEvent } from './event-adapter';
export {
  convertSidecarUiEvent,
  createEventId,
  createRunErrorEvent,
  createRunFinishedEvent,
  createRunStartedEvent,
  createSidecarEventAdapter,
  createTerminalEvents,
  createTextMessageContentEvent,
  createTextMessageEndEvent,
  createTextMessageStartEvent,
  createToolCallArgsEvent,
  createToolCallEndEvent,
  createToolCallResultEvent,
  createToolCallStartEvent,
  defaultIdGenerator,
  toAguiMessage,
  toAguiMessages,
  toSidecarChatRequest,
} from './event-adapter';
export { SidecarAgent } from './sidecar-agent';
